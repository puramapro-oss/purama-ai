import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Integration regression: execute the unchanged entry point and its real shared
// byte/deadline readers. Only auth, provider HTTP and the clock are fixture ports.
// No real credential, Supabase call, audio generation or network access is used.
const root = fileURLToPath(new URL('../', import.meta.url));
const entry = 'supabase/functions/voice-tts/index.ts';
const allowed = new Set([
  entry,
  'supabase/functions/_shared/request-body.ts',
  'supabase/functions/_shared/request-deadline.ts',
].map(file => resolve(root, file)));
const compiled = new Map();
const encoder = new TextEncoder();
const audio = Uint8Array.of(0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4);
const MAX_INPUT = 32_768;
const MAX_AUDIO = 8 * 1024 * 1024;
const DEADLINE = 30_000;
const PRIVATE = 'PRIVATE_TTS_USER_TEXT_api_key_fixture@example.invalid';
const never = () => new Promise(() => {});
const identity = () => ({ data: { user: { id: 'fixture-user' } }, error: null });
function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function audioResponse(bytes = audio, headers = {}) {
  return new Response(bytes, { headers: { 'content-type': 'audio/mpeg', ...headers } });
}
function request(body = { text: 'Bonjour' }, { authorization = 'Bearer fixture-token', signal, headers = {}, method = 'POST' } = {}) {
  const isStream = body instanceof ReadableStream;
  return new Request('https://edge.fixture.invalid/voice-tts', {
    method, signal,
    headers: { 'content-type': 'application/json', ...(authorization === null ? {} : { authorization }), ...headers },
    ...(method === 'GET' || method === 'OPTIONS' ? {} : {
      body: typeof body === 'string' || body instanceof Uint8Array || isStream ? body : JSON.stringify(body),
      ...(isStream ? { duplex: 'half' } : {}),
    }),
  });
}
function heldStream({ chunk, cancel = never } = {}) {
  const state = { cancels: 0 };
  let controller;
  const stream = new ReadableStream({
    start(value) { controller = value; if (chunk) value.enqueue(chunk); },
    cancel() { state.cancels++; return cancel(); },
  });
  return { stream, state, finish(bytes) { if (bytes) controller.enqueue(bytes); controller.close(); } };
}

async function harness({ auth = identity, provider = async () => audioResponse(), env = {}, realAuthSdk = false } = {}) {
  let handler, clock = 0, sequence = 0;
  const timers = new Map();
  const calls = { auth: [], fetch: [], logs: [] };
  const configuration = {
    SUPABASE_URL: 'https://supabase.fixture.invalid', SUPABASE_ANON_KEY: 'fixture-anon',
    OPENAI_API_KEY: 'fixture-openai-key', ELEVENLABS_API_KEY: 'fixture-eleven-key', ...env,
  };
  const log = (...args) => calls.logs.push(args.map(String).join(' '));
  const createClient = realAuthSdk ? createSupabaseClient : () => ({
    auth: { getUser: async token => { calls.auth.push(token); return await auth(token); } },
  });
  const context = vm.createContext({
    URL, Request, Response, Headers, ReadableStream, AbortController, AbortSignal,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Error,
    performance: { now: () => clock },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: { log, error: log, warn: log, info: log },
    Deno: { env: { get: key => configuration[key] }, serve: callback => { handler = callback; } },
    fetch: async (input, init) => { calls.fetch.push({ url: String(input), init }); return await provider(input, init); },
  });
  const modules = new Map();
  const authModule = new vm.SyntheticModule(['createClient'], function () { this.setExport('createClient', createClient); }, { context });
  function load(file) {
    assert.ok(allowed.has(file), `Unexpected product import: ${file}`);
    if (modules.has(file)) return modules.get(file);
    if (!compiled.has(file)) compiled.set(file, ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText);
    const module = new vm.SourceTextModule(compiled.get(file), { context, identifier: file });
    modules.set(file, module);
    return module;
  }
  const module = load(resolve(root, entry));
  await module.link((specifier, parent) => {
    if (['https://esm.sh/@supabase/supabase-js@2', 'https://esm.sh/@supabase/supabase-js@2.91.0', 'npm:@supabase/supabase-js@2.91.0'].includes(specifier)) return authModule;
    assert.ok(specifier.startsWith('.'), `Unexpected external import: ${specifier}`);
    return load(resolve(dirname(parent.identifier), specifier));
  });
  await module.evaluate();
  assert.equal(typeof handler, 'function', 'the real Deno.serve handler must be captured');
  return {
    handler, calls, timers,
    advance(ms, fireTimers = true) {
      clock += ms;
      if (fireTimers) for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); }
    },
  };
}

