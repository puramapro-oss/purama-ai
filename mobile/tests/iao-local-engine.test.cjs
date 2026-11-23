// Real engine controller; llama.rn, hardware and pack are explicit fake boundaries.
// These tests do not claim native execution, model quality or device qualification.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const project = path.resolve(__dirname, '..');

function loadEngine() {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = name => {
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
      if (name.startsWith('@noble/hashes/')) return require(name);
      throw new Error(`Unexpected native/network import: ${name}`);
    };
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: file })(localRequire, module, module.exports);
    return module.exports;
  }
  return load(path.join(project, 'lib/iao-local-engine.ts'));
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const api = loadEngine();
  const env = { api, imports: 0, hardwareCalls: 0, init: [], completions: [], formats: [], tokens: [],
    stops: 0, releases: 0, prepares: 0, inspections: 0, requires: 0, nativeLimits: [], nativeLogging: [],
    lastCallback: null, smoke: null, state: { status: options.absent ? 'absent' : 'ready', progress: 0, completedBytes: 0, totalBytes: 1 } };
  const ready = { packId: 'fake-pack', modelUri: 'file:///private/purama/model.gguf',
    licenseUri: 'file:///private/purama/LICENSE', modelVersion: 'fake-native-test-model' };
  const nativeResult = overrides => ({ text: '<think>private native reasoning</think>Bonjour', content: 'Bonjour',
    tokens_predicted: 2, interrupted: false, truncated: false, context_full: false, stopped_limit: 0, ...overrides });
  env.result = nativeResult;
  const context = {
    gpu: false,
    isJinjaSupported: () => true,
    async getFormattedChat(messages, _template, parameters) {
      env.formats.push({ messages: structuredClone(messages), parameters });
      return { type: 'jinja', prompt: JSON.stringify(messages), has_media: false, chat_format: 1,
        generation_prompt: 'assistant', chat_parser: 'synthetic-parser', additional_stops: ['<stop>'] };
    },
    async tokenize(prompt) {
      const length = options.tokenCount?.(JSON.parse(prompt)) ?? 20;
      return { tokens: Array(length).fill(1), has_media: false };
    },
    async completion(parameters, callback) {
      env.completions.push(parameters); env.lastCallback = callback;
      if (options.complete) return options.complete(parameters, callback, env);
      callback?.({ token: '<think>private', reasoning_content: 'private' });
      callback?.({ content: 'Bon', token: 'raw token must not be shown' });
      callback?.({ content: 'Bonjour', reasoning_content: 'private' });
      return nativeResult();
    },
    async stopCompletion() { env.stops += 1; return options.stop?.(env); },
    async release() { env.releases += 1; return options.release?.(env); },
  };
  env.context = context;
  const native = {
    async initLlama(parameters) {
      env.init.push(parameters);
      return options.init ? options.init(parameters, context, env) : context;
    },
    async setContextLimit(limit) { env.nativeLimits.push(limit); },
    async toggleNativeLog(enabled) { env.nativeLogging.push(enabled); },
  };
  const dependencies = {
    async loadNative() { env.imports += 1; if (options.nativeUnavailable) throw new Error('Synthetic missing module'); return native; },
    async hardware() { env.hardwareCalls += 1; return { supported: options.supported ?? true,
      totalMemory: options.totalMemory ?? 8 * 1024 ** 3 }; },
    packFactory(smokeTest) {
      env.smoke = smokeTest;
      return {
        getState: () => env.state, subscribe: () => () => {},
        async inspect(signal) { env.inspections += 1; await options.inspect?.(signal, env); return env.state; },
        async prepare(signal) {
          env.prepares += 1; env.state = { ...env.state, status: 'verifying' };
          await smokeTest('file:///private/purama.partial/model.gguf', signal);
          env.state = { ...env.state, status: 'ready', progress: 1 };
          return ready;
        },
        async requireReady(signal) {
          env.requires += 1;
          await options.requireReady?.(signal, env);
          if (env.state.status === 'absent') throw new api.IaoLocalError('pack-absent');
          return ready;
        },
      };
    },
  };
  env.create = () => api.createIaoLocalEngine(dependencies);
  env.engine = env.create();
  return env;
}

