// Real controller + real temporary filesystem + real incremental SHA-256.
// Network transport and native smoke generation are explicit fake boundaries.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

const project = path.resolve(__dirname, '..');
function modules(overrides = {}) {
  const cache = new Map();
  function load(relative) {
    const file = path.resolve(project, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = name => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name.startsWith('.')) return load(path.relative(project, path.resolve(path.dirname(file), name + '.ts')));
      if (name.startsWith('@noble/hashes/')) return require(name);
      throw new Error(`Unreviewed dependency: ${name}`);
    };
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: file })(localRequire, module, module.exports);
    return module.exports;
  }
  return load('lib/iao-local-pack.ts');
}

function fixture(t, options = {}) {
  const api = modules(options.modules);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purama-iao-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(1024 * 1024 + 17, 37)]);
  const license = Buffer.from('Synthetic licence fixture; not a real model or licence grant.');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = {
    schema: 1, id: 'purama-synthetic-pack', repository: 'tests/synthetic', revision: 'a'.repeat(40),
    runtime: 'fake-native-boundary', license: 'test-only', minimumMemoryBytes: 0,
    storageReserveBytes: 1024, contextTokens: 2048, maximumOutputTokens: 384, smokeVersion: 'fixture-v1',
    model: { name: 'model.gguf', bytes: model.length, sha256: hash(model), url: 'https://example.invalid/model' },
    licenseFile: { name: 'LICENSE', bytes: license.length, sha256: hash(license), url: 'https://example.invalid/license' },
  };
  const contents = new Map([[manifest.model.url, model], [manifest.licenseFile.url, license]]);
  const env = { root, api, model, license, manifest, downloads: [], smoke: [], reads: [], handles: 0,
    moves: [], state: [], freeBytes: 1e12, yields: 0, contents };
  const resolve = name => path.join(root, name);
  const storage = {
    ensureRoot() {}, availableBytes: () => env.freeBytes,
    directoryExists: name => fs.existsSync(resolve(name)),
    createDirectory: name => fs.mkdirSync(resolve(name)),
    removeDirectory: name => fs.rmSync(resolve(name), { force: true, recursive: true }),
    moveDirectory(from, to) { env.moves.push([from, to]); fs.renameSync(resolve(from), resolve(to)); },
    stat(name) {
      try { const info = fs.statSync(resolve(name)); return { exists: true, bytes: info.size, modified: info.mtimeMs }; }
      catch (error) { if (error.code === 'ENOENT') return { exists: false, bytes: 0, modified: null }; throw error; }
    },
    openRead(name) {
      const fd = fs.openSync(resolve(name), 'r'); let offset = 0; env.handles += 1;
      return { readBytes(length) { env.reads.push(length); const buffer = Buffer.alloc(length);
        const count = fs.readSync(fd, buffer, 0, length, offset); offset += count; return new Uint8Array(buffer.subarray(0, count)); },
      close() { fs.closeSync(fd); env.handles -= 1; } };
    },
    openWrite(name) {
      const fd = fs.openSync(resolve(name), 'wx'); env.handles += 1;
      return { writeBytes(bytes) { fs.writeSync(fd, bytes); }, close() { fs.closeSync(fd); env.handles -= 1; } };
    },
    readText(name, limit) {
      if (!fs.existsSync(resolve(name)) || fs.statSync(resolve(name)).size > limit) throw new api.IaoLocalError('integrity');
      return fs.readFileSync(resolve(name), 'utf8');
    },
    writeText(name, text) { fs.writeFileSync(resolve(name), text, { flag: 'wx' }); },
    uri: name => pathToFileURL(resolve(name)).href,
  };
  env.storage = storage;
  env.smokeTest = async (uri, signal) => {
    api.assertIaoLocalActive(signal); env.smoke.push(uri);
    assert.deepEqual(fs.readFileSync(new URL(uri)), model);
    await options.smokeTest?.(uri, signal, env);
  };
  env.download = async (asset, writer, signal, onBytes) => {
    env.downloads.push(asset.url);
    const bytes = contents.get(asset.url);
    for (let offset = 0; offset < bytes.length; offset += 97 * 1024) {
      api.assertIaoLocalActive(signal);
      const chunk = bytes.subarray(offset, offset + 97 * 1024);
      writer.writeBytes(chunk); onBytes(Math.min(bytes.length, offset + chunk.length));
      await options.afterDownloadChunk?.(env, signal);
    }
  };
  env.create = (extra = {}) => api.createIaoLocalPack({ manifest, storage: async () => storage,
    download: env.download, smokeTest: env.smokeTest,
    yieldToUI: async () => { env.yields += 1; await options.afterYield?.(env); }, ...extra });
  env.pack = env.create(); env.pack.subscribe(state => env.state.push(state));
  return env;
}

