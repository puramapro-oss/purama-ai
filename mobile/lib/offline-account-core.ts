import { isSmaranaUuid } from "../../shared/smarana";

export type OfflineAccount = {
  ownerId: string;
  verifiedAt: number;
  validUntil: number;
  autoSync: boolean;
};
export type OfflineAccountStorage = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
};
export const OFFLINE_ACCOUNT_LEASE_MS = 7 * 24 * 60 * 60 * 1000;
type StoredAccount = OfflineAccount & { lastSeenAt: number; revoked: boolean };

/** A bounded device permission; never a replacement for server authentication. */
export function createOfflineAccountLedger(storage: OfflineAccountStorage, now = Date.now) {
  let generation = 0;
  let selectedOwner: string | null | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const clock = () => {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || time > Number.MAX_SAFE_INTEGER - OFFLINE_ACCOUNT_LEASE_MS) {
      throw new Error("La date de cet appareil doit être vérifiée.");
    }
    return time;
  };
  const parse = (raw: string | null): StoredAccount | null => {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<StoredAccount>;
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const lastSeenAt = value.lastSeenAt ?? value.verifiedAt;
      if (!isSmaranaUuid(value.ownerId) || !Number.isSafeInteger(value.verifiedAt)
        || !Number.isSafeInteger(value.validUntil) || typeof value.autoSync !== "boolean"
        || value.verifiedAt! < 0 || !Number.isSafeInteger(lastSeenAt) || lastSeenAt! < value.verifiedAt!
        || (value.revoked !== undefined && typeof value.revoked !== "boolean")
        || value.validUntil! - value.verifiedAt! !== OFFLINE_ACCOUNT_LEASE_MS) return null;
      return { ownerId: value.ownerId, verifiedAt: value.verifiedAt!, validUntil: value.validUntil!, autoSync: value.autoSync,
        lastSeenAt: lastSeenAt!, revoked: value.revoked ?? false };
    } catch { return null; }
  };
  const publicAccount = (account: StoredAccount): OfflineAccount => ({ ownerId: account.ownerId,
    verifiedAt: account.verifiedAt, validUntil: account.validUntil, autoSync: account.autoSync });
  const validAt = (account: StoredAccount, time: number) => !account.revoked
    && time >= account.verifiedAt && time >= account.lastSeenAt && time < account.validUntil;
  const read = () => {
    const expected = generation;
    return serial(async () => {
      const account = parse(await storage.read());
      if (generation !== expected || !account || (selectedOwner !== undefined && selectedOwner !== account.ownerId)) return null;
      const time = clock();
      if (!validAt(account, time)) {
        if (!account.revoked) {
          // Retain the no-sync preference but permanently invalidate this grant.
          // An expiry/rollback already observed cannot be undone by rebooting.
          await storage.write(JSON.stringify({ ...account, revoked: true, lastSeenAt: Math.max(time, account.lastSeenAt) }));
          if (generation === expected) emit();
        }
        return null;
      }
      // This is an observed-time high-water mark, not a claim of a trusted clock
      // while the application is stopped or of immediate offline revocation.
      if (time > account.lastSeenAt) await storage.write(JSON.stringify({ ...account, lastSeenAt: time }));
      return generation === expected ? publicAccount(account) : null;
    });
  };
  const selectOwner = (ownerId: string | null) => {
    if (ownerId !== null && !isSmaranaUuid(ownerId)) return Promise.reject(new Error("Identité du compte invalide."));
    const mustRevoke = ownerId === null || (selectedOwner !== undefined && selectedOwner !== ownerId);
    selectedOwner = ownerId;
    const expected = ++generation;
    emit(); // Invalidate readers before asynchronous Keychain work.
    return serial(async () => {
      // This revocation was ordered before later verification writes in the
      // queue. Never skip it merely because another owner was selected meanwhile.
      if (mustRevoke) { await storage.remove(); return; }
      if (expected !== generation) return;
      const account = parse(await storage.read());
      if (account?.ownerId !== ownerId) await storage.remove();
    });
  };
  return {
    read,
    selectOwner,
    clear: () => selectOwner(null),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Obtain this ticket BEFORE the live getUser request, so sign-out defeats late verification. */
    verificationTicket() { return generation; },
    async rememberVerified(ownerId: string, ticket: number, signal?: AbortSignal): Promise<OfflineAccount> {
      if (!isSmaranaUuid(ownerId)) throw new Error("Identité du compte invalide.");
      return serial(async () => {
        if (signal?.aborted || generation !== ticket || (selectedOwner != null && selectedOwner !== ownerId)) {
          throw new Error("Le compte a changé ou la vérification a été annulée.");
        }
        const previous = parse(await storage.read());
        if (signal?.aborted || generation !== ticket) throw new Error("Le compte a changé ou la vérification a été annulée.");
        const verifiedAt = clock();
        const account: StoredAccount = { ownerId, verifiedAt, validUntil: verifiedAt + OFFLINE_ACCOUNT_LEASE_MS,
          autoSync: previous?.ownerId === ownerId ? previous.autoSync : true, lastSeenAt: verifiedAt, revoked: false };
        await storage.write(JSON.stringify(account));
        if (signal?.aborted || generation !== ticket) {
          // No later ledger write can have run yet: removing this superseded
          // grant here cannot delete a subsequent account's verified grant.
          await storage.remove();
          throw new Error("Le compte a changé ou la vérification a été annulée.");
        }
        selectedOwner = ownerId;
        emit();
        return publicAccount(account);
      });
    },
    async setAutoSync(ownerId: string, allowed: boolean): Promise<OfflineAccount> {
      if (!isSmaranaUuid(ownerId) || typeof allowed !== "boolean") throw new Error("Autorisation de synchronisation invalide.");
      const expected = generation;
      return serial(async () => {
        const account = parse(await storage.read());
        const time = clock();
        if (expected !== generation || account?.ownerId !== ownerId
          || !validAt(account, time) || (selectedOwner !== undefined && selectedOwner !== ownerId)) throw new Error("Le compte doit être vérifié à nouveau.");
        const next = { ...account, autoSync: allowed, lastSeenAt: time };
        await storage.write(JSON.stringify(next));
        if (expected !== generation) { await storage.remove(); throw new Error("Le compte a changé."); }
        emit();
        return publicAccount(next);
      });
    },
  };
}