const messages = () => [{ role: 'system', content: 'Tu es PURAMA.' }, { role: 'user', content: 'Bonjour' }];

test('engine and singleton construction do not import native code, touch hardware or prepare a pack', () => {
  const env = fixture({ absent: true });
  assert.equal(env.engine.getState().status, 'absent');
  assert.equal(env.imports, 0); assert.equal(env.hardwareCalls, 0); assert.equal(env.prepares, 0);
  assert.equal(env.api.getIaoLocalEngine(), env.api.getIaoLocalEngine());
});

test('generation uses one local CPU context and parsed visible content, then releases it', async () => {
  const env = fixture(); const visible = [];
  const result = await env.engine.complete(messages(), { onToken: text => visible.push(text) });
  assert.equal(result.text, 'Bonjour'); assert.deepEqual(visible, ['Bon', 'Bonjour']);
  assert.equal(result.modelVersion, 'fake-native-test-model'); assert.equal(result.finishReason, 'stop');
  assert.equal(result.contextTruncated, false); assert.equal(result.tokensGenerated, 2);
  assert.equal(env.init.length, 1); assert.equal(env.releases, 1); assert.equal(env.prepares, 0);
  assert.equal(env.init[0].model, 'file:///private/purama/model.gguf');
  assert.equal(env.init[0].n_gpu_layers, 0); assert.equal(env.init[0].n_parallel, 1);
  assert.deepEqual(env.init[0].devices, ['CPU']);
  assert.equal(env.init[0].ctx_shift, false); assert.equal(env.init[0].use_mlock, false);
  assert.deepEqual(env.nativeLimits, [1]); assert.deepEqual(env.nativeLogging, [false]);
  assert.equal(env.completions[0].messages, undefined, 'completion must not format asynchronously a second time');
  assert.equal(env.completions[0].chat_parser, 'synthetic-parser');
  assert.equal(env.completions[0].enable_thinking, false);
});

test('late native callbacks cannot publish after a completion has settled', async () => {
  const env = fixture(); const visible = [];
  await env.engine.complete(messages(), { onToken: text => visible.push(text) });
  env.lastCallback({ content: 'late stale content' });
  assert.deepEqual(visible, ['Bon', 'Bonjour']);
});

test('generation on an absent pack is local-only and never calls preparation or cloud', async () => {
  const env = fixture({ absent: true });
  await assert.rejects(env.engine.complete(messages()), { code: 'pack-absent' });
  assert.equal(env.prepares, 0); assert.equal(env.imports, 0); assert.equal(env.init.length, 0);
});

test('explicit preparation verifies native availability then performs a smoke generation before ready', async () => {
  const started = deferred(); const finish = deferred();
  const env = fixture({ absent: true, complete: async (_parameters, _callback, current) => {
    started.resolve(); await finish.promise; return current.result();
  } });
  const preparation = env.engine.prepare(); await started.promise;
  assert.equal(env.engine.getState().status, 'verifying');
  assert.ok(env.init[0].model.includes('.partial/'));
  assert.equal(env.completions[0].n_predict, 16);
  finish.resolve(); await preparation;
  assert.equal(env.engine.getState().status, 'ready'); assert.equal(env.releases, 1);
});

test('missing native runtime and insufficient admission memory reject before downloading', async () => {
  const missing = fixture({ absent: true, nativeUnavailable: true });
  await assert.rejects(missing.engine.prepare(), { code: 'unsupported' });
  assert.equal(missing.prepares, 0);
  const small = fixture({ absent: true, totalMemory: 1024 ** 3 });
  await assert.rejects(small.engine.prepare(), { code: 'memory' });
  assert.equal(small.prepares, 0); assert.equal(small.imports, 0);
});