test('construction and absent inspection are local, passive and do not fetch or run a fake smoke', async t => {
  const env = fixture(t);
  assert.equal(env.pack.getState().status, 'absent');
  assert.deepEqual(env.downloads, []); assert.deepEqual(env.smoke, []);
  assert.equal((await env.pack.inspect()).status, 'absent');
  await assert.rejects(env.pack.requireReady(), { code: 'pack-absent' });
  assert.deepEqual(env.downloads, []); assert.deepEqual(env.smoke, []);
});

test('prepare hashes bounded blocks, keeps a full licence, smoke-tests then promotes one directory', async t => {
  let env;
  env = fixture(t, { smokeTest: async uri => {
    assert.ok(uri.includes('.partial/'));
    assert.equal(env.pack.getState().status, 'verifying');
    assert.equal(env.pack.getState().phase, 'local-test');
    assert.equal(env.storage.directoryExists(env.manifest.id), false);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(new URL(uri).pathname), 'LICENSE')), env.license);
  } });
  const result = await env.pack.prepare();
  assert.equal(env.pack.getState().status, 'ready');
  assert.ok(result.modelUri.endsWith('/purama-synthetic-pack/model.gguf'));
  assert.ok(result.licenseUri.endsWith('/LICENSE'));
  assert.ok(result.modelVersion.includes(env.manifest.model.sha256));
  assert.deepEqual(env.moves, [[env.manifest.id + '.partial', env.manifest.id]]);
  assert.equal(env.storage.directoryExists(env.manifest.id + '.partial'), false);
  assert.ok(env.reads.length > 4); assert.ok(Math.max(...env.reads) <= 256 * 1024);
  assert.equal(env.handles, 0); assert.ok(env.yields >= env.reads.length);
  const reads = env.reads.length;
  assert.deepEqual(await env.pack.requireReady(), result);
  assert.equal(env.reads.length, reads, 'same-process verified private files use their checked stat fingerprint');
  assert.equal(env.downloads.length, 2); assert.equal(env.smoke.length, 1);
});

test('a new process controller rechecks provenance, hashes and real-smoke boundary without downloading', async t => {
  const env = fixture(t); await env.pack.prepare();
  const firstReads = env.reads.length;
  const restarted = env.create();
  assert.equal((await restarted.inspect()).status, 'ready');
  assert.ok(env.reads.length > firstReads);
  assert.equal(env.smoke.length, 2); assert.equal(env.downloads.length, 2);
});

test('a corrupt model never reaches smoke or ready and leaves no trusted or partial pack', async t => {
  const env = fixture(t); env.contents.set(env.manifest.model.url, Buffer.alloc(env.model.length, 0));
  await assert.rejects(env.pack.prepare(), { code: 'integrity' });
  assert.equal(env.pack.getState().status, 'error');
  assert.equal(env.smoke.length, 0); assert.equal(env.moves.length, 0); assert.equal(env.handles, 0);
  assert.equal(env.storage.directoryExists(env.manifest.id), false);
  assert.equal(env.storage.directoryExists(env.manifest.id + '.partial'), false);
});

test('same-length corruption with valid GGUF magic is rejected by SHA-256', async t => {
  const env = fixture(t); const corrupt = Buffer.from(env.model); corrupt[corrupt.length - 1] ^= 1;
  env.contents.set(env.manifest.model.url, corrupt);
  await assert.rejects(env.pack.prepare(), { code: 'integrity' });
  assert.equal(env.smoke.length, 0); assert.equal(env.handles, 0);
});

test('a corrupt licence is rejected before native smoke and atomic promotion', async t => {
  const env = fixture(t); env.contents.set(env.manifest.licenseFile.url, Buffer.alloc(env.license.length, 88));
  await assert.rejects(env.pack.prepare(), { code: 'integrity' });
  assert.equal(env.smoke.length, 0); assert.equal(env.moves.length, 0); assert.equal(env.handles, 0);
});

test('cancellation during download closes handles, removes staging, and has no ready receipt', async t => {
  const controller = new AbortController();
  const env = fixture(t, { afterDownloadChunk: () => controller.abort() });
  await assert.rejects(env.pack.prepare(controller.signal), { code: 'aborted' });
  assert.equal(env.handles, 0); assert.equal(env.smoke.length, 0); assert.equal(env.moves.length, 0);
  assert.equal(env.storage.directoryExists(env.manifest.id + '.partial'), false);
});

test('cancellation while hashing is observed between bounded reads and closes the read handle', async t => {
  const controller = new AbortController();
  const env = fixture(t, { afterYield: () => controller.abort() });
  await assert.rejects(env.pack.prepare(controller.signal), { code: 'aborted' });
  assert.equal(env.reads.length, 1); assert.equal(env.handles, 0); assert.equal(env.smoke.length, 0);
  assert.equal(env.storage.directoryExists(env.manifest.id + '.partial'), false);
});