// This real-clock guard detects a stuck implementation. It cannot turn a hang
// into success; the expected response must settle under the manual clock.
async function settled(promise) {
  let guard;
  try {
    const observed = await Promise.race([
      promise.then(value => ({ value }), error => ({ error })),
      new Promise(resolve => { guard = setTimeout(() => resolve({ stuck: true }), 150); }),
    ]);
    assert.equal(observed.stuck, undefined, 'handler must settle without cooperation from auth/fetch/read/cancel');
    if (observed.error) throw observed.error;
    return observed.value;
  } finally { clearTimeout(guard); }
}
async function failure(h, response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
  const body = await response.text();
  assert.doesNotMatch(body, new RegExp(PRIVATE), 'private content must not reach the client');
  assert.doesNotMatch(h.calls.logs.join('\n'), new RegExp(PRIVATE), 'private content must not reach logs');
  assert.equal(h.timers.size, 0, 'completed/refused operation must release its timers');
}
function sent(h) {
  assert.equal(h.calls.fetch.length, 1, 'one provider attempt, no implicit retry');
  return JSON.parse(h.calls.fetch[0].init.body);
}

test('TTS: default request trims text and sends OpenAI nova/1 with response_format mp3', async () => {
  const h = await harness();
  const result = await h.handler(request({ text: '  Bonjour  ' }));
  assert.equal(result.status, 200);
  assert.equal(h.calls.fetch[0].url, 'https://api.openai.com/v1/audio/speech');
  const payload = sent(h);
  assert.equal(payload.input, 'Bonjour');
  assert.equal(payload.voice, 'nova');
  assert.equal(payload.speed, 1);
  assert.equal(payload.response_format, 'mp3');
  assert.equal(payload.format, undefined, 'the unsupported OpenAI format field must not be sent');
  assert.equal(h.calls.fetch[0].init.redirect, 'error');
  assert.equal(result.headers.get('content-type'), 'audio/mpeg');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), audio);
  assert.equal(h.timers.size, 0);
});

test('TTS: ElevenLabs uses the chosen voice, explicit MP3 output and voice_settings.speed', async () => {
  const h = await harness();
  assert.equal((await h.handler(request({ text: 'Bonjour', provider: 'elevenlabs', voice: 'voice_A-42', speed: 1.1 }))).status, 200);
  const payload = sent(h), url = new URL(h.calls.fetch[0].url);
  assert.equal(url.origin, 'https://api.elevenlabs.io');
  assert.equal(url.pathname, '/v1/text-to-speech/voice_A-42');
  assert.equal(url.searchParams.get('output_format'), 'mp3_44100_128');
  assert.equal(payload.text, 'Bonjour');
  assert.equal(payload.voice_settings.speed, 1.1);
  assert.equal(h.calls.fetch[0].init.redirect, 'error');
});

test('TTS: finite speed is clamped to each provider contract', async t => {
  for (const [provider, speed, expected] of [
    ['openai', -1, 0.25], ['openai', 99, 4], ['elevenlabs', -1, 0.7], ['elevenlabs', 99, 1.2],
  ]) await t.test(`${provider}: ${speed} -> ${expected}`, async () => {
    const h = await harness();
    assert.equal((await h.handler(request({ text: 'Bonjour', provider, speed }))).status, 200);
    const payload = sent(h);
    assert.equal(provider === 'openai' ? payload.speed : payload.voice_settings.speed, expected);
  });
});

