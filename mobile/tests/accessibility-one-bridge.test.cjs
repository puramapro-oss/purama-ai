const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');
const source = path.resolve(__dirname, '../lib/accessibility-one-bridge.ts');
const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUnderTest = new Module(source, module);
moduleUnderTest.filename = source;
moduleUnderTest.paths = module.paths;
moduleUnderTest._compile(compiled, source);
const { parseOneOrigin, isOneAccessibilityUrl, createOneWebBridge, buildOneNativeHostScript } = moduleUnderTest.exports;

const origin = 'https://one.example.invalid';
const url = `${origin}/accessible-pour-moi`;
const token = 'test-native-cryptographic-token';
const handshake = { version: 1, type: 'one-watch-handshake', requestId: 'request-1' };
const binding = { version: 1, deviceId: 'device-1', sessionId: 'session-1', platform: 'watchos' };
const send = { version: 1, type: 'one-watch-send', requestId: 'request-1', envelope: {
  version: 1, type: 'one-awareness-delivery', deviceId: 'device-1', sessionId: 'session-1', deliveryId: 'delivery-1',
  remainingTtlMs: 5000, event: { version: 1, eventId: 'event-1', source: 'microphone', kind: 'doorbell', observedAt: 1000, expiresAt: 6000, assessment: 'provisional' },
} };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(t, overrides = {}, control = {}) {
  const operations = [], errors = [], frames = [], callbacks = new Set(), windowEvents = new Map();
  const native = { version: 1,
    subscribe(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
    async handshake(request, signal) { operations.push({ method: 'handshake', request, signal }); return { version: 1, type: 'one-watch-ready', requestId: request.requestId, binding }; },
    async send(request, signal) { operations.push({ method: 'send', request, signal }); },
    async close(requestId) { operations.push({ method: 'close', requestId }); },
    ...overrides,
  };
  const window = { addEventListener(name, fn) { windowEvents.set(name, fn); },
    dispatchEvent(event) { windowEvents.get(event.type)?.(event); },
    ReactNativeWebView: { postMessage(raw) { const frame = JSON.parse(raw); frames.push(frame); control.beforeFrame?.(frame); void bridge.receive(raw, url); } },
  };
  window.top = window;
  const sandbox = vm.createContext({ window, location: new URL(url), setTimeout, clearTimeout, performance: control.documentClock || performance, Event, Error, Map, Set });
  const bridge = createOneWebBridge(native, { origin, token,
    inject(script) { control.beforeInjection?.(script); vm.runInContext(script, sandbox); }, onError(message) { errors.push(message); },
    monotonicNow: control.monotonicNow,
  });
  vm.runInContext(buildOneNativeHostScript(origin, token), sandbox);
  const host = window.__PURAMA_ONE_WATCH_HOST__;
  t.after(async () => {
    windowEvents.get('pagehide')?.();
    try { await bridge.close(); } catch { /* A test may deliberately leave native close unconfirmed. */ }
  });
  return { bridge, host, window, sandbox, operations, errors, frames,
    emit(value) { for (const fn of [...callbacks]) fn(value); }, native };
}

test('Only an exact HTTPS build origin and the accessible route are accepted', () => {
  assert.equal(parseOneOrigin(origin), origin);
  assert.equal(parseOneOrigin(`${origin}/`), origin);
  for (const invalid of [undefined, '', ' https://one.example.invalid', 'http://one.example.invalid', `${origin}/other`, `${origin}?x=1`, `${origin}#x`, 'https://user:secret@one.example.invalid']) assert.equal(parseOneOrigin(invalid), null);
  assert.equal(isOneAccessibilityUrl(url, origin), true);
  assert.equal(isOneAccessibilityUrl(`${url}#read-text`, origin), true);
  for (const invalid of [`${url}?external=1`, `${origin}/`, 'https://evil.example/accessible-pour-moi', 'file:///accessible-pour-moi', 'javascript:alert(1)', 'https://one.example.invalid.evil.test/accessible-pour-moi']) assert.equal(isOneAccessibilityUrl(invalid, origin), false);
});

test('Injection is explicit, immutable and inert until a user connection request', async t => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.host).sort(), ['close', 'handshake', 'send', 'subscribe', 'version']);
  const descriptor = Object.getOwnPropertyDescriptor(f.window, '__PURAMA_ONE_WATCH_HOST__');
  assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false);
  assert.equal(Object.isFrozen(f.host), true);
  await tick(); assert.deepEqual(f.operations, []); assert.deepEqual(f.frames, []);
});

