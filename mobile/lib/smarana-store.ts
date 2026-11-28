import {
  compareSmaranaCursors,
  isSmaranaCursor,
  isSmaranaUuid,
  parseSmaranaApplyResult,
  parseSmaranaMutation,
  parseSmaranaPullResult,
  parseSmaranaRecord,
  parseSmaranaSnapshot,
  type SmaranaApplyResult,
  type SmaranaConversationSnapshot,
  type SmaranaMutation,
  type SmaranaPullResult,
  type SmaranaRemoteRecord,
} from '../../shared/smarana';

/** One already-unlocked connection. The native factory verifies SQLCipher before supplying it. */
export interface SmaranaDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<{ changes: number }>;
  getFirstAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
  closeAsync(): Promise<void>;
}

export type SmaranaLocalRecord = {
  ownerId: string;
  resourceId: string;
  localVersion: number;
  serverRevision: number;
  tombstone: boolean;
  payload: SmaranaConversationSnapshot | null;
  updatedAt: string;
  syncState: 'pending' | 'synced' | 'conflict';
};
export type SmaranaConversationSummary = {
  resourceId: string;
  title: string;
  updatedAt: string;
  localVersion: number;
  serverRevision: number;
  syncState: SmaranaLocalRecord['syncState'];
};
export type SmaranaHistoryCursor = Readonly<{ updatedAt: string; resourceId: string }>;
export type SmaranaHistoryPage = { records: SmaranaConversationSummary[]; nextCursor: SmaranaHistoryCursor | null };
export type SmaranaStoredConflict = {
  resourceId: string;
  reason: 'revision' | 'deleted' | 'mutation_reused';
  mutationId: string | null;
  remote: SmaranaRemoteRecord | null;
  receivedAt: string;
};
export type SmaranaStorageErrorCode =
  | 'closed' | 'owner_mismatch' | 'missing' | 'exists' | 'local_conflict' | 'deleted'
  | 'invalid_ack' | 'stale_pull' | 'corrupt' | 'unsupported_schema' | 'invalid_input'
  | 'conflict_unavailable'
  | 'unavailable' | 'missing_key' | 'invalid_key' | 'cipher_unavailable' | 'unlock_failed';

/** No SQL, key, prompt or database contents are included in these errors. */
export class SmaranaStorageError extends Error {
  constructor(public readonly code: SmaranaStorageErrorCode) {
    super(`Mémoire locale indisponible (${code}).`);
    this.name = 'SmaranaStorageError';
  }
}

