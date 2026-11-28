// Real SQLite replicas and real PostgreSQL/WASM functions through the product
// transport. HTTP/authentication are explicit fixtures; this is not a live cloud test.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const serverRequire = createRequire(path.join(root, 'karta/package.json'));
const { PGlite } = serverRequire('@electric-sql/pglite');
const ts = serverRequire('typescript');
const OWNER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
function loadProduct() {
  const cache = new Map();
  const load = input => {
    const file = fs.existsSync(input) ? input : `${input}.ts`;
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    new Function('require', 'module', 'exports', source)(name => {
      assert(name.startsWith('.'), `Unexpected native or network import: ${name}`);
      return load(path.resolve(path.dirname(file), name));
    }, module, module.exports);
    return module.exports;
  };
  return { ...load(path.join(root, 'mobile/lib/smarana-store.ts')), ...load(path.join(root, 'mobile/lib/smarana-sync.ts')) };
}
class SqliteDriver {
  constructor(file) { this.db = new DatabaseSync(file); this.closed = false; }
  async execAsync(sql) { this.db.exec(sql); }
  async runAsync(sql, ...args) { return this.db.prepare(sql).run(...args); }
  async getFirstAsync(sql, ...args) { return this.db.prepare(sql).get(...args) ?? null; }
  async getAllAsync(sql, ...args) { return this.db.prepare(sql).all(...args); }
  async closeAsync() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
function snapshot(draft = 'Idée conservée hors connexion') {
  return { title: 'Mon projet PURAMA', draft, messages: [
    { id: randomUUID(), role: 'user', content: 'Voici mon projet.', state: 'complete', createdAt: '2026-11-23T17:00:00.000Z' },
    { id: randomUUID(), role: 'assistant', content: 'Texte synthétique enregistré pour vérifier la continuité.', state: 'complete', createdAt: '2026-11-23T17:00:01.000Z' },
  ] };
}
async function fixture(t) {
  const { SmaranaStore, createSmaranaSync } = loadProduct();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purama-replication-roundtrip-'));
  const db = new PGlite();
  const stores = [];
  const calls = [];
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('fixture.owner',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;`);
  await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations/20261123180000_smarana_replication.sql'), 'utf8'));
  await db.query('INSERT INTO auth.users VALUES($1),($2)', [OWNER, OTHER]);
  const open = async (device, ownerId = OWNER) => {
    const store = await SmaranaStore.open(new SqliteDriver(path.join(directory, `${device}-${ownerId}.db`)), { ownerId, newId: randomUUID });
    stores.push(store); return store;
  };
  const sync = (store, options = {}) => {
    const states = [];
    const worker = createSmaranaSync({ store, allowed: () => true,
      credentials: async () => ({ ownerId: options.credentialOwner ?? store.ownerId, accessToken: `fixture:${options.credentialOwner ?? store.ownerId}`,
        anonKey: 'fixture-public-key', url: 'https://fixture.invalid' }),
      onState: (state, message) => states.push({ state, message }),
      fetch: async (url, request) => {
        const body = JSON.parse(request.body);
        const functionName = new URL(url).pathname.split('/').at(-1);
        assert(['smarana_apply', 'smarana_pull'].includes(functionName), 'Replication must never invoke an agent or an external action');
        assert.equal(request.headers['Content-Profile'], 'purama_ai');
        assert.equal(request.headers.Authorization, `Bearer fixture:${store.ownerId}`);
        calls.push({ functionName, body });
        await db.query("SELECT set_config('fixture.owner',$1,false)", [store.ownerId]);
        await db.exec('SET ROLE authenticated');
        let result;
        try {
          const sql = functionName === 'smarana_apply'
            ? 'SELECT purama_ai.smarana_apply($1,$2::jsonb) AS value'
            : 'SELECT purama_ai.smarana_pull($1,$2,$3) AS value';
          const args = functionName === 'smarana_apply'
            ? [body.p_expected_owner_id, JSON.stringify(body.p_mutation)]
            : [body.p_expected_owner_id, body.p_after_cursor, body.p_limit];
          result = (await db.query(sql, args)).rows[0].value;
        } finally { await db.exec('RESET ROLE'); }
        await options.afterCommit?.(functionName, result, body);
        return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    return { ...worker, states };
  };
  t.after(async () => { for (const store of stores) await store.close(); await db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, open, sync, calls };
}

test('offline creation survives process-like reopening, a lost server acknowledgement and recovery by a second replica', async t => {
  const f = await fixture(t);
  const payload = snapshot();
  const first = await f.open('first');
  const created = await first.create(payload);
  await first.close();
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM purama_ai.smarana_records')).rows[0].n, 0);
  const reopened = await f.open('first');
  let dropped = false;
  const sender = f.sync(reopened, { afterCommit: async name => {
    if (name === 'smarana_apply' && !dropped) { dropped = true; throw new Error('Fixture: response lost after commit'); }
  } });
  await sender.run();
  assert.equal(sender.states.at(-1).state, 'pending');
  const sent = f.calls[0].body.p_mutation;
  await sender.run();
  const repeated = f.calls.filter(call => call.functionName === 'smarana_apply').map(call => call.body.p_mutation);
  assert.equal(repeated.length, 2); assert.deepEqual(repeated[0], repeated[1]);
  assert.equal(sent.resourceId, created.resourceId);
  assert.equal(sender.states.at(-1).state, 'synced');
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM purama_ai.smarana_mutations')).rows[0].n, 1);
  const second = await f.open('second'); await f.sync(second).run();
  const recovered = await second.read(created.resourceId);
  assert.deepEqual(recovered.payload, payload);
  assert.equal(recovered.syncState, 'synced');
});

test('two offline edits preserve a conflict and keep-both creates only the explicitly requested copy', async t => {
  const f = await fixture(t); const a = await f.open('a'); const b = await f.open('b');
  const initial = await a.create(snapshot('Initial'));
  await f.sync(a).run(); await f.sync(b).run();
  const one = await a.read(initial.resourceId); const two = await b.read(initial.resourceId);
  await a.update(one.resourceId, one.localVersion, { ...one.payload, draft: 'Appareil A' });
  await b.update(two.resourceId, two.localVersion, { ...two.payload, draft: 'Appareil B' });
  await f.sync(a).run(); await f.sync(b).run();
  const conflicted = await b.read(initial.resourceId);
  assert.equal(conflicted.syncState, 'conflict'); assert.equal(conflicted.payload.draft, 'Appareil B');
  assert.equal((await b.conflicts(initial.resourceId))[0].remote.payload.draft, 'Appareil A');
  const kept = await b.resolveConflict(initial.resourceId, conflicted.localVersion, 'keep-both');
  assert.notEqual(kept.preserved.resourceId, initial.resourceId);
  await f.sync(b).run(); await f.sync(a).run();
  assert.equal((await a.read(initial.resourceId)).payload.draft, 'Appareil A');
  assert.equal((await a.read(kept.preserved.resourceId)).payload.draft, 'Appareil B');
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM purama_ai.smarana_records')).rows[0].n, 2);
});

test('a late offline writer cannot resurrect a conversation deleted by another replica', async t => {
  const f = await fixture(t); const a = await f.open('a'); const b = await f.open('b');
  const created = await a.create(snapshot());
  await f.sync(a).run(); await f.sync(b).run();
  const stale = await b.read(created.resourceId);
  await b.update(stale.resourceId, stale.localVersion, { ...stale.payload, draft: 'Ancienne modification hors ligne' });
  const current = await a.read(created.resourceId); await a.tombstone(current.resourceId, current.localVersion);
  await f.sync(a).run(); await f.sync(b).run();
  const conflict = await b.read(created.resourceId);
  assert.equal(conflict.syncState, 'conflict'); assert.equal((await b.conflicts(created.resourceId))[0].reason, 'deleted');
  const row = (await f.db.query('SELECT tombstone,payload FROM purama_ai.smarana_records WHERE resource_id=$1', [created.resourceId])).rows[0];
  assert.deepEqual(row, { tombstone: true, payload: null });
  await b.resolveConflict(conflict.resourceId, conflict.localVersion, 'remote');
  assert.equal((await b.read(created.resourceId)).tombstone, true);
  assert.equal(await b.hasPending(), false);
});

test('a different credential owner produces no request, and the other account pulls none of the private conversation', async t => {
  const f = await fixture(t); const a = await f.open('a');
  await a.create(snapshot());
  const rejected = f.sync(a, { credentialOwner: OTHER }); await rejected.run();
  assert.equal(f.calls.length, 0); assert.equal(rejected.states.at(-1).state, 'pending');
  await f.sync(a).run();
  const b = await f.open('other', OTHER); await f.sync(b).run();
  assert.deepEqual(await b.list(), []);
});

test('a new local edit made after remote commit is not erased by the old acknowledgement', async t => {
  const f = await fixture(t); const a = await f.open('a');
  const initial = await a.create(snapshot('Avant accusé'));
  let edited = false;
  const sender = f.sync(a, { afterCommit: async name => {
    if (name !== 'smarana_apply' || edited) return;
    edited = true;
    const current = await a.read(initial.resourceId);
    await a.update(current.resourceId, current.localVersion, { ...current.payload, draft: 'Écrit pendant le retour de l’accusé' });
  } });
  await sender.run();
  assert.equal((await a.read(initial.resourceId)).payload.draft, 'Écrit pendant le retour de l’accusé');
  await sender.run();
  const b = await f.open('b'); await f.sync(b).run();
  assert.equal((await b.read(initial.resourceId)).payload.draft, 'Écrit pendant le retour de l’accusé');
  assert.equal((await a.read(initial.resourceId)).syncState, 'synced');
});