test('The script does not install a host in a different page or an iframe', () => {
  for (const otherUrl of [`${origin}/other`, 'https://evil.example/accessible-pour-moi', `${url}?x=1`]) {
    const window = { ReactNativeWebView: { postMessage() { throw new Error('Unexpected send'); } } }; window.top = window;
    vm.runInNewContext(buildOneNativeHostScript(origin, token), { window, location: new URL(otherUrl) });
    assert.equal(window.__PURAMA_ONE_WATCH_HOST__, undefined);
  }
  const window = { top: {}, ReactNativeWebView: {} };
  vm.runInNewContext(buildOneNativeHostScript(origin, token), { window, location: new URL(url) });
  assert.equal(window.__PURAMA_ONE_WATCH_HOST__, undefined);
});

test('Handshake and send cross the real serialized bridge; success never fabricates a receipt', async t => {
  const f = fixture(t), events = [];
  const cancel = new AbortController();
  f.host.subscribe(value => events.push(value));
  const result = await f.host.handshake(handshake, cancel.signal);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { version: 1, type: 'one-watch-ready', requestId: 'request-1', binding });
  await f.host.send(send, cancel.signal);
  assert.deepEqual(f.operations.map(value => value.method), ['handshake', 'send']);
  assert.ok(f.operations.at(-1).request.envelope.remainingTtlMs < 5000, 'Transport must consume, not restart, the original TTL');
  assert.deepEqual(events, []);
  for (const stage of ['received', 'displayed', 'acknowledged']) {
    const receipt = { version: 1, type: 'one-watch-receipt', requestId: 'request-1', receipt: { ...binding, platform: undefined, type: 'one-awareness-receipt', deliveryId: 'delivery-1', eventId: 'event-1', stage } };
    delete receipt.receipt.platform;
    f.emit(receipt);
  }
  assert.deepEqual(events.map(value => value.receipt.stage), ['received', 'displayed', 'acknowledged']);
  await f.host.close('request-1');
  f.emit({ version: 1, type: 'one-watch-disconnected', requestId: 'request-1' });
  assert.equal(events.length, 3);
});

test('Cancellation remains connected after transport acceptance', async t => {
  const f = fixture(t), handshakeAbort = new AbortController(), deliveryAbort = new AbortController();
  await f.host.handshake(handshake, handshakeAbort.signal);
  await f.host.send(send, deliveryAbort.signal);
  const nativeSignal = f.operations.find(value => value.method === 'send').signal;
  assert.equal(nativeSignal.aborted, false);
  deliveryAbort.abort(); await tick(); assert.equal(nativeSignal.aborted, true);
  await f.host.close('request-1');
});

test('Wrong origin, token, replayed ID and hostile frame shapes never reach native methods', async t => {
  const f = fixture(t);
  const frame = { channel: 'purama-one-watch-v1', token, id: 1, method: 'handshake', value: handshake };
  await f.bridge.receive(JSON.stringify(frame), 'https://evil.example/accessible-pour-moi');
  await f.bridge.receive(JSON.stringify({ ...frame, token: 'wrong' }), url);
  await f.bridge.receive(JSON.stringify({ ...frame, unexpected: true }), url);
  await f.bridge.receive('x'.repeat(16_385), url);
  await f.bridge.receive('{', url);
  assert.deepEqual(f.operations, []);
  await f.bridge.receive(JSON.stringify(frame), url);
  await f.bridge.receive(JSON.stringify(frame), url);
  assert.equal(f.operations.filter(value => value.method === 'handshake').length, 1);
});

test('A native close failure is explicit, blocks a second attempt and can be retried', async t => {
  let fail = true;
  const f = fixture(t, { async close() { if (fail) throw new Error('Radio busy'); } });
  await f.host.handshake(handshake, new AbortController().signal);
  await assert.rejects(f.host.close('request-1'), /close-unconfirmed/);
  assert.ok(f.errors.some(value => value.includes('n’a pas été confirmée')));
  await assert.rejects(f.host.handshake({ ...handshake, requestId: 'request-2' }, new AbortController().signal), /unavailable/);
  fail = false;
  await f.host.close('request-1');
  const next = await f.host.handshake({ ...handshake, requestId: 'request-2' }, new AbortController().signal);
  assert.equal(next.requestId, 'request-2');
  await f.host.close('request-2');
});