test('native smoke failure does not mark a hash-valid pack as ready', async t => {
  const env = fixture(t, { smokeTest: async (_uri, _signal, current) => { throw new current.api.IaoLocalError('native'); } });
  await assert.rejects(env.pack.prepare(), { code: 'native' });
  assert.equal(env.moves.length, 0); assert.equal(env.pack.getState().status, 'error');
  assert.equal(env.storage.directoryExists(env.manifest.id), false);
});

test('missing or changed provenance blocks offline use; only explicit prepare repairs it', async t => {
  const env = fixture(t); await env.pack.prepare();
  fs.writeFileSync(path.join(env.root, env.manifest.id, 'prepared.json'), '{}');
  const restarted = env.create();
  await assert.rejects(restarted.requireReady(), { code: 'integrity' });
  assert.equal(env.downloads.length, 2);
  await restarted.prepare();
  assert.equal(env.downloads.length, 4); assert.equal(restarted.getState().status, 'ready');
});

test('file mutation in a running process invalidates the verification cache without network fallback', async t => {
  const env = fixture(t); await env.pack.prepare();
  fs.appendFileSync(path.join(env.root, env.manifest.id, 'model.gguf'), 'changed');
  await assert.rejects(env.pack.requireReady(), { code: 'integrity' });
  assert.equal(env.downloads.length, 2); assert.equal(env.pack.getState().status, 'error');
});

test('insufficient storage rejects before fetching and stale staging is safely removed', async t => {
  const env = fixture(t); env.freeBytes = env.model.length;
  env.storage.createDirectory(env.manifest.id + '.partial');
  await assert.rejects(env.pack.prepare(), { code: 'storage' });
  assert.equal(env.downloads.length, 0); assert.equal(env.smoke.length, 0);
  assert.equal(env.storage.directoryExists(env.manifest.id + '.partial'), false);
});

test('observers cannot interrupt promotion or make a completed pack disappear', async t => {
  const env = fixture(t); env.pack.subscribe(() => { throw new Error('UI observer failed'); });
  await env.pack.prepare(undefined, () => { throw new Error('UI observer failed'); });
  assert.equal(env.pack.getState().status, 'ready'); assert.equal(env.moves.length, 1);
});

test('a failed same-parent promotion never reports ready', async t => {
  const env = fixture(t); env.storage.moveDirectory = () => { throw new Error('synthetic filesystem failure'); };
  await assert.rejects(env.pack.prepare(), { code: 'storage' });
  assert.equal(env.pack.getState().status, 'error');
  assert.equal(env.storage.directoryExists(env.manifest.id + '.partial'), false);
});

test('production streaming download consumes bounded bytes, passes abort signal, and never buffers a whole model', async t => {
  let env; const fetches = [];
  env = fixture(t, { modules: { 'expo/fetch': { fetch: async (url, options) => {
    fetches.push({ url, options }); const bytes = env.contents.get(url); let sent = false;
    return { status: 200, headers: new Headers({ 'content-length': String(bytes.length) }),
      body: new ReadableStream({ pull(controller) { if (sent) controller.close(); else { sent = true; controller.enqueue(new Uint8Array(bytes)); } } }) };
  } } } });
  const pack = env.create({ download: undefined });
  await pack.prepare();
  assert.equal(fetches.length, 2); assert.equal(pack.getState().status, 'ready');
  assert.equal(fetches[0].options.credentials, 'omit'); assert.ok(fetches[0].options.signal instanceof AbortSignal);
  assert.equal(env.handles, 0);
});

test('production streaming transport rejects oversized or incorrectly declared bodies before trust', async t => {
  const env = fixture(t, { modules: { 'expo/fetch': { fetch: async () => ({ status: 200,
    headers: new Headers({ 'content-length': '999999999' }), body: new ReadableStream({ start(controller) { controller.close(); } }) }) } } });
  await assert.rejects(env.create({ download: undefined }).prepare(), { code: 'download' });
  assert.equal(env.smoke.length, 0); assert.equal(env.handles, 0); assert.equal(env.moves.length, 0);
});

test('ready waits for the asynchronous native rename acknowledgement', async t => {
  const env = fixture(t); let promote; let began;
  const started = new Promise(resolve => { began = resolve; });
  const pending = new Promise(resolve => { promote = resolve; });
  const move = env.storage.moveDirectory;
  env.storage.moveDirectory = async (from, to) => { began(); await pending; move(from, to); };
  const preparation = env.pack.prepare(); await started;
  assert.equal(env.pack.getState().status, 'verifying');
  assert.equal(env.storage.directoryExists(env.manifest.id), false);
  promote(); await preparation;
  assert.equal(env.pack.getState().status, 'ready');
});