test('web cannot prepare a native pack; no isDevice restriction is used for a qualified emulator', async () => {
  const web = fixture({ supported: false });
  await assert.rejects(web.engine.prepare(), { code: 'unsupported' });
  assert.equal(web.imports, 0); assert.equal(web.prepares, 0);
  const supported = fixture(); await supported.engine.complete(messages());
  assert.equal(supported.releases, 1);
});

test('cancel stops completion, contains a rejected stop, ignores late output and retains process lease until cleanup', async () => {
  const started = deferred(); const finish = deferred();
  const env = fixture({ complete: async (_parameters, _callback, current) => {
    started.resolve(); await finish.promise; return current.result();
  }, stop: async () => { throw new Error('Synthetic completion already settled'); } });
  const visible = []; const controller = new AbortController();
  const operation = env.engine.complete(messages(), { signal: controller.signal, onToken: text => visible.push(text) });
  await started.promise; controller.abort();
  await assert.rejects(operation, { code: 'aborted' });
  env.lastCallback({ content: 'late cancelled content' });
  assert.deepEqual(visible, []);
  await assert.rejects(env.create().complete(messages()), { code: 'busy' });
  finish.resolve(); await env.engine.release();
  assert.equal(env.stops, 1); assert.equal(env.releases, 1);
  await env.engine.complete(messages()); assert.equal(env.releases, 2);
});

test('cancel during uninterruptible native load returns promptly and releases the eventual context without generating', async () => {
  const started = deferred(); const loaded = deferred();
  const env = fixture({ init: async (_parameters, context) => { started.resolve(); await loaded.promise; return context; } });
  const operation = env.engine.complete(messages()); await started.promise;
  env.engine.cancel(); await assert.rejects(operation, { code: 'aborted' });
  assert.equal(env.completions.length, 0);
  await assert.rejects(env.create().complete(messages()), { code: 'busy' });
  loaded.resolve(); await env.engine.release();
  assert.equal(env.releases, 1); assert.equal(env.completions.length, 0);
});

test('pre-aborted requests reject without acquiring native resources', async () => {
  const env = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(env.engine.complete(messages(), { signal: controller.signal }), { code: 'aborted' });
  assert.equal(env.init.length, 0); assert.equal(env.hardwareCalls, 0);
});

test('two controllers cannot initialize simultaneous native engines', async () => {
  const started = deferred(); const finish = deferred();
  const env = fixture({ complete: async (_parameters, _callback, current) => {
    started.resolve(); await finish.promise; return current.result();
  } });
  const first = env.engine.complete(messages()); await started.promise;
  await assert.rejects(env.create().complete(messages()), { code: 'busy' });
  assert.equal(env.init.length, 1); finish.resolve(); await first;
});

test('each completed request releases its context so a later conversation cannot reuse native KV state', async () => {
  const env = fixture(); await env.engine.complete(messages()); await env.engine.complete(messages());
  assert.equal(env.init.length, 2); assert.equal(env.releases, 2); assert.equal(env.imports, 1);
});

test('history window trims complete old turns and preserves system/current message plus durable input array', async () => {
  const env = fixture({ tokenCount: input => input.length > 2 ? 1800 : 20 });
  const input = [{ role: 'system', content: 'PURAMA' }, { role: 'user', content: 'Ancienne question' },
    { role: 'assistant', content: 'Ancienne réponse' }, { role: 'user', content: 'Question actuelle' }];
  const result = await env.engine.complete(input);
  assert.equal(result.contextTruncated, true); assert.equal(result.omittedMessages, 2);
  assert.deepEqual(env.formats.at(-1).messages, [input[0], input[3]]);
  assert.equal(input.length, 4); assert.equal(env.releases, 1);
});

test('an oversized current prompt is rejected after actual tokenization without silent prompt truncation', async () => {
  const env = fixture({ tokenCount: () => 2000 });
  await assert.rejects(env.engine.complete(messages()), { code: 'context-limit' });
  assert.equal(env.completions.length, 0); assert.equal(env.releases, 1);
});