test('TTS: invalid JSON shapes and field types fail before provider generation', async t => {
  const cases = [
    ['null body', null], ['array body', []], ['malformed JSON', '{'],
    ['missing text', {}], ['empty text', { text: '' }], ['whitespace text', { text: ' \n ' }],
    ['non-string text', { text: 123 }], ['null text', { text: null }],
    ['text over 4000', { text: 'a'.repeat(4001) }],
    ['unknown provider', { text: 'x', provider: 'other' }], ['null provider', { text: 'x', provider: null }],
    ['non-string provider', { text: 'x', provider: 1 }],
    ['OpenAI refuses an ElevenLabs voice ID', { text: 'x', provider: 'openai', voice: '21m00Tcm4TlvDq8ikWAM' }],
    ['voice traversal', { text: 'x', provider: 'elevenlabs', voice: '../voice' }], ['voice query', { text: 'x', provider: 'elevenlabs', voice: 'voice?x=y' }],
    ['voice slash', { text: 'x', provider: 'elevenlabs', voice: 'a/b' }], ['voice percent escape', { text: 'x', provider: 'elevenlabs', voice: '%2f' }],
    ['voice empty', { text: 'x', provider: 'elevenlabs', voice: '' }], ['voice null', { text: 'x', provider: 'elevenlabs', voice: null }],
    ['voice over 100', { text: 'x', provider: 'elevenlabs', voice: 'a'.repeat(101) }], ['voice non-string', { text: 'x', provider: 'elevenlabs', voice: 42 }],
    ['speed string', { text: 'x', speed: '1' }], ['speed null', { text: 'x', speed: null }],
    ['speed object', { text: 'x', speed: {} }], ['speed array', { text: 'x', speed: [] }],
    ['speed overflow', '{"text":"x","speed":1e309}'], ['negative speed overflow', '{"text":"x","speed":-1e309}'],
  ];
  for (const [label, body] of cases) await t.test(label, async () => {
    const h = await harness();
    await failure(h, await h.handler(request(body)), 400);
    assert.equal(h.calls.fetch.length, 0);
  });
});

test('TTS: ElevenLabs accepts text 4000 and a 100-character safe voice ID', async () => {
  const h = await harness();
  assert.equal((await h.handler(request({ text: ' ' + 'a'.repeat(4000) + ' ', provider: 'elevenlabs', voice: 'a'.repeat(100) }))).status, 200);
  assert.equal(sent(h).text.length, 4000);
  assert.equal(new URL(h.calls.fetch[0].url).pathname.split('/').at(-1), 'a'.repeat(100));
});

test('TTS: the inbound byte cap accepts 32768 and rejects 32769 without truncation', async t => {
  for (const extra of [0, 1]) await t.test(`${MAX_INPUT + extra} bytes`, async () => {
    const h = await harness();
    const json = '{"text":"Bonjour"}';
    const body = json + ' '.repeat(MAX_INPUT + extra - encoder.encode(json).length);
    const result = await h.handler(request(body));
    if (!extra) { assert.equal(result.status, 200); assert.equal(sent(h).input, 'Bonjour'); }
    else { await failure(h, result, 413); assert.equal(h.calls.fetch.length, 0); }
  });
});

test('TTS: inbound limits count UTF-8 bytes rather than JavaScript characters', async () => {
  const h = await harness();
  const body = JSON.stringify({ text: 'Bonjour', unused: 'é'.repeat(17_000) });
  assert.ok(body.length < MAX_INPUT && encoder.encode(body).length > MAX_INPUT);
  await failure(h, await h.handler(request(body)), 413);
  assert.equal(h.calls.fetch.length, 0);
});

test('TTS: malformed UTF-8 is rejected instead of synthesising replacement characters', async () => {
  const h = await harness();
  const body = Uint8Array.from([...encoder.encode('{"text":"'), 0xc3, 0x28, ...encoder.encode('"}')]);
  await failure(h, await h.handler(request(body)), 400);
  assert.equal(h.calls.fetch.length, 0);
});

test('TTS: missing selected provider key returns 503 with no fallback to the other provider', async t => {
  for (const [provider, key] of [['openai', 'OPENAI_API_KEY'], ['elevenlabs', 'ELEVENLABS_API_KEY']]) {
    await t.test(provider, async () => {
      const h = await harness({ env: { [key]: '' } });
      await failure(h, await h.handler(request({ text: 'Bonjour', provider })), 503);
      assert.equal(h.calls.fetch.length, 0);
    });
  }
});

