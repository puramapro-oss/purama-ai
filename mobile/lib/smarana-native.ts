import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { isSmaranaUuid } from '../../shared/smarana';
import { SmaranaStore, SmaranaStorageError } from './smarana-store';

const KEY_SERVICE = 'purama.smarana.v1';
const HEX_KEY = /^[0-9a-f]{64}$/;
const keyOptions = {
  keychainService: KEY_SERVICE,
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let epoch = 0;
let active: SmaranaStore | null = null;
let opening: Promise<void> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = opening.then(work);
  opening = result.then(() => {}, () => {});
  return result;
}

/** Synchronous fence for auth transitions; closing the connection may await a transaction. */
export function invalidateSmaranaStore(): void {
  epoch += 1;
  active?.invalidate();
}

export function closeSmaranaStore(): Promise<void> {
  invalidateSmaranaStore();
  return serialize(async () => {
    const previous = active;
    active = null;
    await previous?.close();
  });
}

/**
 * Only call after the account's local access grant has been checked by the caller.
 * A separate encrypted database and device-only key belong to each authenticated
 * account. Opening another account fences all results of the preceding session.
 * SDK 54 / expo-sqlite 16 uses this single connection for every transaction.
 */
export function openSmaranaStore(ownerId: string): Promise<SmaranaStore> {
  if (!isSmaranaUuid(ownerId)) return Promise.reject(new SmaranaStorageError('invalid_input'));
  invalidateSmaranaStore();
  const currentEpoch = epoch;
  const isCurrent = () => currentEpoch === epoch;
  const assertCurrent = () => { if (!isCurrent()) throw new SmaranaStorageError('closed'); };

  return serialize(async () => {
    assertCurrent();
    const previous = active;
    active = null;
    await previous?.close();
    assertCurrent();
    let db: SQLite.SQLiteDatabase | null = null;
    try {
      if (!FileSystem.documentDirectory || !(await SecureStore.isAvailableAsync())) {
        throw new SmaranaStorageError('unavailable');
      }
      assertCurrent();
      // Documents/application data, never the operating system's evictable cache.
      const directory = `${FileSystem.documentDirectory}smarana`;
      const databaseName = `account-${ownerId}.db`;
      const databasePath = `${directory}/${databaseName}`;
      const keyName = `smarana.v1.${ownerId}`;
      const existing = await Promise.all([databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]
        .map(path => FileSystem.getInfoAsync(path)));
      assertCurrent();
      let key = await SecureStore.getItemAsync(keyName, keyOptions);
      assertCurrent();
      if (key !== null && !HEX_KEY.test(key)) throw new SmaranaStorageError('invalid_key');
      if (key === null && existing.some(info => info.exists)) throw new SmaranaStorageError('missing_key');
      if (key === null) {
        const bytes = await Crypto.getRandomBytesAsync(32);
        assertCurrent();
        if (bytes.length !== 32) throw new SmaranaStorageError('invalid_key');
        key = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        bytes.fill(0);
        if (!HEX_KEY.test(key)) throw new SmaranaStorageError('invalid_key');
        // Persist and read back before creating a file: a storage failure must not
        // strand a new database with a key that was never saved.
        await SecureStore.setItemAsync(keyName, key, keyOptions);
        assertCurrent();
        if (await SecureStore.getItemAsync(keyName, keyOptions) !== key) throw new SmaranaStorageError('invalid_key');
        assertCurrent();
      }
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
      assertCurrent();
      db = await SQLite.openDatabaseAsync(databaseName, { useNewConnection: true }, directory);
      assertCurrent();
      const cipher = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version');
      assertCurrent();
      // SQLite silently ignores unknown pragmas. PRAGMA key alone is never proof
      // of encryption, and Expo Go / an unrebuilt binary must fail closed here.
      if (!cipher || typeof cipher.cipher_version !== 'string' || !/^\d+\.\d+/.test(cipher.cipher_version)) {
        throw new SmaranaStorageError('cipher_unavailable');
      }
      // Raw SQLCipher key syntax. Only the validated 32-byte hexadecimal alphabet
      // reaches SQL; neither an account string nor a user password is interpolated.
      await db.execAsync(`PRAGMA key = "x'${key}'"`);
      key = '';
      assertCurrent();
      // Read an existing page before any schema/configuration writes. A wrong key
      // or an incompatible/corrupt database must never trigger delete/recreate.
      await db.getFirstAsync<{ count: number }>('SELECT count(*) AS count FROM sqlite_master');
      assertCurrent();
      const store = await SmaranaStore.open(db, {
        ownerId,
        newId: () => Crypto.randomUUID(),
        isCurrent,
      });
      if (!isCurrent()) {
        await store.close();
        throw new SmaranaStorageError('closed');
      }
      active = store;
      return store;
    } catch (error) {
      await db?.closeAsync().catch(() => {});
      if (error instanceof SmaranaStorageError) throw error;
      // Never expose an underlying error which could embed the PRAGMA key or SQL.
      throw new SmaranaStorageError('unlock_failed');
    }
  });
}
