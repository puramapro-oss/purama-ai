const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
const project = path.resolve(__dirname, '../..');
const OWNER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const RESOURCE = '20000000-0000-4000-8000-000000000001';
const TIME = '2026-11-23T16:00:00.000Z';
const uuid = () => crypto.randomUUID();
const message = (role, content, state = 'complete') => ({ id: uuid(), role, content, state, createdAt: TIME });
const snapshot = (content = 'Texte conservé', extra = {}) => ({ title: 'Conversation', messages: [message('user', content)], draft: '', ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function timers() {
  let clock = 0, id = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const key = ++id; pending.set(key, { fn, time: clock + ms }); return key; },
    clearTimeout(key) { pending.delete(key); },
    async advance(ms) {
      clock += ms;
      for (const [key, timer] of [...pending].sort((a, b) => a[1].time - b[1].time)) {
        if (pending.has(key) && timer.time <= clock) { pending.delete(key); timer.fn(); }
      }
      await tick();
    },
  };
}
function loader({ mocks = {}, clock, environment = process.env } = {}) {
  const cache = new Map();
  return function load(file) {
    let resolved = path.resolve(project, file);
    if (!fs.existsSync(resolved)) resolved += '.ts';
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} }; cache.set(resolved, module);
    const source = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      fileName: resolved, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const local = name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith('.')) return load(path.resolve(path.dirname(resolved), name));
      throw new Error(`Unexpected dependency: ${name}`);
    };
    new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', 'process', source)(
      local, module, module.exports, clock?.setTimeout ?? setTimeout, clock?.clearTimeout ?? clearTimeout, { env: environment });
    return module.exports;
  };
}
class Driver {
  constructor(file) { this.db = new DatabaseSync(file); this.before = null; this.closed = false; }
  async execAsync(sql) { await this.before?.('exec', sql, []); this.db.exec(sql); }
  async runAsync(sql, ...params) { await this.before?.('run', sql, params); return this.db.prepare(sql).run(...params); }
  async getFirstAsync(sql, ...params) { await this.before?.('first', sql, params); return this.db.prepare(sql).get(...params) ?? null; }
  async getAllAsync(sql, ...params) { await this.before?.('all', sql, params); return this.db.prepare(sql).all(...params); }
  async closeAsync() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purama-controller-'));
  const filename = path.join(directory, 'account.db');
  const clock = timers();
  const load = loader({ clock, ...options });
  const { SmaranaStore } = load('lib/smarana-store.ts');
  const stores = [];
  const openStore = async () => {
    const db = new Driver(filename);
    const store = await SmaranaStore.open(db, { ownerId: OWNER, newId: uuid, now: () => TIME });
    stores.push(store);
    return { db, store };
  };
  t.after(async () => { for (const store of stores) await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { ...(await openStore()), openStore, clock, load };
}
function remote(payload, extra = {}) {
  return { schemaVersion: 1, ownerId: OWNER, resourceId: RESOURCE, revision: 1, cursor: '1',
    tombstone: false, payload, updatedAt: TIME, ...extra };
}
function page(record, extra = {}) { return { ownerId: OWNER, records: [record], cursor: record.cursor, hasMore: false, ...extra }; }
function ack(mutation, cursor = '1') {
  return { status: 'applied', ownerId: mutation.ownerId, resourceId: mutation.resourceId, mutationId: mutation.mutationId,
    baseRevision: mutation.baseRevision, revision: mutation.baseRevision + 1, cursor, updatedAt: TIME, replayed: false };
}
module.exports = { OWNER, OTHER, RESOURCE, TIME, uuid, message, snapshot, tick, deferred, timers, loader, fixture, remote, page, ack };