test('TTS: absent or invalid identity never starts provider generation', async t => {
  for (const missing of [true, false]) await t.test(missing ? 'missing token' : 'rejected token', async () => {
    const h = await harness({ auth: async () => ({ data: { user: null }, error: { message: PRIVATE } }) });
    await failure(h, await h.handler(request({ text: 'Bonjour' }, { authorization: missing ? null : 'Bearer invalid-fixture' })), 401);
    assert.equal(h.calls.auth.length, missing ? 0 : 1);
    assert.equal(h.calls.fetch.length, 0);
  });
});

test('TTS: audio/mpeg, audio/mp3 and octet-stream are accepted and returned as MP3', async t => {
  for (const type of ['audio/mpeg', 'audio/mp3', 'application/octet-stream']) await t.test(type, async () => {
    const h = await harness({ provider: async () => audioResponse(audio, { 'content-type': type }) });
    const result = await h.handler(request());
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), audio);
    assert.equal(h.calls.fetch.length, 1);
  });
});

test('TTS: exact 8 MiB audio is accepted', async () => {
  const h = await harness({ provider: async () => audioResponse(new Uint8Array(MAX_AUDIO)) });
  const result = await h.handler(request());
  assert.equal(result.status, 200);
  assert.equal((await result.arrayBuffer()).byteLength, MAX_AUDIO);
  assert.equal(h.calls.fetch.length, 1);
});

test('TTS: declared and streamed audio oversize are refused with non-blocking cancellation', async t => {
  for (const declared of [true, false]) await t.test(declared ? 'declared oversize' : 'streamed oversize', async () => {
    const stream = heldStream({ chunk: declared ? audio : new Uint8Array(MAX_AUDIO + 1) });
    const h = await harness({ provider: async () => audioResponse(stream.stream, declared ? { 'content-length': String(MAX_AUDIO + 1) } : {}) });
    await failure(h, await settled(h.handler(request())), 502);
    assert.equal(stream.state.cancels, 1);
    assert.equal(h.calls.fetch.length, 1);
  });
});

test('TTS: empty audio, JSON, HTML and followed redirects are refused', async t => {
  const cases = [
    ['empty audio', () => audioResponse(new Uint8Array())],
    ['JSON', () => audioResponse(PRIVATE, { 'content-type': 'application/json' })],
    ['HTML', () => audioResponse(PRIVATE, { 'content-type': 'text/html' })],
    ['redirected response', () => { const result = audioResponse(); Object.defineProperty(result, 'redirected', { value: true }); return result; }],
  ];
  for (const [label, response] of cases) await t.test(label, async () => {
    const h = await harness({ provider: async () => response() });
    await failure(h, await settled(h.handler(request())), 502);
    assert.equal(h.calls.fetch.length, 1);
  });
});

test('TTS: HTTP failure does not read a stalled private error body or retry', async () => {
  const stream = heldStream();
  const h = await harness({ provider: async () => new Response(stream.stream, { status: 429, headers: { 'content-type': 'application/json' } }) });
  await failure(h, await settled(h.handler(request({ text: PRIVATE }))), 502);
  assert.equal(stream.state.cancels, 1);
  assert.equal(h.calls.fetch.length, 1);
});

test('TTS: upstream failure details and transport exceptions stay out of client and logs', async t => {
  for (const throws of [false, true]) await t.test(throws ? 'transport exception' : 'HTTP error', async () => {
    const h = await harness({ provider: async () => {
      if (throws) throw new Error(PRIVATE);
      return new Response(PRIVATE, { status: 503, headers: { 'content-type': 'text/plain' } });
    } });
    await failure(h, await h.handler(request({ text: PRIVATE })), 502);
    assert.equal(h.calls.fetch.length, 1);
  });
});

test('TTS: the 30-second deadline bounds non-cooperative authentication', async () => {
  const h = await harness({ auth: never });
  const pending = h.handler(request());
  let done = false; void pending.then(() => { done = true; });
  await flush(); h.advance(DEADLINE - 1); await flush();
  assert.equal(done, false, 'the configured overall budget is 30 seconds');
  h.advance(1);
  await failure(h, await settled(pending), 504);
  assert.equal(h.calls.fetch.length, 0);
});

test('TTS: the 30-second deadline bounds stalled inbound text and cancellation', async () => {
  const stream = heldStream();
  const h = await harness();
  const pending = h.handler(request(stream.stream));
  await flush(); h.advance(DEADLINE);
  await failure(h, await settled(pending), 504);
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(stream.state.cancels, 1);
});