type StoreOptions = {
  ownerId: string;
  newId: () => string;
  now?: () => string;
  isCurrent?: () => boolean;
};
type ConversationRow = {
  resource_id: string;
  title: string;
  local_version: number;
  server_revision: number;
  tombstone: number;
  payload: string | null;
  updated_at: string;
  sync_state: SmaranaLocalRecord['syncState'];
  local_pending_ids: string;
};
type QueueRow = {
  seq: number;
  mutation_id: string;
  resource_id: string;
  local_version: number;
  base_revision: number;
  tombstone: number;
  payload: string | null;
  dispatched: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS smarana_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS smarana_conversations (
  resource_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  local_version INTEGER NOT NULL CHECK (local_version > 0),
  server_revision INTEGER NOT NULL CHECK (server_revision >= 0),
  tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
  payload TEXT,
  updated_at TEXT NOT NULL,
  sync_state TEXT NOT NULL CHECK (sync_state IN ('pending', 'synced', 'conflict')),
  local_pending_ids TEXT NOT NULL DEFAULT '[]',
  CHECK ((tombstone = 1 AND payload IS NULL) OR (tombstone = 0 AND payload IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS smarana_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  resource_id TEXT NOT NULL REFERENCES smarana_conversations(resource_id),
  local_version INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
  payload TEXT,
  dispatched INTEGER NOT NULL DEFAULT 0 CHECK (dispatched IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS smarana_outbox_one_dispatched
  ON smarana_outbox(resource_id) WHERE dispatched = 1;
CREATE INDEX IF NOT EXISTS smarana_outbox_resource ON smarana_outbox(resource_id, seq);
CREATE TABLE IF NOT EXISTS smarana_conflicts (
  conflict_key TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES smarana_conversations(resource_id),
  reason TEXT NOT NULL,
  mutation_id TEXT,
  remote_record TEXT,
  received_at TEXT NOT NULL
);
`;

function requiredUuid(value: string): string {
  if (!isSmaranaUuid(value)) throw new SmaranaStorageError('invalid_input');
  return value;
}
function expectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new SmaranaStorageError('invalid_input');
}
function nextVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new SmaranaStorageError('corrupt');
  return value + 1;
}
function decodeSnapshot(value: string | null): SmaranaConversationSnapshot | null {
  if (value === null) return null;
  try { return parseSmaranaSnapshot(JSON.parse(value)); }
  catch { throw new SmaranaStorageError('corrupt'); }
}
function pendingIds(row: ConversationRow): string[] {
  try {
    const ids: unknown = JSON.parse(row.local_pending_ids);
    if (!Array.isArray(ids) || ids.some(id => !isSmaranaUuid(id))) throw new Error();
    return ids;
  } catch { throw new SmaranaStorageError('corrupt'); }
}

/**
 * The local SMARANA replica, not a second conversation history.
 * Every operation (including reads) is serialized on the same keyed connection.
 * Never replace this transaction implementation with withExclusiveTransactionAsync:
 * Expo opens a second connection there, which would not have this connection's key.
 */
export class SmaranaStore {
  readonly ownerId: string;
  #db: SmaranaDatabase;
  #options: StoreOptions;
  #tail: Promise<void> = Promise.resolve();
  #invalidated = false;
  #closing: Promise<void> | null = null;

  private constructor(db: SmaranaDatabase, options: StoreOptions) {
    this.#db = db;
    this.#options = options;
    this.ownerId = requiredUuid(options.ownerId);
  }

  static async open(db: SmaranaDatabase, options: StoreOptions): Promise<SmaranaStore> {
    const store = new SmaranaStore(db, options);
    try {
      await store.#serial(async () => {
        const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
        if (!version || ![0, 1, 2].includes(version.user_version)) {
          throw new SmaranaStorageError('unsupported_schema');
        }
        store.#assertCurrent();
        await db.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;');
        await store.#transaction(async () => {
          await db.execAsync(SCHEMA);
          const owner = await db.getFirstAsync<{ value: string }>("SELECT value FROM smarana_meta WHERE key = 'owner_id'");
          if (owner && owner.value !== store.ownerId) throw new SmaranaStorageError('owner_mismatch');
          const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(smarana_conversations)');
          if (!columns.some(column => column.name === 'title')) {
            if (version.user_version === 2) throw new SmaranaStorageError('corrupt');
            await db.execAsync("ALTER TABLE smarana_conversations ADD COLUMN title TEXT NOT NULL DEFAULT '';");
            // One-time v1 migration inside the same transaction. History listing
            // never parses or transfers conversation payloads after this step.
            await db.execAsync("UPDATE smarana_conversations SET title = COALESCE(json_extract(payload, '$.title'), '') WHERE tombstone = 0;");
          }
          // Cover the entire metadata query so SQLite need not visit large
          // payload overflow pages merely to display a page of conversation names.
          await db.execAsync(`CREATE INDEX IF NOT EXISTS smarana_history_summary ON smarana_conversations
            (tombstone, updated_at DESC, resource_id ASC, local_version, server_revision, sync_state, title);`);
          await db.runAsync("INSERT OR IGNORE INTO smarana_meta(key, value) VALUES ('owner_id', ?)", store.ownerId);
          await db.runAsync("INSERT OR IGNORE INTO smarana_meta(key, value) VALUES ('pull_cursor', '0')");
          await db.execAsync('PRAGMA user_version = 2');
          await store.#recoverInterrupted();
        });
      });
      return store;
    } catch (error) {
      await store.close().catch(() => {});
      throw error;
    }
  }

  /** Fence synchronously before awaiting cancellation, network work or close. */
  invalidate(): void { this.#invalidated = true; }

  close(): Promise<void> {
    this.invalidate();
    if (!this.#closing) this.#closing = this.#tail.then(() => this.#db.closeAsync());
    return this.#closing;
  }

  #assertCurrent(): void {
    if (this.#invalidated || this.#options.isCurrent?.() === false) throw new SmaranaStorageError('closed');
  }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      this.#assertCurrent();
      const value = await work();
      this.#assertCurrent();
      return value;
    });
    this.#tail = result.then(() => {}, () => {});
    return result;
  }
  async #transaction<T>(work: () => Promise<T>): Promise<T> {
    this.#assertCurrent();
    await this.#db.execAsync('BEGIN IMMEDIATE');
    try {
      this.#assertCurrent();
      const result = await work();
      this.#assertCurrent();
      await this.#db.execAsync('COMMIT');
      return result;
    } catch (error) {
      await this.#db.execAsync('ROLLBACK').catch(() => {});
      throw error;
    }
  }
  #time(): string {
    const time = this.#options.now?.() ?? new Date().toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time)
      || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time) {
      throw new SmaranaStorageError('invalid_input');
    }
    return time;
  }
  #id(): string { return requiredUuid(this.#options.newId()); }
  #record(row: ConversationRow): SmaranaLocalRecord {
    const payload = decodeSnapshot(row.payload);
    if ((row.tombstone === 1) !== (payload === null)) throw new SmaranaStorageError('corrupt');
    return {
      ownerId: this.ownerId, resourceId: row.resource_id, localVersion: row.local_version,
      serverRevision: row.server_revision, tombstone: row.tombstone === 1,
      payload, updatedAt: row.updated_at, syncState: row.sync_state,
    };
  }
  async #row(resourceId: string): Promise<ConversationRow | null> {
    return this.#db.getFirstAsync<ConversationRow>('SELECT * FROM smarana_conversations WHERE resource_id = ?', resourceId);
  }
  async #requiredRow(resourceId: string, version: number): Promise<ConversationRow> {
    const row = await this.#row(resourceId);
    if (!row) throw new SmaranaStorageError('missing');
    if (row.local_version !== version) throw new SmaranaStorageError('local_conflict');
    return row;
  }

  list(options: { includeDeleted?: boolean; limit?: number } = {}): Promise<SmaranaLocalRecord[]> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new SmaranaStorageError('invalid_input');
    const includeDeleted = options.includeDeleted === true;
    return this.#serial(async () => (await this.#db.getAllAsync<ConversationRow>(
      `SELECT * FROM smarana_conversations ${includeDeleted ? '' : 'WHERE tombstone = 0'} ORDER BY updated_at DESC, resource_id LIMIT ?`, limit,
    )).map(row => this.#record(row)));
  }

  /** Keyset pagination over the covering metadata index; no payload column or JSON parsing. */
  listPage(options: { cursor?: SmaranaHistoryCursor | null; limit?: number } = {}): Promise<SmaranaHistoryPage> {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new SmaranaStorageError('invalid_input');
    const cursor = options.cursor ? { updatedAt: options.cursor.updatedAt, resourceId: options.cursor.resourceId } : null;
    if (cursor && (!isSmaranaUuid(cursor.resourceId) || typeof cursor.updatedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.updatedAt)
      || !Number.isFinite(Date.parse(cursor.updatedAt)) || new Date(cursor.updatedAt).toISOString() !== cursor.updatedAt)) {
      throw new SmaranaStorageError('invalid_input');
    }
    return this.#serial(async () => {
      const rows = await this.#db.getAllAsync<Pick<ConversationRow,
        'resource_id' | 'title' | 'updated_at' | 'local_version' | 'server_revision' | 'sync_state'>>(
        `SELECT resource_id, title, updated_at, local_version, server_revision, sync_state FROM smarana_conversations
          WHERE tombstone = 0 ${cursor ? 'AND (updated_at < ? OR (updated_at = ? AND resource_id > ?))' : ''}
          ORDER BY updated_at DESC, resource_id ASC LIMIT ?`,
        ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.resourceId, limit + 1] : [limit + 1]),
      );
      const records = rows.slice(0, limit).map(row => ({ resourceId: row.resource_id, title: row.title,
        updatedAt: row.updated_at, localVersion: row.local_version, serverRevision: row.server_revision, syncState: row.sync_state }));
      const last = records.at(-1);
      return { records, nextCursor: rows.length > limit && last ? { updatedAt: last.updatedAt, resourceId: last.resourceId } : null };
    });
  }

  read(resourceId: string): Promise<SmaranaLocalRecord | null> {
    requiredUuid(resourceId);
    return this.#serial(async () => {
      const row = await this.#row(resourceId);
      return row ? this.#record(row) : null;
    });
  }

  create(payload: SmaranaConversationSnapshot, resourceId: string = this.#id()): Promise<SmaranaLocalRecord> {
    requiredUuid(resourceId);
    const snapshot = parseSmaranaSnapshot(payload);
    return this.#serial(() => this.#transaction(() => this.#insertSnapshot(snapshot, resourceId)));
  }

  async #insertSnapshot(snapshot: SmaranaConversationSnapshot, resourceId: string = this.#id()): Promise<SmaranaLocalRecord> {
    if (await this.#row(resourceId)) throw new SmaranaStorageError('exists');
    const time = this.#time();
    const localPending = snapshot.messages.filter(message => message.role === 'assistant' && message.state === 'pending').map(message => message.id);
    await this.#db.runAsync(`INSERT INTO smarana_conversations
      (resource_id, title, local_version, server_revision, tombstone, payload, updated_at, sync_state, local_pending_ids)
      VALUES (?, ?, 1, 0, 0, ?, ?, 'pending', ?)`, resourceId, snapshot.title, JSON.stringify(snapshot), time, JSON.stringify(localPending));
    const row = (await this.#row(resourceId))!;
    await this.#queue(row);
    return this.#record(row);
  }

  update(resourceId: string, localVersion: number, payload: SmaranaConversationSnapshot): Promise<SmaranaLocalRecord> {
    requiredUuid(resourceId);
    expectedVersion(localVersion);
    const snapshot = parseSmaranaSnapshot(payload);
    return this.#serial(() => this.#transaction(async () => {
      const row = await this.#requiredRow(resourceId, localVersion);
      if (row.tombstone) throw new SmaranaStorageError('deleted');
      return this.#record(await this.#writeSnapshot(row, snapshot));
    }));
  }

  async #writeSnapshot(row: ConversationRow, snapshot: SmaranaConversationSnapshot): Promise<ConversationRow> {
    const json = JSON.stringify(snapshot);
    if (row.payload === json) return row;
    const previous = decodeSnapshot(row.payload);
    const wasPending = new Set(previous?.messages.filter(message => message.state === 'pending').map(message => message.id));
    const ownedPending = new Set(pendingIds(row));
    const localPending = snapshot.messages.filter(message => message.role === 'assistant' && message.state === 'pending'
      && (ownedPending.has(message.id) || !wasPending.has(message.id))).map(message => message.id);
    const updated: ConversationRow = {
      ...row, title: snapshot.title, local_version: nextVersion(row.local_version), payload: json, updated_at: this.#time(),
      sync_state: row.sync_state === 'conflict' ? 'conflict' : 'pending', local_pending_ids: JSON.stringify(localPending),
    };
    await this.#db.runAsync(`UPDATE smarana_conversations SET local_version = ?, title = ?, payload = ?, updated_at = ?,
      sync_state = ?, local_pending_ids = ? WHERE resource_id = ?`, updated.local_version, updated.title, updated.payload,
    updated.updated_at, updated.sync_state, updated.local_pending_ids, row.resource_id);
    await this.#queue(updated);
    return updated;
  }

  tombstone(resourceId: string, localVersion: number): Promise<SmaranaLocalRecord> {
    requiredUuid(resourceId);
    expectedVersion(localVersion);
    return this.#serial(() => this.#transaction(async () => {
      const row = await this.#requiredRow(resourceId, localVersion);
      if (row.tombstone) return this.#record(row);
      const updated: ConversationRow = {
        ...row, title: '', local_version: nextVersion(row.local_version), tombstone: 1, payload: null,
        local_pending_ids: '[]', updated_at: this.#time(),
        sync_state: row.sync_state === 'conflict' ? 'conflict' : 'pending',
      };
      await this.#db.runAsync(`UPDATE smarana_conversations SET local_version = ?, title = '', tombstone = 1, payload = NULL,
        local_pending_ids = '[]', updated_at = ?, sync_state = ? WHERE resource_id = ?`,
      updated.local_version, updated.updated_at, updated.sync_state, resourceId);
      // A never-uploaded creation becomes a baseRevision=0 terminal marker;
      // its discarded text is never uploaded merely to establish the resource.
      await this.#queue(updated);
      return this.#record(updated);
    }));
  }

  async #queue(row: ConversationRow): Promise<void> {
    // Dispatched operations remain byte-for-byte immutable through timeout/retry.
    // Only a snapshot never handed to the transport may be coalesced.
    await this.#db.runAsync('DELETE FROM smarana_outbox WHERE resource_id = ? AND dispatched = 0', row.resource_id);
    await this.#db.runAsync(`INSERT INTO smarana_outbox
      (mutation_id, resource_id, local_version, base_revision, tombstone, payload, dispatched)
      VALUES (?, ?, ?, ?, ?, ?, 0)`, this.#id(), row.resource_id, row.local_version, row.server_revision, row.tombstone, row.payload);
  }

  #mutation(row: QueueRow): SmaranaMutation {
    return parseSmaranaMutation({ schemaVersion: 1, ownerId: this.ownerId, resourceId: row.resource_id,
      mutationId: row.mutation_id, baseRevision: row.base_revision, tombstone: row.tombstone === 1,
      payload: decodeSnapshot(row.payload) });
  }

  /** Status inspection must never freeze an unsent snapshot as dispatched. */
  hasPending(): Promise<boolean> {
    return this.#serial(async () => Boolean(await this.#db.getFirstAsync<{ pending: number }>(
      `SELECT 1 AS pending FROM smarana_outbox o
        JOIN smarana_conversations c ON c.resource_id = o.resource_id
        WHERE c.sync_state != 'conflict' LIMIT 1`,
    )));
  }

  /** Persist dispatch before returning. Retry returns the identical operation. */
  pending(limit = 20): Promise<SmaranaMutation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new SmaranaStorageError('invalid_input');
    return this.#serial(() => this.#transaction(async () => {
      const rows = await this.#db.getAllAsync<QueueRow>(`SELECT o.* FROM smarana_outbox o
        JOIN smarana_conversations c ON c.resource_id = o.resource_id
        WHERE c.sync_state != 'conflict' AND o.seq = (
          SELECT MIN(first.seq) FROM smarana_outbox first WHERE first.resource_id = o.resource_id
        ) ORDER BY o.seq LIMIT ?`, limit);
      for (const row of rows) await this.#db.runAsync('UPDATE smarana_outbox SET dispatched = 1 WHERE seq = ?', row.seq);
      return rows.map(row => this.#mutation(row));
    }));
  }

  /** False means an old/unknown receipt; it never acknowledges some other version. */
  acknowledge(value: SmaranaApplyResult): Promise<boolean> {
    const result = parseSmaranaApplyResult(value);
    if (result.ownerId !== this.ownerId) throw new SmaranaStorageError('owner_mismatch');
    return this.#serial(() => this.#transaction(async () => {
      const sent = await this.#db.getFirstAsync<QueueRow>('SELECT * FROM smarana_outbox WHERE mutation_id = ?', result.mutationId);
      if (!sent) return false;
      if (!sent.dispatched || sent.resource_id !== result.resourceId || sent.base_revision !== result.baseRevision) {
        throw new SmaranaStorageError('invalid_ack');
      }
      const row = (await this.#row(sent.resource_id))!;
      if (result.status === 'conflict') {
        await this.#saveConflict(row, result.reason, result.current, result.mutationId);
        return true;
      }
      if (result.revision <= row.server_revision) throw new SmaranaStorageError('invalid_ack');
      await this.#db.runAsync('DELETE FROM smarana_outbox WHERE mutation_id = ?', sent.mutation_id);
      // These successors have never been dispatched, so their base can be moved
      // to the exact accepted predecessor without altering an in-flight request.
      await this.#db.runAsync('UPDATE smarana_outbox SET base_revision = ? WHERE resource_id = ? AND dispatched = 0',
        result.revision, sent.resource_id);
      const remaining = await this.#db.getFirstAsync<{ count: number }>(
        'SELECT COUNT(*) AS count FROM smarana_outbox WHERE resource_id = ?', sent.resource_id,
      );
      const isCurrent = row.local_version === sent.local_version && row.payload === sent.payload && row.tombstone === sent.tombstone;
      const state = row.sync_state === 'conflict' ? 'conflict' : !remaining?.count && isCurrent ? 'synced' : 'pending';
      await this.#db.runAsync('UPDATE smarana_conversations SET server_revision = ?, sync_state = ? WHERE resource_id = ?',
        result.revision, state, sent.resource_id);
      return true;
    }));
  }

  cursor(): Promise<string> {
    return this.#serial(() => this.#cursor());
  }
  async #cursor(): Promise<string> {
    const row = await this.#db.getFirstAsync<{ value: string }>("SELECT value FROM smarana_meta WHERE key = 'pull_cursor'");
    if (!row || !isSmaranaCursor(row.value)) throw new SmaranaStorageError('corrupt');
    return row.value;
  }

  /** The page and its cursor commit together. A stale request cannot skip updates. */
  ingestPull(value: SmaranaPullResult, expectedCursor: string): Promise<void> {
    const page = parseSmaranaPullResult(value);
    if (page.ownerId !== this.ownerId) throw new SmaranaStorageError('owner_mismatch');
    if (!isSmaranaCursor(expectedCursor)) throw new SmaranaStorageError('invalid_input');
    return this.#serial(() => this.#transaction(async () => {
      const current = await this.#cursor();
      if (current !== expectedCursor || compareSmaranaCursors(page.cursor, current) < 0
        || page.records.some(record => compareSmaranaCursors(record.cursor, current) <= 0)) {
        throw new SmaranaStorageError('stale_pull');
      }
      for (const record of page.records) await this.#ingest(record);
      await this.#db.runAsync("UPDATE smarana_meta SET value = ? WHERE key = 'pull_cursor'", page.cursor);
    }));
  }

  async #ingest(remote: SmaranaRemoteRecord): Promise<void> {
    const row = await this.#row(remote.resourceId);
    const payload = remote.payload === null ? null : JSON.stringify(remote.payload);
    if (!row) {
      await this.#db.runAsync(`INSERT INTO smarana_conversations
        (resource_id, title, local_version, server_revision, tombstone, payload, updated_at, sync_state, local_pending_ids)
        VALUES (?, ?, 1, ?, ?, ?, ?, 'synced', '[]')`, remote.resourceId, remote.payload?.title ?? '', remote.revision,
      Number(remote.tombstone), payload, remote.updatedAt);
      return;
    }
    if (remote.revision <= row.server_revision) return;
    const queued = await this.#db.getFirstAsync<QueueRow>(
      'SELECT * FROM smarana_outbox WHERE resource_id = ? ORDER BY seq LIMIT 1', remote.resourceId,
    );
    // An acknowledged-by-pull predecessor may be a creation followed by a local
    // deletion. It must not turn that correctly queued deletion into a conflict.
    if (queued?.dispatched && remote.revision === queued.base_revision + 1
      && payload === queued.payload && Number(remote.tombstone) === queued.tombstone) return;
    if (row.tombstone && !remote.tombstone) {
      await this.#saveConflict(row, 'deleted', remote, null);
      return;
    }
    if (queued || row.sync_state === 'conflict') {
      await this.#saveConflict(row, remote.tombstone ? 'deleted' : 'revision', remote, null);
      return;
    }
    await this.#db.runAsync(`UPDATE smarana_conversations SET local_version = ?, title = ?, server_revision = ?, tombstone = ?,
      payload = ?, updated_at = ?, sync_state = 'synced', local_pending_ids = '[]' WHERE resource_id = ?`,
    nextVersion(row.local_version), remote.payload?.title ?? '', remote.revision, Number(remote.tombstone), payload, remote.updatedAt, remote.resourceId);
  }

  async #saveConflict(row: ConversationRow, reason: SmaranaStoredConflict['reason'], remote: SmaranaRemoteRecord | null, mutationId: string | null): Promise<void> {
    const key = `${row.resource_id}:${remote?.revision ?? 'none'}:${reason}:${mutationId ?? 'pull'}`;
    const inserted = await this.#db.runAsync(`INSERT OR IGNORE INTO smarana_conflicts
      (conflict_key, resource_id, reason, mutation_id, remote_record, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
    key, row.resource_id, reason, mutationId, remote ? JSON.stringify(remote) : null, this.#time());
    if (inserted.changes || row.sync_state !== 'conflict') {
      // A newly received conflict invalidates a resolution dialog's old CAS,
      // even if the locally edited text itself has not changed.
      await this.#db.runAsync("UPDATE smarana_conversations SET sync_state = 'conflict', local_version = ? WHERE resource_id = ?",
        nextVersion(row.local_version), row.resource_id);
    }
  }

  conflicts(resourceId?: string): Promise<SmaranaStoredConflict[]> {
    if (resourceId !== undefined) requiredUuid(resourceId);
    return this.#serial(async () => {
      const rows = await this.#db.getAllAsync<{
        resource_id: string; reason: SmaranaStoredConflict['reason']; mutation_id: string | null;
        remote_record: string | null; received_at: string;
      }>(`SELECT * FROM smarana_conflicts ${resourceId ? 'WHERE resource_id = ?' : ''} ORDER BY received_at, conflict_key`,
      ...(resourceId ? [resourceId] : []));
      return rows.map(row => ({ resourceId: row.resource_id, reason: row.reason, mutationId: row.mutation_id,
        remote: row.remote_record ? parseSmaranaRecord(JSON.parse(row.remote_record)) : null, receivedAt: row.received_at }));
    });
  }

  /** Explicit user choice only. The copy and original resolution are atomic. */
  resolveConflict(resourceId: string, localVersion: number, choice: 'remote' | 'keep-both'):
    Promise<{ record: SmaranaLocalRecord; preserved: SmaranaLocalRecord | null }> {
    requiredUuid(resourceId);
    expectedVersion(localVersion);
    if (choice !== 'remote' && choice !== 'keep-both') throw new SmaranaStorageError('invalid_input');
    return this.#serial(() => this.#transaction(async () => {
      const row = await this.#requiredRow(resourceId, localVersion);
      if (row.sync_state !== 'conflict') throw new SmaranaStorageError('conflict_unavailable');
      const conflicts = await this.#db.getAllAsync<{ remote_record: string | null }>(
        'SELECT remote_record FROM smarana_conflicts WHERE resource_id = ?', resourceId,
      );
      let remote: SmaranaRemoteRecord | null = null;
      for (const conflict of conflicts) {
        if (!conflict.remote_record) continue;
        const candidate = parseSmaranaRecord(JSON.parse(conflict.remote_record));
        if (candidate.ownerId !== this.ownerId || candidate.resourceId !== resourceId) throw new SmaranaStorageError('corrupt');
        if (!remote || candidate.revision > remote.revision) remote = candidate;
        else if (candidate.revision === remote.revision && JSON.stringify(candidate) !== JSON.stringify(remote)) {
          throw new SmaranaStorageError('corrupt');
        }
      }
      if (!remote || remote.revision < row.server_revision) throw new SmaranaStorageError('conflict_unavailable');
      // A terminal local identifier must not be resurrected, even by a stale peer.
      // Accepting "remote" must not silently mean deleting that remote version.
      if (row.tombstone && !remote.tombstone && choice === 'remote') throw new SmaranaStorageError('deleted');
      let preserved: SmaranaLocalRecord | null = null;
      if (choice === 'keep-both') {
        const copy = row.tombstone ? remote.payload : decodeSnapshot(row.payload);
        if (copy) preserved = await this.#insertSnapshot({
          ...copy,
          messages: copy.messages.map(message => message.state === 'pending' ? { ...message, state: 'interrupted' } : message),
        });
      }
      await this.#db.runAsync('DELETE FROM smarana_outbox WHERE resource_id = ?', resourceId);
      await this.#db.runAsync('DELETE FROM smarana_conflicts WHERE resource_id = ?', resourceId);
      const maintainDeletion = row.tombstone === 1 && !remote.tombstone;
      await this.#db.runAsync(`UPDATE smarana_conversations SET local_version = ?, title = ?, server_revision = ?, tombstone = ?,
        payload = ?, updated_at = ?, sync_state = ?, local_pending_ids = '[]' WHERE resource_id = ?`,
      nextVersion(row.local_version), maintainDeletion ? '' : remote.payload?.title ?? '', remote.revision, maintainDeletion ? 1 : Number(remote.tombstone),
      maintainDeletion || !remote.payload ? null : JSON.stringify(remote.payload), this.#time(),
      maintainDeletion ? 'pending' : 'synced', resourceId);
      const resolved = (await this.#row(resourceId))!;
      if (maintainDeletion) await this.#queue(resolved);
      return { record: this.#record(resolved), preserved };
    }));
  }

  async #recoverInterrupted(): Promise<void> {
    const rows = await this.#db.getAllAsync<ConversationRow>(
      "SELECT * FROM smarana_conversations WHERE tombstone = 0 AND local_pending_ids != '[]'",
    );
    for (const row of rows) {
      const local = new Set(pendingIds(row));
      const snapshot = decodeSnapshot(row.payload)!;
      const messages = snapshot.messages.map(message => message.role === 'assistant' && message.state === 'pending' && local.has(message.id)
        ? { ...message, state: 'interrupted' as const } : message);
      await this.#writeSnapshot(row, { ...snapshot, messages });
      await this.#db.runAsync("UPDATE smarana_conversations SET local_pending_ids = '[]' WHERE resource_id = ?", row.resource_id);
    }
  }
}
