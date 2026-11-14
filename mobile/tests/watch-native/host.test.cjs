const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const base = path.resolve(__dirname, '../../modules/purama-accessibility-watch');
const cache = new Map();
function load(name) {
  const file = path.resolve(base, name.endsWith('.ts') ? name : name + '.ts');
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} }; cache.set(file, module.exports);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', js)(request => load(request), module, module.exports);
  return module.exports;
}
const { createWatchNativeApi } = load('host');
const { serializeSend, serializeHandshake, checkedAuthorization, WATCH_KINDS } = load('contract');
const event = { version: 1, eventId: 'event-1', source: 'microphone', kind: 'speech', observedAt: 1000, expiresAt: 6000, assessment: 'provisional' };
const request = () => ({ version: 1, type: 'one-watch-send', requestId: 'request-1', envelope: { version: 1, type: 'one-awareness-delivery', sessionId: 'session-1', deviceId: 'device-1', deliveryId: 'delivery-1', event: { ...event }, remainingTtlMs: 5000 } });
function softwareModule() {
  const calls = [], listeners = new Map();
  const native = {
    async discover() { calls.push(['discover']); return []; },
    async authorize(value) { calls.push(['authorize', JSON.parse(value)]); },
    async clearAuthorization() { calls.push(['clear']); }, challenge() { return 'software-test-only'; }, monotonicTime() { return 1000; },
    async open(value) { calls.push(['open', JSON.parse(value)]); return '{"version":1,"type":"one-watch-ready","requestId":"request-1","binding":{"version":1,"sessionId":"session-1","deviceId":"device-1","platform":"watchos"}}'; },
    async send(value) { calls.push(['send', JSON.parse(value)]); },
    async cancel(request, delivery) { calls.push(['cancel', request, delivery]); },
    async close(request) { calls.push(['close', request]); },
    addListener(name, callback) { listeners.set(name, callback); return { remove() { listeners.delete(name); } }; },
  };
  return { native, calls, listeners };
}
test('unavailable native module stays disconnected and does not discover or fabricate a companion', () => {
  const api = createWatchNativeApi(null); assert.equal(api.createNativeWatchHost(), undefined);
  assert.throws(api.discoverWatches, /native-unavailable/); const status = []; api.subscribeWatchStatus(s => status.push(s));
  assert.deepEqual(status, [{ state: 'unavailable', reason: 'native-unavailable' }]);
});
test('constructed facade has exactly the five ONE own data fields and no automatic calls', () => {
  const { native, calls } = softwareModule(); const host = createWatchNativeApi(native).createNativeWatchHost();
  assert.deepEqual(Object.keys(host).sort(), ['close', 'handshake', 'send', 'subscribe', 'version']); assert.ok(Object.isFrozen(host)); assert.deepEqual(calls, []);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(host))) assert.ok('value' in descriptor);
});
test('authorization requires an explicit nonempty, unique allowlist and strips no unknown fields', () => {
  for (const bad of [{ deviceId: 'd', allowedKinds: [] }, { deviceId: 'd', allowedKinds: ['speech', 'speech'] }, { deviceId: 'd', allowedKinds: ['cross-road'] }, { deviceId: 'd', allowedKinds: ['speech'], trust: true }]) assert.throws(() => checkedAuthorization(bad));
  const good = checkedAuthorization({ deviceId: 'd', allowedKinds: WATCH_KINDS }); assert.equal(good.allowedKinds.length, 9); assert.ok(Object.isFrozen(good.allowedKinds));
});
for (const [name, change] of [
  ['simulation', r => r.envelope.event.source = 'simulation'], ['arbitrary direction', r => r.envelope.event.direction = 'cross now'],
  ['source/kind mismatch', r => r.envelope.event.kind = 'vehicle'], ['unknown kind', r => r.envelope.event.kind = 'danger'],
  ['extra authentication field', r => r.authenticated = true], ['zero budget', r => r.envelope.remainingTtlMs = 0],
  ['unbounded budget', r => r.envelope.remainingTtlMs = 60001], ['fractional budget', r => r.envelope.remainingTtlMs = 2.5],
  ['invalid timestamps', r => r.envelope.event.observedAt = -1], ['reversed timestamp', r => r.envelope.event.expiresAt = 999],
  ['excessive lifetime', r => r.envelope.event.expiresAt = 61001], ['unsafe timestamp', r => r.envelope.event.expiresAt = Number.MAX_SAFE_INTEGER + 1],
  ['wrong assessment', r => r.envelope.event.assessment = 'certain'], ['oversized identifier', r => r.envelope.deliveryId = 'x'.repeat(97)],
  ['boolean version', r => r.envelope.event.version = true], ['wrong wire type', r => r.type = 'send-anything'],
]) test('wire refuses ' + name, () => { const r = request(); change(r); assert.throws(() => serializeSend(r)); });
test('valid events are snapshotted; native serialization never invokes getters', () => {
  const r = request(), sent = JSON.parse(serializeSend(r).json); r.envelope.event.kind = 'siren'; assert.equal(sent.envelope.event.kind, 'speech');
  let reads = 0; const getter = request(); Object.defineProperty(getter.envelope.event, 'kind', { enumerable: true, get() { reads++; return 'speech'; } });
  assert.throws(() => serializeSend(getter)); assert.equal(reads, 0);
  const inherited = request(); Object.setPrototypeOf(inherited.envelope, { authenticated: true }); assert.throws(() => serializeSend(inherited));
  const symbol = request(); symbol.envelope[Symbol('trust')] = true; assert.throws(() => serializeSend(symbol));
});
test('handshake rejects shape drift and pre-aborted calls do not open native transport', async () => {
  assert.throws(() => serializeHandshake({ version: 1, type: 'one-watch-handshake', requestId: 'r', fake: true }));
  const { native, calls } = softwareModule(), host = createWatchNativeApi(native).createNativeWatchHost();
  const abort = new AbortController(); abort.abort(); await assert.rejects(host.handshake({ version: 1, type: 'one-watch-handshake', requestId: 'request-1' }, abort.signal)); assert.deepEqual(calls, []);
});
test('native send resolution is not a receipt and abort after enqueue still cancels', async () => {
  const { native, calls } = softwareModule(), host = createWatchNativeApi(native).createNativeWatchHost(); const received = [];
  host.subscribe(x => received.push(x)); const abort = new AbortController(); await host.send(request(), abort.signal);
  assert.equal(calls.filter(c => c[0] === 'send').length, 1); assert.deepEqual(received, []);
  abort.abort(); await Promise.resolve(); assert.deepEqual(calls.at(-1), ['cancel', 'request-1', 'delivery-1']);
});
test('an aborted handshake closes its request and a late response is rejected', async () => {
  const { native, calls } = softwareModule(); let release; native.open = () => new Promise(resolve => { release = resolve; });
  const host = createWatchNativeApi(native).createNativeWatchHost(); const abort = new AbortController();
  const pending = host.handshake({ version: 1, type: 'one-watch-handshake', requestId: 'late' }, abort.signal);
  abort.abort(); release('{}'); await assert.rejects(pending); assert.ok(calls.some(c => c[0] === 'close' && c[1] === 'late'));
});
test('only actual module callbacks reach subscribers; malformed and oversized payloads are ignored', () => {
  const { native, listeners } = softwareModule(), host = createWatchNativeApi(native).createNativeWatchHost(), seen = [];
  const stop = host.subscribe(x => seen.push(x)); listeners.get('onWatchMessage')({ message: '{bad' }); listeners.get('onWatchMessage')({ message: 'x'.repeat(4097) });
  assert.equal(seen.length, 0); listeners.get('onWatchMessage')({ message: '{"type":"one-watch-disconnected","requestId":"real-native-callback"}' }); assert.equal(seen.length, 1);
  stop(); assert.equal(listeners.has('onWatchMessage'), false);
});
test('native close failure remains a failure, never a fabricated successful disconnection', async () => {
  const { native } = softwareModule(); native.close = async () => { throw new Error('native close failed'); };
  await assert.rejects(createWatchNativeApi(native).createNativeWatchHost().close('request-1'), /native close failed/);
});
test('send stamps the native monotonic clock before serialization and carries it unchanged across enqueue', async () => {
  const { native } = softwareModule(), order = [];
  native.monotonicTime = () => { order.push('clock'); return 1234.25; };
  native.send = async (raw, stamp) => { order.push('send'); assert.equal(stamp, 1234.25); assert.equal(JSON.parse(raw).envelope.remainingTtlMs, 5000); };
  const host = createWatchNativeApi(native).createNativeWatchHost(), abort = new AbortController();
  await host.send(request(), abort.signal); abort.abort(); assert.deepEqual(order, ['clock', 'send']);
});
test('invalid native clock refuses before any dispatch', async () => {
  for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    const { native, calls } = softwareModule(); native.monotonicTime = () => value;
    await assert.rejects(createWatchNativeApi(native).createNativeWatchHost().send(request(), new AbortController().signal), /native-clock-unavailable/);
    assert.deepEqual(calls, []);
  }
});
test('abort while native enqueues cancels that delivery and rejects the send result', async () => {
  const { native, calls } = softwareModule(), abort = new AbortController();
  native.send = async () => { abort.abort(); };
  await assert.rejects(createWatchNativeApi(native).createNativeWatchHost().send(request(), abort.signal), /closed/);
  assert.ok(calls.some(c => c[0] === 'cancel' && c[1] === 'request-1' && c[2] === 'delivery-1'));
});