test('TTS: expired provider fetch settles even if abort is ignored; a late response is cancelled', async () => {
  const port = deferred(), stream = heldStream();
  const h = await harness({ provider: () => port.promise });
  const pending = h.handler(request());
  await flush(); assert.equal(h.calls.fetch.length, 1);
  h.advance(DEADLINE);
  await failure(h, await settled(pending), 504);
  assert.equal(h.calls.fetch[0].init.signal.aborted, true);
  port.resolve(audioResponse(stream.stream)); await flush();
  assert.equal(stream.state.cancels, 1);
  assert.equal(h.calls.fetch.length, 1);
});

test('TTS: audio read and non-cooperative cleanup remain inside the same deadline', async () => {
  const stream = heldStream();
  const h = await harness({ provider: async () => audioResponse(stream.stream) });
  const pending = h.handler(request());
  await flush(); h.advance(DEADLINE);
  await failure(h, await settled(pending), 504);
  assert.equal(stream.state.cancels, 1);
  assert.equal(h.calls.fetch.length, 1);
});

test('TTS: inbound/auth/provider/audio share one 30-second budget without phase resets', async () => {
  const input = heldStream({ cancel: async () => {} }), output = heldStream();
  let h;
  h = await harness({
    auth: async () => { h.advance(8_000, false); return identity(); },
    provider: async () => { h.advance(10_000, false); return audioResponse(output.stream); },
  });
  const pending = h.handler(request(input.stream));
  let done = false; void pending.then(() => { done = true; });
  await flush(); h.advance(7_000); input.finish(encoder.encode('{"text":"Bonjour"}')); await flush();
  assert.equal(h.calls.fetch.length, 1);
  h.advance(4_999); await flush(); assert.equal(done, false);
  h.advance(1);
  await failure(h, await settled(pending), 504);
  assert.equal(output.state.cancels, 1);
});

test('TTS: late provider completion is rejected even before the timer callback runs', async () => {
  const stream = heldStream({ chunk: audio });
  let h;
  h = await harness({ provider: async () => { h.advance(DEADLINE + 1, false); return audioResponse(stream.stream); } });
  await failure(h, await settled(h.handler(request())), 504);
  assert.equal(stream.state.cancels, 1);
});

test('TTS: an already-aborted request performs no authentication or generation', async () => {
  const controller = new AbortController(); controller.abort();
  const h = await harness();
  await failure(h, await settled(h.handler(request({ text: 'Bonjour' }, { signal: controller.signal }))), 408);
  assert.equal(h.calls.auth.length, 0);
  assert.equal(h.calls.fetch.length, 0);
});

test('TTS: caller cancellation during authentication prevents late generation', async () => {
  const gate = deferred(), controller = new AbortController();
  const h = await harness({ auth: () => gate.promise });
  const pending = h.handler(request({ text: 'Bonjour' }, { signal: controller.signal }));
  await flush(); controller.abort();
  await failure(h, await settled(pending), 408);
  gate.resolve(identity()); await flush();
  assert.equal(h.calls.fetch.length, 0);
});

test('TTS: caller cancellation interrupts a non-cooperative provider fetch', async () => {
  const gate = deferred(), controller = new AbortController(), stream = heldStream();
  const h = await harness({ provider: () => gate.promise });
  const pending = h.handler(request({ text: 'Bonjour' }, { signal: controller.signal }));
  await flush(); controller.abort();
  await failure(h, await settled(pending), 408);
  assert.equal(h.calls.fetch[0].init.signal.aborted, true);
  gate.resolve(audioResponse(stream.stream)); await flush();
  assert.equal(stream.state.cancels, 1);
  assert.equal(h.calls.fetch.length, 1);
});

test('TTS: caller cancellation interrupts streamed audio without waiting for cleanup', async () => {
  const controller = new AbortController(), stream = heldStream();
  const h = await harness({ provider: async () => audioResponse(stream.stream) });
  const pending = h.handler(request({ text: 'Bonjour' }, { signal: controller.signal }));
  await flush(); controller.abort();
  await failure(h, await settled(pending), 408);
  assert.equal(stream.state.cancels, 1);
  assert.equal(h.calls.fetch.length, 1);
});

