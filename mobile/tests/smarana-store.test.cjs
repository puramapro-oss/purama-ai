const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');

const project = path.resolve(__dirname, '..');
const OWNER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const RESOURCE = '20000000-0000-4000-8000-000000000001';
const TIME = '2026-11-23T16:00:00.000Z';
const id = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (content = 'Texte conservé', n = 1) => ({ id: id(n), role: 'user', content, state: 'complete', createdAt: TIME });
const assistant = (content = 'Réponse partielle', state = 'pending', n = 2) => ({ id: id(n), role: 'assistant', content, state, createdAt: TIME });
const snapshot = (content = 'Texte conservé', options = {}) => ({ title: 'Conversation', messages: [user(content)], draft: '', ...options });

function loader(mocks = {}) {
  const cache = new Map();
  function load(file) {
    let resolved = path.resolve(project, file);
    if (!fs.existsSync(resolved)) resolved += '.ts';
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    const source = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      fileName: resolved,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const requireLocal = name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith('.')) return load(path.resolve(path.dirname(resolved), name));
      throw new Error(`Unexpected external dependency: ${name}`);
    };
    new Function('require', 'module', 'exports', source)(requireLocal, module, module.exports);
    return module.exports;
  }
  return load;
}

class Driver {
  constructor(filename) { this.db = new DatabaseSync(filename); this.closed = false; this.log = []; this.before = null; }
  async step(method, sql, params = []) {
    this.log.push({ method, sql, params });
    await this.before?.(method, sql, params);
  }
  async execAsync(sql) { await this.step('exec', sql); this.db.exec(sql); }
  async runAsync(sql, ...params) { await this.step('run', sql, params); return this.db.prepare(sql).run(...params); }
  async getFirstAsync(sql, ...params) { await this.step('first', sql, params); return this.db.prepare(sql).get(...params) ?? null; }
  async getAllAsync(sql, ...params) { await this.step('all', sql, params); return this.db.prepare(sql).all(...params); }
  async closeAsync() { if (!this.closed) { this.closed = true; this.db.close(); } }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purama-smarana-'));
  const filename = path.join(directory, 'account.db');
  const { SmaranaStore } = loader()('lib/smarana-store.ts');
  const opened = [];
  let sequence = 1000;
  const open = async (ownerId = OWNER, extra = {}) => {
    const db = new Driver(filename);
    const store = await SmaranaStore.open(db, { ownerId, newId: () => id(sequence++), now: () => TIME, ...extra });
    opened.push(store);
    return { store, db };
  };
  t.after(async () => {
    for (const store of opened) await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { ...(await open(options.ownerId, options)), open, filename, SmaranaStore };
}

function accepted(mutation, cursor = '1') {
  return { status: 'applied', ownerId: mutation.ownerId, resourceId: mutation.resourceId,
    mutationId: mutation.mutationId, baseRevision: mutation.baseRevision, revision: mutation.baseRevision + 1,
    cursor, updatedAt: TIME, replayed: false };
}
function remote(payload = snapshot('Distant'), options = {}) {
  return { schemaVersion: 1, ownerId: OWNER, resourceId: RESOURCE, revision: 1,
    cursor: '1', tombstone: false, payload, updatedAt: TIME, ...options };
}
function page(record, options = {}) {
  return { ownerId: OWNER, records: [record], cursor: record.cursor, hasMore: false, ...options };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('SQLite durably reopens the same IDs, completed response and unsent draft', async t => {
  const f = await fixture(t);
  const initial = snapshot('Mon projet', { draft: 'Un brouillon non envoyé', messages: [user('Mon projet'), assistant('Réponse terminée', 'complete')] });
  const created = await f.store.create(initial, RESOURCE);
  const [firstSend] = await f.store.pending();
  initial.draft = 'Mutation du demandeur';
  firstSend.payload.messages[0].content = 'Mutation du transport';
  await f.store.close();
  const { store } = await f.open();
  const read = await store.read(RESOURCE);
  assert.equal(read.localVersion, created.localVersion);
  assert.equal(read.payload.draft, 'Un brouillon non envoyé');
  assert.equal(read.payload.messages[0].content, 'Mon projet');
  assert.equal(read.payload.messages[1].state, 'complete');
  assert.equal((await store.pending())[0].mutationId, firstSend.mutationId);
  assert.equal((await store.pending())[0].payload.messages[0].content, 'Mon projet');
});

test('restart interrupts only this device’s unfinished response and retains every draft', async t => {
  const f = await fixture(t);
  const created = await f.store.create(snapshot('', { messages: [user(), assistant()], draft: 'Suite à écrire' }), RESOURCE);
  const foreignId = id(500);
  await f.store.ingestPull(page(remote(snapshot('', { messages: [user(), assistant('Autre appareil')], draft: 'Autre brouillon' }),
    { resourceId: foreignId })), '0');
  await f.store.close();
  const { store } = await f.open();
  const recovered = await store.read(RESOURCE);
  assert.equal(recovered.localVersion, created.localVersion + 1);
  assert.equal(recovered.payload.messages[1].content, 'Réponse partielle');
  assert.equal(recovered.payload.messages[1].state, 'interrupted');
  assert.equal(recovered.payload.draft, 'Suite à écrire');
  assert.equal((await store.read(foreignId)).payload.messages[1].state, 'pending');
  assert.equal((await store.pending()).find(m => m.resourceId === RESOURCE).payload.messages[1].state, 'interrupted');
});

test('content and outbox roll back together on a failed write', async t => {
  const f = await fixture(t);
  f.db.before = async (method, sql) => { if (sql.includes('INSERT INTO smarana_outbox')) throw new Error('Synthetic disk full'); };
  await assert.rejects(f.store.create(snapshot(), RESOURCE), /Synthetic disk full/);
  f.db.before = null;
  assert.equal(await f.store.read(RESOURCE), null);
  assert.deepEqual(await f.store.pending(), []);
  const original = await f.store.create(snapshot('Original'), RESOURCE);
  f.db.before = async (method, sql) => { if (sql.includes('INSERT INTO smarana_outbox')) throw new Error('Synthetic disk full'); };
  await assert.rejects(f.store.update(RESOURCE, original.localVersion, snapshot('Perdu si non atomique')), /Synthetic disk full/);
  f.db.before = null;
  assert.equal((await f.store.read(RESOURCE)).payload.messages[0].content, 'Original');
  assert.equal((await f.store.pending())[0].payload.messages[0].content, 'Original');
});

test('simultaneous stale local writes use CAS on the same serialized connection', async t => {
  const f = await fixture(t);
  const first = await f.store.create(snapshot(), RESOURCE);
  const writes = await Promise.allSettled([
    f.store.update(RESOURCE, first.localVersion, snapshot('Édition A')),
    f.store.update(RESOURCE, first.localVersion, snapshot('Édition B')),
  ]);
  assert.equal(writes[0].status, 'fulfilled');
  assert.equal(writes[1].status, 'rejected');
  assert.equal(writes[1].reason.code, 'local_conflict');
  assert.equal((await f.store.read(RESOURCE)).payload.messages[0].content, 'Édition A');
  let depth = 0;
  for (const { sql } of f.db.log) {
    if (sql === 'BEGIN IMMEDIATE') assert.equal(++depth, 1);
    if (sql === 'COMMIT' || sql === 'ROLLBACK') assert.equal(--depth, 0);
  }
  assert.equal(depth, 0);
});

test('unsent snapshots coalesce; dispatch and retries preserve the exact previous operation', async t => {
  const f = await fixture(t);
  let record = await f.store.create(snapshot('Version 1'), RESOURCE);
  record = await f.store.update(RESOURCE, record.localVersion, snapshot('Version 2'));
  const [sent] = await f.store.pending();
  assert.equal(sent.payload.messages[0].content, 'Version 2');
  record = await f.store.update(RESOURCE, record.localVersion, snapshot('Version 3'));
  record = await f.store.update(RESOURCE, record.localVersion, snapshot('Version 4'));
  assert.deepEqual(await f.store.pending(), [sent]);
  assert.equal(f.db.db.prepare('SELECT count(*) AS n FROM smarana_outbox').get().n, 2);
  assert.equal(await f.store.acknowledge(accepted(sent)), true);
  assert.equal((await f.store.read(RESOURCE)).syncState, 'pending');
  const [successor] = await f.store.pending();
  assert.notEqual(successor.mutationId, sent.mutationId);
  assert.equal(successor.baseRevision, 1);
  assert.equal(successor.payload.messages[0].content, 'Version 4');
  assert.equal(await f.store.acknowledge({ ...accepted(sent), replayed: true }), false);
  assert.equal((await f.store.read(RESOURCE)).syncState, 'pending');
  await f.store.acknowledge(accepted(successor, '2'));
  assert.equal((await f.store.read(RESOURCE)).syncState, 'synced');
  assert.deepEqual(await f.store.pending(), []);
  assert.equal(await f.store.cursor(), '0', 'a write receipt cannot skip updates of other resources');
});

test('wrong owner, wrong base and never-dispatched acknowledgements cannot drain the queue', async t => {
  const f = await fixture(t);
  await f.store.create(snapshot(), RESOURCE);
  const row = f.db.db.prepare('SELECT * FROM smarana_outbox').get();
  const expected = { schemaVersion: 1, ownerId: OWNER, resourceId: RESOURCE, mutationId: row.mutation_id, baseRevision: 0, tombstone: false, payload: snapshot() };
  await rejectsCode(f.store.acknowledge(accepted(expected)), 'invalid_ack');
  const [sent] = await f.store.pending();
  assert.throws(() => f.store.acknowledge({ ...accepted(sent), ownerId: OTHER }), { code: 'owner_mismatch' });
  await rejectsCode(f.store.acknowledge({ ...accepted(sent), baseRevision: 9, revision: 10 }), 'invalid_ack');
  assert.deepEqual(await f.store.pending(), [sent]);
});

test('status inspection never dispatches a draft or prevents deletion before its first upload', async t => {
  const f = await fixture(t);
  assert.equal(await f.store.hasPending(), false);
  const initial = await f.store.create(snapshot('Ne doit pas quitter cet appareil'), RESOURCE);
  assert.equal(await f.store.hasPending(), true);
  assert.equal(await f.store.hasPending(), true);
  assert.equal(f.db.db.prepare('SELECT sum(dispatched) AS count FROM smarana_outbox').get().count, 0);
  await f.store.tombstone(RESOURCE, initial.localVersion);
  const queued = f.db.db.prepare('SELECT * FROM smarana_outbox').all();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload, null);
  assert.equal(queued[0].tombstone, 1);
  const [sent] = await f.store.pending();
  assert.equal(sent.tombstone, true);
  assert.equal(sent.baseRevision, 0);
  await f.store.acknowledge(accepted(sent));
  assert.equal(await f.store.hasPending(), false);
  await f.store.create(snapshot('Conflit seulement'), id(700));
  await f.store.ingestPull(page(remote(snapshot('Distant'), { resourceId: id(700), cursor: '2' })), '0');
  assert.equal((await f.store.conflicts()).length, 1);
  assert.equal(await f.store.hasPending(), false, 'conflicts are reported separately, not as runnable uploads');
});

test('a lost-ack pull echo still requires the exact receipt and never drops newer local text', async t => {
  const f = await fixture(t);
  let local = await f.store.create(snapshot('Envoyé'), RESOURCE);
  const [sent] = await f.store.pending();
  local = await f.store.update(RESOURCE, local.localVersion, snapshot('Édité pendant le transport'));
  await f.store.ingestPull(page(remote(sent.payload)), '0');
  assert.equal((await f.store.read(RESOURCE)).syncState, 'pending');
  assert.deepEqual(await f.store.conflicts(), []);
  await f.store.acknowledge({ ...accepted(sent), replayed: true });
  assert.equal((await f.store.read(RESOURCE)).payload.messages[0].content, 'Édité pendant le transport');
  assert.equal((await f.store.pending())[0].baseRevision, 1);
});

test('pull pages, exact cursors and account ownership are transactional', async t => {
  const f = await fixture(t);
  const big = '9007199254740993';
  await f.store.ingestPull(page(remote(snapshot('Distant'), { cursor: big })), '0');
  assert.equal(await f.store.cursor(), big);
  assert.equal((await f.store.read(RESOURCE)).payload.messages[0].content, 'Distant');
  await rejectsCode(f.store.ingestPull(page(remote(snapshot('Ancien'), { revision: 2, cursor: '9007199254740994' })), '0'), 'stale_pull');
  assert.equal((await f.store.read(RESOURCE)).serverRevision, 1);
  assert.throws(() => f.store.ingestPull({ ownerId: OTHER, records: [], cursor: '0', hasMore: false }, big), { code: 'owner_mismatch' });
  f.db.before = async (method, sql) => { if (sql.includes("UPDATE smarana_meta SET value")) throw new Error('Cursor failure'); };
  await assert.rejects(f.store.ingestPull(page(remote(snapshot('Transaction annulée'), { revision: 2, cursor: '9007199254740994' })), big), /Cursor failure/);
  f.db.before = null;
  assert.equal((await f.store.read(RESOURCE)).serverRevision, 1);
  assert.equal(await f.store.cursor(), big);
});

test('remote conflict keeps both snapshots and a later conflict invalidates the resolution CAS', async t => {
  const f = await fixture(t);
  await f.store.create(snapshot('Version locale'), RESOURCE);
  await f.store.ingestPull(page(remote(snapshot('Version distante'))), '0');
  const firstConflict = await f.store.read(RESOURCE);
  assert.equal(firstConflict.syncState, 'conflict');
  assert.equal(firstConflict.payload.messages[0].content, 'Version locale');
  assert.equal((await f.store.conflicts())[0].remote.payload.messages[0].content, 'Version distante');
  assert.deepEqual(await f.store.pending(), []);
  await f.store.ingestPull(page(remote(snapshot('Version distante suivante'), { revision: 2, cursor: '2' })), '1');
  await rejectsCode(f.store.resolveConflict(RESOURCE, firstConflict.localVersion, 'remote'), 'local_conflict');
  assert.equal((await f.store.conflicts()).length, 2);
  const current = await f.store.read(RESOURCE);
  const resolved = await f.store.resolveConflict(RESOURCE, current.localVersion, 'remote');
  assert.equal(resolved.record.payload.messages[0].content, 'Version distante suivante');
  assert.equal(resolved.preserved, null);
  assert.equal(resolved.record.syncState, 'synced');
  assert.deepEqual(await f.store.conflicts(), []);
});

test('delete before upload emits a payload-free terminal marker and never revives the original', async t => {
  const f = await fixture(t);
  const created = await f.store.create(snapshot('Ne doit jamais être envoyé'), RESOURCE);
  const removed = await f.store.tombstone(RESOURCE, created.localVersion);
  assert.equal(removed.tombstone, true);
  assert.deepEqual(await f.store.list(), []);
  const [sent] = await f.store.pending();
  assert.equal(sent.baseRevision, 0);
  assert.equal(sent.payload, null);
  assert.equal(sent.tombstone, true);
  await rejectsCode(f.store.update(RESOURCE, removed.localVersion, snapshot('Résurrection')), 'deleted');
  await f.store.acknowledge(accepted(sent));
  await f.store.ingestPull(page(remote(snapshot('Réplique ancienne'), { revision: 2, cursor: '2' })), '0');
  assert.equal((await f.store.read(RESOURCE)).payload, null);
  assert.equal((await f.store.read(RESOURCE)).tombstone, true);
});

test('a creation echo after local deletion does not block the exact queued tombstone', async t => {
  const f = await fixture(t);
  const created = await f.store.create(snapshot('Ancienne création en vol'), RESOURCE);
  const [creation] = await f.store.pending();
  await f.store.tombstone(RESOURCE, created.localVersion);
  await f.store.ingestPull(page(remote(creation.payload)), '0');
  assert.deepEqual(await f.store.conflicts(), []);
  assert.equal((await f.store.read(RESOURCE)).tombstone, true);
  await f.store.acknowledge({ ...accepted(creation), replayed: true });
  const [deletion] = await f.store.pending();
  assert.equal(deletion.baseRevision, 1);
  assert.equal(deletion.tombstone, true);
  assert.equal(deletion.payload, null);
  await f.store.acknowledge(accepted(deletion, '2'));
  assert.equal((await f.store.read(RESOURCE)).syncState, 'synced');
  assert.equal((await f.store.read(RESOURCE)).tombstone, true);
});

test('keep-both after a remote tombstone preserves local text under a fresh identity only', async t => {
  const f = await fixture(t);
  await f.store.create(snapshot('Mon travail hors ligne', { draft: 'Brouillon à conserver' }), RESOURCE);
  await f.store.ingestPull(page(remote(null, { tombstone: true })), '0');
  const conflict = await f.store.read(RESOURCE);
  const result = await f.store.resolveConflict(RESOURCE, conflict.localVersion, 'keep-both');
  assert.equal(result.record.tombstone, true);
  assert.equal(result.record.payload, null);
  assert.notEqual(result.preserved.resourceId, RESOURCE);
  assert.equal(result.preserved.payload.messages[0].content, 'Mon travail hors ligne');
  assert.equal(result.preserved.payload.draft, 'Brouillon à conserver');
  assert.deepEqual((await f.store.pending()).map(m => m.resourceId), [result.preserved.resourceId]);
  await f.store.close();
  const { store } = await f.open();
  assert.equal((await store.read(RESOURCE)).tombstone, true);
  assert.equal((await store.list()).length, 1);
});

test('local tombstone conflict offers a new copy without changing remote-choice semantics', async t => {
  const f = await fixture(t);
  const local = await f.store.create(snapshot(), RESOURCE);
  await f.store.tombstone(RESOURCE, local.localVersion);
  await f.store.ingestPull(page(remote(snapshot('Autre appareil'))), '0');
  const conflict = await f.store.read(RESOURCE);
  await rejectsCode(f.store.resolveConflict(RESOURCE, conflict.localVersion, 'remote'), 'deleted');
  const result = await f.store.resolveConflict(RESOURCE, conflict.localVersion, 'keep-both');
  assert.equal(result.record.tombstone, true);
  assert.equal(result.preserved.payload.messages[0].content, 'Autre appareil');
  const pending = await f.store.pending();
  assert.equal(pending.find(m => m.resourceId === RESOURCE).tombstone, true);
  assert.equal(pending.find(m => m.resourceId === RESOURCE).baseRevision, 1);
});

test('failure during keep-both resolution rolls back copy, original, conflict and outbox', async t => {
  const f = await fixture(t);
  await f.store.create(snapshot('Local'), RESOURCE);
  await f.store.ingestPull(page(remote()), '0');
  const original = await f.store.read(RESOURCE);
  f.db.before = async (method, sql) => { if (sql.includes('DELETE FROM smarana_conflicts')) throw new Error('Synthetic interruption'); };
  await assert.rejects(f.store.resolveConflict(RESOURCE, original.localVersion, 'keep-both'), /Synthetic interruption/);
  f.db.before = null;
  assert.deepEqual(await f.store.read(RESOURCE), original);
  assert.equal((await f.store.list()).length, 1);
  assert.equal((await f.store.conflicts()).length, 1);
  assert.equal(f.db.db.prepare('SELECT count(*) AS n FROM smarana_outbox').get().n, 1);
});

test('opening the wrong account refuses ownership reassignment and preserves the original database', async t => {
  const f = await fixture(t);
  await f.store.create(snapshot('Compte A'), RESOURCE);
  await f.store.close();
  await rejectsCode(f.open(OTHER), 'owner_mismatch');
  const { store } = await f.open();
  assert.equal((await store.read(RESOURCE)).payload.messages[0].content, 'Compte A');
});

test('account invalidation fences an in-flight read and every queued operation', async t => {
  const f = await fixture(t);
  await f.store.create(snapshot('Secret A'), RESOURCE);
  const entered = deferred();
  const release = deferred();
  f.db.before = async (method, sql) => { if (sql.startsWith('SELECT * FROM smarana_conversations WHERE resource_id')) {
    entered.resolve(); await release.promise;
  } };
  const reading = f.store.read(RESOURCE);
  const rejectedRead = rejectsCode(reading, 'closed');
  await entered.promise;
  const queuedWrite = f.store.create(snapshot('Ne doit pas être écrit'), id(88));
  const rejectedWrite = rejectsCode(queuedWrite, 'closed');
  f.store.invalidate();
  const closing = f.store.close();
  release.resolve();
  await Promise.all([rejectedRead, rejectedWrite, closing]);
  const { store } = await f.open();
  assert.equal(await store.read(id(88)), null);
  assert.equal((await store.pending())[0].payload.messages[0].content, 'Secret A');
});

test('invalidation during an uncommitted write rolls back content and queue before closing', async t => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  f.db.before = async (method, sql) => { if (sql.includes('INSERT INTO smarana_outbox')) { entered.resolve(); await release.promise; } };
  const write = f.store.create(snapshot('Écriture interrompue'), RESOURCE);
  const rejected = rejectsCode(write, 'closed');
  await entered.promise;
  const close = f.store.close();
  release.resolve();
  await Promise.all([rejected, close]);
  const { store } = await f.open();
  assert.equal(await store.read(RESOURCE), null);
  assert.deepEqual(await store.pending(), []);
});

// These boundary tests use an explicit SQLCipher-capability fixture over Node
// SQLite. They verify fail-closed ordering and account fencing, NOT encryption.
// Actual encryption, wrong-key rejection and native crash recovery are native CI gates.
function nativeFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purama-smarana-native-'));
  const documentDirectory = `file://${directory}/Documents/`;
  fs.mkdirSync(fileURLToPath(documentDirectory), { recursive: true });
  const calls = [];
  const keys = new Map();
  const drivers = [];
  const keyOptions = [];
  const dbPath = owner => fileURLToPath(`${documentDirectory}smarana/account-${owner}.db`);
  const mocks = {
    'expo-crypto': { getRandomBytesAsync: async n => new Uint8Array(crypto.randomBytes(n)), randomUUID: () => crypto.randomUUID() },
    'expo-file-system/legacy': {
      documentDirectory,
      getInfoAsync: async uri => ({ exists: fs.existsSync(fileURLToPath(uri)) }),
      makeDirectoryAsync: async uri => { calls.push('mkdir'); fs.mkdirSync(fileURLToPath(uri), { recursive: true }); },
    },
    'expo-secure-store': {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-device-only-fixture',
      isAvailableAsync: async () => true,
      getItemAsync: async (key, config) => { keyOptions.push(config); return keys.get(key) ?? null; },
      setItemAsync: async (key, value, config) => { calls.push('save-key'); keyOptions.push(config); keys.set(key, value); },
    },
    'expo-sqlite': {
      openDatabaseAsync: async (name, config, uri) => {
        calls.push({ open: name, config, uri });
        const db = new Driver(path.join(fileURLToPath(uri), name));
        drivers.push(db);
        const first = db.getFirstAsync.bind(db);
        db.getFirstAsync = async (sql, ...params) => {
          if (sql === 'PRAGMA cipher_version') { calls.push('cipher-version'); return options.noCipher ? null : { cipher_version: '4.10.0-fixture' }; }
          if (sql.includes('FROM sqlite_master')) { calls.push('read-keyed-page'); if (options.wrongKey) throw new Error('Synthetic private PRAGMA error must not escape'); }
          return first(sql, ...params);
        };
        const exec = db.execAsync.bind(db);
        db.execAsync = async sql => {
          if (sql.startsWith('PRAGMA key')) { calls.push('set-key'); return; }
          if (sql.includes('CREATE TABLE')) calls.push('schema-write');
          return exec(sql);
        };
        return db;
      },
    },
  };
  const load = loader(mocks);
  const native = load('lib/smarana-native.ts');
  t.after(async () => {
    await native.closeSmaranaStore();
    for (const driver of drivers) await driver.closeAsync();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { native, keys, calls, drivers, dbPath, keyOptions, load };
}

test('native boundary refuses a binary without SQLCipher before any key/schema SQL writes', async t => {
  const f = nativeFixture(t, { noCipher: true });
  await rejectsCode(f.native.openSmaranaStore(OWNER), 'cipher_unavailable');
  assert.ok(f.calls.includes('cipher-version'));
  assert.ok(!f.calls.includes('set-key'));
  assert.ok(!f.calls.includes('schema-write'));
  assert.ok(f.drivers.every(driver => driver.closed));
});

test('native boundary never creates a replacement key when database or journal exists', async t => {
  const f = nativeFixture(t);
  fs.mkdirSync(path.dirname(f.dbPath(OWNER)), { recursive: true });
  fs.writeFileSync(`${f.dbPath(OWNER)}-wal`, 'Existing encrypted journal fixture');
  await rejectsCode(f.native.openSmaranaStore(OWNER), 'missing_key');
  assert.equal(f.keys.size, 0);
  assert.equal(f.drivers.length, 0);
  assert.equal(fs.readFileSync(`${f.dbPath(OWNER)}-wal`, 'utf8'), 'Existing encrypted journal fixture');
});

test('a surviving rollback journal also forbids inventing a replacement key or database', async t => {
  const f = nativeFixture(t);
  fs.mkdirSync(path.dirname(f.dbPath(OWNER)), { recursive: true });
  fs.writeFileSync(`${f.dbPath(OWNER)}-journal`, 'Existing rollback journal fixture');
  await rejectsCode(f.native.openSmaranaStore(OWNER), 'missing_key');
  assert.equal(f.keys.size, 0);
  assert.equal(f.drivers.length, 0);
  assert.equal(fs.readFileSync(`${f.dbPath(OWNER)}-journal`, 'utf8'), 'Existing rollback journal fixture');
});

test('native boundary rejects malformed keys before opening and masks wrong-key native errors', async t => {
  const f = nativeFixture(t, { wrongKey: true });
  f.keys.set(`smarana.v1.${OWNER}`, 'invalid-key');
  await rejectsCode(f.native.openSmaranaStore(OWNER), 'invalid_key');
  assert.equal(f.drivers.length, 0);
  const key = 'ab'.repeat(32);
  f.keys.set(`smarana.v1.${OWNER}`, key);
  await assert.rejects(f.native.openSmaranaStore(OWNER), error => error.code === 'unlock_failed' && !error.message.includes('PRAGMA'));
  assert.equal(f.keys.get(`smarana.v1.${OWNER}`), key);
  assert.ok(!f.calls.includes('schema-write'));
  assert.ok(fs.existsSync(f.dbPath(OWNER)), 'no destructive delete/recreate recovery');
});

test('native boundary verifies cipher and keyed read before schema on one persistent connection', async t => {
  const f = nativeFixture(t);
  const store = await f.native.openSmaranaStore(OWNER);
  await store.create(snapshot('Donnée persistante'), RESOURCE);
  assert.ok(f.calls.indexOf('cipher-version') < f.calls.indexOf('set-key'));
  assert.ok(f.calls.indexOf('set-key') < f.calls.indexOf('read-keyed-page'));
  assert.ok(f.calls.indexOf('read-keyed-page') < f.calls.indexOf('schema-write'));
  const opening = f.calls.find(call => call.open);
  assert.equal(opening.config.useNewConnection, true);
  assert.ok(opening.uri.includes('/Documents/'));
  assert.ok(f.keyOptions.every(config => config.keychainAccessible === 'when-unlocked-device-only-fixture'));
  assert.match(f.keys.get(`smarana.v1.${OWNER}`), /^[0-9a-f]{64}$/);
  await f.native.closeSmaranaStore();
  const reopened = await f.native.openSmaranaStore(OWNER);
  assert.equal((await reopened.read(RESOURCE)).payload.messages[0].content, 'Donnée persistante');
  assert.equal(f.calls.filter(call => call === 'save-key').length, 1);
  assert.equal(f.drivers.length, 2, 'one keyed connection per opening, never per transaction');
});

test('native account switch synchronously fences A while B gets a separate key and database', async t => {
  const f = nativeFixture(t);
  const accountA = await f.native.openSmaranaStore(OWNER);
  await accountA.create(snapshot('Contenu A'), RESOURCE);
  const entered = deferred();
  const release = deferred();
  f.drivers[0].before = async (method, sql) => {
    if (sql.startsWith('SELECT * FROM smarana_conversations WHERE resource_id')) { entered.resolve(); await release.promise; }
  };
  const oldRead = accountA.read(RESOURCE);
  const fenced = rejectsCode(oldRead, 'closed');
  await entered.promise;
  const openingB = f.native.openSmaranaStore(OTHER);
  release.resolve();
  await fenced;
  const accountB = await openingB;
  assert.equal(await accountB.read(RESOURCE), null);
  assert.notEqual(f.keys.get(`smarana.v1.${OWNER}`), f.keys.get(`smarana.v1.${OTHER}`));
  await rejectsCode(accountA.pending(), 'closed');
  const againA = await f.native.openSmaranaStore(OWNER);
  assert.equal((await againA.read(RESOURCE)).payload.messages[0].content, 'Contenu A');
  assert.equal((await againA.pending())[0].ownerId, OWNER);
});

test('two overlapping native opens expose only the last selected account', async t => {
  const f = nativeFixture(t);
  const a = f.native.openSmaranaStore(OWNER);
  const rejectedA = rejectsCode(a, 'closed');
  const b = f.native.openSmaranaStore(OTHER);
  await rejectedA;
  assert.equal((await b).ownerId, OTHER);
  assert.equal(f.keys.has(`smarana.v1.${OWNER}`), false);
});

test('same-owner reopen and close races preserve data while fencing every older store', async t => {
  const f = nativeFixture(t);
  const original = await f.native.openSmaranaStore(OWNER);
  await original.create(snapshot('Même compte, nouvelle ouverture'), RESOURCE);
  const superseded = f.native.openSmaranaStore(OWNER);
  const rejected = rejectsCode(superseded, 'closed');
  const closing = f.native.closeSmaranaStore();
  const reopening = f.native.openSmaranaStore(OWNER);
  await Promise.all([rejected, closing]);
  const current = await reopening;
  await rejectsCode(original.read(RESOURCE), 'closed');
  await original.close();
  assert.equal((await current.read(RESOURCE)).payload.messages[0].content, 'Même compte, nouvelle ouverture');
  assert.equal(f.calls.filter(call => call === 'save-key').length, 1);
  assert.equal(f.drivers.length, 2, 'the superseded opening creates no new connection');
});

test('web explicitly reports unavailable without importing any native or plaintext driver', async () => {
  const web = loader()('lib/smarana-native.web.ts');
  await rejectsCode(web.openSmaranaStore(OWNER), 'unavailable');
  web.invalidateSmaranaStore();
  await web.closeSmaranaStore();
});

test('metadata pagination reads all 125 conversations without payloads or duplicate/shifted pages', async t => {
  const f = await fixture(t);
  const ids = Array.from({ length: 125 }, (_, i) => `50000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  for (let i = 0; i < ids.length; i++) await f.store.create(snapshot('Confidentiel '.repeat(1500), { title: `Titre ${i}` }), ids[i]);
  const queries = [];
  f.db.before = async (method, sql) => { if (method === 'all') queries.push(sql); };
  const first = await f.store.listPage();
  assert.equal(first.records.length, 50);
  assert.deepEqual(first.records.map(record => record.resourceId), ids.slice(0, 50));
  assert.ok(first.nextCursor);
  assert.ok(first.records.every(record => !Object.hasOwn(record, 'payload')));
  const boundary = await f.store.read(ids[49]);
  await f.store.tombstone(ids[49], boundary.localVersion);
  const beginning = await f.store.read(ids[0]);
  await f.store.tombstone(ids[0], beginning.localVersion);
  const second = await f.store.listPage({ cursor: first.nextCursor });
  const third = await f.store.listPage({ cursor: second.nextCursor });
  assert.deepEqual([...second.records, ...third.records].map(record => record.resourceId), ids.slice(50));
  assert.equal(third.nextCursor, null);
  assert.equal(new Set([...first.records, ...second.records, ...third.records].map(record => record.resourceId)).size, 125);
  assert.ok(queries.every(sql => !/\bpayload\b|\bjson_extract\b|SELECT\s+\*/i.test(sql)), 'history queries transfer metadata only');
  const plan = f.db.db.prepare(`EXPLAIN QUERY PLAN SELECT resource_id, title, updated_at, local_version, server_revision, sync_state
    FROM smarana_conversations WHERE tombstone = 0 ORDER BY updated_at DESC, resource_id ASC LIMIT ?`).all(51);
  assert.ok(plan.some(step => /COVERING INDEX smarana_history_summary/.test(step.detail)), 'metadata lookup does not visit payload overflow pages');
});

test('version-one databases migrate metadata atomically without losing a pending draft or message', async t => {
  const f = await fixture(t);
  await f.store.create(snapshot('Ancien message', { title: 'Ancien titre', draft: 'Ancien brouillon' }), RESOURCE);
  const [sent] = await f.store.pending();
  // Reproduce the previous on-disk schema, retaining its genuine rows/outbox.
  f.db.db.exec('DROP INDEX smarana_history_summary; ALTER TABLE smarana_conversations DROP COLUMN title; PRAGMA user_version = 1;');
  await f.store.close();
  const { store, db } = await f.open();
  assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, 2);
  const history = await store.listPage();
  assert.equal(history.records[0].title, 'Ancien titre');
  assert.equal((await store.read(RESOURCE)).payload.draft, 'Ancien brouillon');
  assert.equal((await store.read(RESOURCE)).payload.messages[0].content, 'Ancien message');
  assert.deepEqual(await store.pending(), [sent]);
});

test('metadata stays consistent through local changes, remote records and keep-both resolution', async t => {
  const f = await fixture(t);
  let local = await f.store.create(snapshot('Locale', { title: 'Titre initial' }), RESOURCE);
  local = await f.store.update(RESOURCE, local.localVersion, snapshot('Locale', { title: 'Titre modifié' }));
  assert.equal((await f.store.listPage()).records[0].title, 'Titre modifié');
  await f.store.ingestPull(page(remote(snapshot('Distante', { title: 'Titre distant' }))), '0');
  const conflicted = await f.store.read(RESOURCE);
  const resolved = await f.store.resolveConflict(RESOURCE, conflicted.localVersion, 'keep-both');
  const summaries = (await f.store.listPage()).records;
  assert.equal(summaries.find(record => record.resourceId === RESOURCE).title, 'Titre distant');
  assert.equal(summaries.find(record => record.resourceId === resolved.preserved.resourceId).title, 'Titre modifié');
  assert.throws(() => f.store.listPage({ limit: 51 }), { code: 'invalid_input' });
  assert.throws(() => f.store.listPage({ cursor: { resourceId: RESOURCE, updatedAt: 'not-a-date' } }), { code: 'invalid_input' });
});