test('invalid roles, empty current content and excessive message counts never initialize native code', async () => {
  const env = fixture();
  for (const input of [[], [{ role: 'assistant', content: 'answer' }], [{ role: 'tool', content: 'tool' }],
    [{ role: 'user', content: ' ' }], Array(129).fill({ role: 'user', content: 'x' })]) {
    await assert.rejects(env.engine.complete(input), { code: 'invalid-message' });
  }
  assert.equal(env.init.length, 0); assert.equal(env.hardwareCalls, 0);
});

test('mutable caller messages are snapshotted before native initialization awaits', async () => {
  const started = deferred(); const loaded = deferred();
  const env = fixture({ init: async (_parameters, context) => { started.resolve(); await loaded.promise; return context; } });
  const input = messages(); const operation = env.engine.complete(input); await started.promise;
  input[1].content = 'Changed after request admission'; loaded.resolve(); await operation;
  assert.equal(env.formats[0].messages[1].content, 'Bonjour');
});

test('raw reasoning is never substituted when parsed visible output is empty', async () => {
  const env = fixture({ complete: async (_parameters, _callback, current) => current.result({ content: '' }) });
  await assert.rejects(env.engine.complete(messages()), { code: 'invalid-output' });
  assert.equal(env.releases, 1);
});

test('native release failure blocks any new context until application restart', async () => {
  const env = fixture({ release: async () => { throw new Error('Synthetic release failure'); } });
  await assert.rejects(env.engine.complete(messages()), { code: 'restart-required' });
  await assert.rejects(env.create().complete(messages()), { code: 'restart-required' });
  assert.equal(env.init.length, 1); assert.equal(env.releases, 1);
});

test('a failed native release retains restart priority over an earlier generation failure', async () => {
  const env = fixture({ complete: async () => { throw new Error('Synthetic generation failure'); },
    release: async () => { throw new Error('Synthetic release failure'); } });
  await assert.rejects(env.engine.complete(messages()), { code: 'restart-required' });
  await assert.rejects(env.create().complete(messages()), { code: 'restart-required' });
  assert.equal(env.init.length, 1); assert.equal(env.releases, 1);
});

test('CPU qualification refuses an unexpected native GPU backend and still releases the context', async () => {
  const env = fixture(); env.context.gpu = true;
  await assert.rejects(env.engine.complete(messages()), { code: 'native' });
  assert.equal(env.completions.length, 0); assert.equal(env.releases, 1);
});

// Only the clock and native/file boundaries are synthetic. These assertions
// exercise the real controller deadlines, cancellation and process lease.
const flush = () => new Promise(resolve => setImmediate(resolve));

test('cold inspection can finish a verified pack after the generation deadline without downloading', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred(); let verificationSignal; let settled = false;
  const env = fixture({ inspect: async signal => { verificationSignal = signal; await pending.promise; } });
  const operation = env.engine.inspect().finally(() => { settled = true; });
  operation.catch(() => {});
  try {
    await flush(); t.mock.timers.tick(180_001); await flush();
    assert.equal(settled, false, 'cold verification must not spend the generation-only deadline');
    assert.equal(verificationSignal.aborted, false);
    t.mock.timers.tick(119_999); pending.resolve();
    assert.equal((await operation).status, 'ready');
    assert.equal(env.prepares, 0); assert.equal(env.completions.length, 0);
  } finally { pending.resolve(); await env.engine.release(); }
});