// Exercise the actual SDK through the handler's custom fetch adapter. The SDK
// runs in Node, so its console must be captured separately from the VM console.
// Its only permitted HTTP port is the handler's simulated fetch above.
function isolateSdk(t, h) {
  t.mock.method(console, 'error', (...args) => h.calls.logs.push(args.map(String).join(' ')));
  const externalFetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected host network request'); });
  t.after(() => assert.equal(externalFetch.mock.calls.length, 0, 'the real SDK must use the simulated HTTP adapter'));
}

test('TTS SDK: actual getUser authenticates through the bounded adapter before generation', async t => {
  const h = await harness({ realAuthSdk: true, provider: async input => {
    if (new URL(input).hostname === 'supabase.fixture.invalid') {
      return new Response(JSON.stringify({ id: 'fixture-user', aud: 'authenticated' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return audioResponse();
  } });
  isolateSdk(t, h);
  const result = await h.handler(request());
  assert.equal(result.status, 200);
  assert.equal(h.calls.fetch.length, 2);
  const [authentication, generation] = h.calls.fetch;
  assert.equal(authentication.url, 'https://supabase.fixture.invalid/auth/v1/user');
  assert.equal(authentication.init.method, 'GET');
  assert.equal(new Headers(authentication.init.headers).get('authorization'), 'Bearer fixture-token');
  assert.equal(new Headers(authentication.init.headers).get('apikey'), 'fixture-anon');
  assert.equal(authentication.init.redirect, 'error');
  assert.equal(generation.url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(JSON.parse(generation.init.body).input, 'Bonjour');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), audio);
  assert.equal(h.timers.size, 0);
});

test('TTS SDK: authentication transport errors cannot leak through SDK console.error', async t => {
  const h = await harness({ realAuthSdk: true, provider: async () => { throw new Error(PRIVATE); } });
  isolateSdk(t, h);
  await failure(h, await h.handler(request()), 401);
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(new URL(h.calls.fetch[0].url).hostname, 'supabase.fixture.invalid');
});

test('TTS SDK: authentication timeout aborts transport and cancels a non-cooperative late response', async t => {
  const gate = deferred(), stream = heldStream();
  const h = await harness({ realAuthSdk: true, provider: () => gate.promise });
  isolateSdk(t, h);
  const pending = h.handler(request());
  await flush();
  assert.equal(h.calls.fetch.length, 1);
  h.advance(DEADLINE);
  await failure(h, await settled(pending), 504);
  assert.equal(h.calls.fetch[0].init.signal.aborted, true);
  gate.resolve(new Response(stream.stream, { headers: { 'content-type': 'application/json' } }));
  await flush();
  assert.equal(stream.state.cancels, 1);
  assert.equal(h.calls.fetch.length, 1, 'late authentication cannot start generation');
});

test('TTS SDK: caller cancellation during authentication discards a late transport response', async t => {
  const gate = deferred(), controller = new AbortController(), stream = heldStream();
  const h = await harness({ realAuthSdk: true, provider: () => gate.promise });
  isolateSdk(t, h);
  const pending = h.handler(request({ text: 'Bonjour' }, { signal: controller.signal }));
  await flush();
  assert.equal(h.calls.fetch.length, 1);
  controller.abort();
  await failure(h, await settled(pending), 408);
  assert.equal(h.calls.fetch[0].init.signal.aborted, true);
  gate.resolve(new Response(stream.stream, { headers: { 'content-type': 'application/json' } }));
  await flush();
  assert.equal(stream.state.cancels, 1);
  assert.equal(h.calls.fetch.length, 1, 'cancelled authentication cannot start generation');
});

test('TTS SDK: authentication response body shares the overall deadline', async t => {
  const stream = heldStream({ chunk: encoder.encode('{"id":"fixture-user"') });
  const h = await harness({ realAuthSdk: true, provider: async () => new Response(stream.stream, {
    headers: { 'content-type': 'application/json' },
  }) });
  isolateSdk(t, h);
  const pending = h.handler(request());
  await flush();
  assert.equal(h.calls.fetch.length, 1);
  h.advance(DEADLINE);
  await failure(h, await settled(pending), 504);
  assert.equal(stream.state.cancels, 1);
  assert.equal(h.calls.fetch.length, 1, 'incomplete authentication cannot start generation');
});