test('Closing the native screen aborts pending work and ignores late handshake resolution', async t => {
  let release, nativeSignal;
  const f = fixture(t, { handshake(request, signal) { nativeSignal = signal; return new Promise(resolve => { release = resolve; }); } });
  const pending = f.host.handshake(handshake, new AbortController().signal);
  const refusal = assert.rejects(pending, /cancelled/);
  await tick();
  f.window.dispatchEvent(new Event('pagehide'));
  await f.bridge.close();
  assert.equal(nativeSignal.aborted, true);
  release({ version: 1, type: 'one-watch-ready', requestId: 'request-1', binding });
  await refusal; await tick();
  await assert.rejects(f.host.handshake(handshake, new AbortController().signal), /unavailable/);
});

test('A foreign receipt cannot be forwarded to the active document', async t => {
  const f = fixture(t), values = [];
  f.host.subscribe(value => values.push(value));
  await f.host.handshake(handshake, new AbortController().signal);
  f.emit({ version: 1, type: 'one-watch-receipt', requestId: 'other-attempt', receipt: {} });
  assert.deepEqual(values, []);
  await f.host.close('request-1');
});

test('Time queued in the WebView and the full freshness round trip are subtracted', async t => {
  let documentTime = 100, nativeTime = 0;
  const f = fixture(t, {}, { documentClock: { now: () => documentTime }, monotonicNow: () => nativeTime,
    beforeFrame(frame) {
      if (frame.method === 'send') documentTime += 2000;
      if (frame.method === 'resolved-delivery') nativeTime += 200;
    },
  });
  await f.host.handshake(handshake, new AbortController().signal);
  await f.host.send(send, new AbortController().signal);
  assert.equal(f.operations.find(value => value.method === 'send').request.envelope.remainingTtlMs, 2800);
  await f.host.close('request-1');
});

for (const fault of ['expired-document', 'regressed-document-clock', 'regressed-native-clock']) {
  test(`A ${fault} refuses native delivery`, async t => {
    let documentTime = 100, nativeTime = 10;
    const f = fixture(t, {}, { documentClock: { now: () => documentTime }, monotonicNow: () => nativeTime,
      beforeFrame(frame) {
        if (frame.method === 'send' && fault === 'expired-document') documentTime += 5001;
        if (frame.method === 'send' && fault === 'regressed-document-clock') documentTime--;
        if (frame.method === 'resolved-delivery' && fault === 'regressed-native-clock') nativeTime--;
      },
    });
    await f.host.handshake(handshake, new AbortController().signal);
    await assert.rejects(f.host.send(send, new AbortController().signal), /failed/);
    assert.equal(f.operations.some(value => value.method === 'send'), false);
    await f.host.close('request-1');
  });
}

test('Cancellation during the freshness request never reaches the native send', async t => {
  const abort = new AbortController();
  const f = fixture(t, {}, { beforeInjection(script) {
    if (script.includes('"type":"resolve-delivery"')) abort.abort();
  } });
  await f.host.handshake(handshake, new AbortController().signal);
  await assert.rejects(f.host.send(send, abort.signal), /cancelled/);
  await tick(); assert.equal(f.operations.some(value => value.method === 'send'), false);
  await f.host.close('request-1');
});

test('A suspended continuation after freshness resolution cannot renew the TTL', async t => {
  let documentTime = 100, nativeTime = 10;
  const f = fixture(t, {}, { documentClock: { now: () => documentTime }, monotonicNow: () => nativeTime,
    beforeFrame(frame) {
      if (frame.method === 'resolved-delivery') queueMicrotask(() => { documentTime += 6000; nativeTime += 6000; });
    },
  });
  await f.host.handshake(handshake, new AbortController().signal);
  await assert.rejects(f.host.send(send, new AbortController().signal), /failed/);
  assert.equal(f.operations.some(value => value.method === 'send'), false);
  await f.host.close('request-1');
});

test('An unconfirmed unsubscribe rejects closing and is retried explicitly', async t => {
  let fail = true, unsubscribeCalls = 0;
  const f = fixture(t, { subscribe() { return () => { unsubscribeCalls++; if (fail) throw new Error('Listener busy'); }; } });
  await assert.rejects(f.bridge.close(), /unconfirmed/);
  assert.equal(unsubscribeCalls, 1);
  fail = false;
  await f.bridge.close();
  assert.equal(unsubscribeCalls, 2);
  await f.bridge.close();
  assert.equal(unsubscribeCalls, 2);
});