test('direct completion gives cold verification its own budget and preserves the full bounded inference deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const verified = deferred(); const generated = deferred(); let settled = false;
  const env = fixture({ requireReady: async () => verified.promise,
    complete: async (_parameters, _callback, current) => { await generated.promise; return current.result(); } });
  const operation = env.engine.complete(messages()).finally(() => { settled = true; });
  operation.catch(() => {});
  try {
    await flush(); t.mock.timers.tick(300_000); await flush();
    assert.equal(settled, false); assert.equal(env.init.length, 0);
    verified.resolve(); await flush();
    assert.equal(env.completions.length, 1);
    // Cross the original verification deadline after the phase transition: the
    // inference is still bounded by exactly 180 seconds from its own admission.
    t.mock.timers.tick(179_999); await flush(); assert.equal(settled, false);
    t.mock.timers.tick(1); await assert.rejects(operation, { code: 'timeout' });
    await assert.rejects(env.create().complete(messages()), { code: 'busy' });
    assert.equal(env.stops, 1); assert.equal(env.prepares, 0);
    generated.resolve(); await env.engine.release();
    assert.equal(env.releases, 1);
    await env.engine.complete(messages()); assert.equal(env.releases, 2);
  } finally { verified.resolve(); generated.resolve(); await env.engine.release(); }
});

test('cold inspection remains bounded and retains its lease until verification has actually stopped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred(); let verificationSignal;
  const env = fixture({ inspect: async signal => { verificationSignal = signal; await pending.promise; } });
  const operation = env.engine.inspect(); operation.catch(() => {});
  try {
    await flush(); t.mock.timers.tick(600_000);
    await assert.rejects(operation, { code: 'timeout' });
    assert.equal(verificationSignal.aborted, true);
    await assert.rejects(env.create().complete(messages()), { code: 'busy' });
    pending.resolve(); await env.engine.release();
    await env.engine.complete(messages()); assert.equal(env.completions.length, 1);
  } finally { pending.resolve(); await env.engine.release(); }
});

test('cancelling revalidation returns promptly, fences other callers, and permits retry after cleanup', async () => {
  const pending = deferred(); let verificationSignal;
  const env = fixture({ requireReady: async signal => { verificationSignal = signal; await pending.promise; } });
  const operation = env.engine.complete(messages()); operation.catch(() => {});
  await flush(); env.engine.cancel();
  await assert.rejects(operation, { code: 'aborted' });
  assert.equal(verificationSignal.aborted, true); assert.equal(env.init.length, 0);
  await assert.rejects(env.create().complete(messages()), { code: 'busy' });
  pending.resolve(); await env.engine.release();
  assert.equal(env.init.length, 0, 'a late verification cannot revive an aborted completion');
  await env.engine.complete(messages()); assert.equal(env.completions.length, 1);
});

test('an expired revalidation cannot revive generation when its file operation settles late', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  const env = fixture({ requireReady: async () => pending.promise });
  const operation = env.engine.complete(messages()); operation.catch(() => {});
  await flush(); t.mock.timers.tick(600_000);
  await assert.rejects(operation, { code: 'timeout' });
  pending.resolve(); await env.engine.release();
  assert.equal(env.init.length, 0); assert.equal(env.prepares, 0);
  await env.engine.complete(messages()); assert.equal(env.completions.length, 1);
});

test('verification integrity failure never resets the deadline into native inference or repairs online', async () => {
  const env = fixture({ requireReady: async (_signal, current) => { throw new current.api.IaoLocalError('integrity'); } });
  await assert.rejects(env.engine.complete(messages()), { code: 'integrity' });
  assert.equal(env.init.length, 0); assert.equal(env.prepares, 0);
  assert.equal((await env.engine.inspect()).status, 'ready', 'the failed operation released its process lease');
});

test('late timer delivery cannot revive verification that has exceeded its monotonic deadline', async t => {
  let clock = performance.now();
  t.mock.method(performance, 'now', () => clock);
  const pending = deferred();
  const env = fixture({ requireReady: async () => pending.promise });
  const operation = env.engine.complete(messages()); operation.catch(() => {});
  await flush();
  // Simulate a delayed event loop/native resolution without delivering the
  // timer callback: the phase transition itself must check the absolute time.
  clock += 600_001; pending.resolve();
  await assert.rejects(operation, { code: 'timeout' });
  await env.engine.release();
  assert.equal(env.init.length, 0); assert.equal(env.prepares, 0);
});
