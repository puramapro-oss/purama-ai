import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { createFixture, request, payload, prefs, USER, OTHER_USER, NOTIFICATION, EMAIL, PRIVATE, FLAGS } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = resolve(root, 'supabase/functions/send-notification/index.ts');
const allowed = new Set([
  entry,
  resolve(root, 'src/lib/safeNavigation.ts'),
  ...['request-body.ts', 'request-deadline.ts', 'webhook-security.ts', 'notification-action-url.ts'].map(file => resolve(root, 'supabase/functions/_shared', file)),
]);
const compiled = new Map();
const encoder = new TextEncoder();

async function harness(options = {}) {
  const fixture = createFixture(options);
  let handler, clock = 0, sequence = 0;
  const timers = new Map();
  const context = vm.createContext({
    Request, Response, Headers, URL, TextEncoder, TextDecoder, ReadableStream,
    Uint8Array, ArrayBuffer, AbortController, AbortSignal, Error,
    performance: { now: () => clock },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: fixture.console, fetch: fixture.noNetwork,
    Deno: { env: { get: key => fixture.config[key] }, serve: fn => { handler = fn; } },
  });
  const modules = new Map();
  const provider = new vm.SyntheticModule(['createClient', 'Resend'], function () {
    this.setExport('createClient', fixture.createClient); this.setExport('Resend', fixture.Resend);
  }, { context });
  function load(file) {
    assert.ok(allowed.has(file), `Unexpected product import: ${file}`);
    if (modules.has(file)) return modules.get(file);
    if (!compiled.has(file)) compiled.set(file, stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' }));
    const module = new vm.SourceTextModule(compiled.get(file), { context, identifier: file });
    modules.set(file, module); return module;
  }
  const module = load(entry);
  await module.link((specifier, parent) => {
    if (['https://esm.sh/@supabase/supabase-js@2', 'resend'].includes(specifier)) return provider;
    assert.ok(specifier.startsWith('.'), `Unexpected external import: ${specifier}`);
    return load(resolve(dirname(parent.identifier), specifier));
  });
  await module.evaluate(); assert.equal(typeof handler, 'function');
  return {
    ...fixture, handler, timers,
    advance(ms) { clock += ms; for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); } },
  };
}

function noEffects(h) { assert.equal(h.state.writes.length, 0); assert.equal(h.state.emails.length, 0); assert.equal(h.state.network.length, 0); }
async function failure(h, response, status) {
  assert.equal(response.status, status);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(PRIVATE));
  assert.doesNotMatch(h.state.logs.join('\n'), new RegExp(PRIVATE));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(h.timers.size, 0);
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function settled(pending) {
  let timer;
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Handler remained blocked')), 200); })]); }
  finally { clearTimeout(timer); }
}

test('notification: valid authenticated POST persists once and acknowledges accepted email', async () => {
  const h = await harness(); const response = await h.handler(request());
  assert.equal(response.status, 201); const result = await response.json();
  assert.equal(result.success, true); assert.equal(result.email_sent, true);
  assert.doesNotMatch(result.message, /delivered/i);
  assert.equal(h.state.writes.length, 1); assert.equal(h.state.emails.length, 1);
  assert.equal(h.state.writes[0].row.user_id, USER); assert.deepEqual(h.state.emails[0].to, [EMAIL]);
  assert.equal(h.state.clients[0][2].db.schema, 'purama_ai');
  assert.equal(h.state.clients[0][2].db.retry, false, 'the database SDK cannot retry unknown insert outcomes');
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(h.state.network.length, 0);
});

test('notification: OPTIONS is effect-free and advertises POST', async () => {
  const h = await harness(); const response = await h.handler(request(undefined, { method: 'OPTIONS', secret: null }));
  assert.ok([200, 204].includes(response.status)); assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
  noEffects(h); assert.equal(h.state.clients.length, 0);
});
for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) test(`notification: refuses ${method}`, async () => {
  const h = await harness(); const response = await h.handler(request(undefined, { method }));
  await failure(h, response, 405); assert.match(response.headers.get('allow') ?? '', /POST/); noEffects(h); assert.equal(h.state.clients.length, 0);
});
for (const secret of [null, 'incorrect', 'fixture-notification-secret-suffix']) test(`notification: refuses secret ${secret}`, async () => {
  const h = await harness(); await failure(h, await h.handler(request(undefined, { secret })), 401); noEffects(h); assert.equal(h.state.clients.length, 0);
});
for (const key of ['WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) test(`notification: missing configuration ${key}`, async () => {
  const h = await harness({ env: { [key]: '' } }); await failure(h, await h.handler(request()), 503); noEffects(h); assert.equal(h.state.clients.length, 0);
});
test('notification: accepts JSON content type with charset', async () => {
  const h = await harness(); assert.equal((await h.handler(request(undefined, { headers: { 'content-type': 'application/json; charset=utf-8' } }))).status, 201);
});
for (const mime of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonp']) test(`notification: refuses content type ${mime}`, async () => {
  const h = await harness(); await failure(h, await h.handler(request(undefined, { headers: { 'content-type': mime } })), 415); noEffects(h);
});

const invalid = [
  ['malformed JSON', '{'], ['null', null], ['array', []], ['scalar', '42'], ['missing fields', {}],
  ['title number', payload({ title: 7 })], ['title whitespace', payload({ title: ' \n ' })],
  ['title too long', payload({ title: 'a'.repeat(301) })], ['title header break', payload({ title: 'a\r\nb' })],
  ['message object', payload({ message: { private: PRIVATE } })], ['message empty', payload({ message: '' })],
  ['message too long', payload({ message: 'a'.repeat(5001) })], ['message NUL', payload({ message: 'a\0b' })],
  ['invalid type', payload({ type: 'unknown' })], ['type object', payload({ type: {} })],
  ['id number', payload({ user_id: 7 })], ['id malformed', payload({ user_id: 'not-a-uuid' })],
  ['no identity', { type: 'alert', title: 'Titre', message: 'Message' }],
  ['email invalid', payload({ user_email: PRIVATE + '@invalid' })], ['email object', payload({ user_email: {} })],
  ['email CRLF', payload({ user_email: 'alice@example.invalid\r\nbcc:other@example.invalid' })],
  ['email too long', payload({ user_email: 'a'.repeat(250) + '@x.invalid' })],
  ['slug number', payload({ agent_slug: 7 })], ['slug too long', payload({ agent_slug: 'a'.repeat(101) })],
  ['url number', payload({ action_url: 7 })], ['url too long', payload({ action_url: '/' + 'a'.repeat(2048) })],
  ['unexpected field', payload({ recipient: PRIVATE })],
];
for (const [label, body] of invalid) test(`notification: input validation ${label}`, async () => {
  const h = await harness(); await failure(h, await h.handler(request(body)), 400); noEffects(h); assert.equal(h.state.clients.length, 0);
});
test('notification: accepts documented text bounds and multiline message', async () => {
  const h = await harness(); assert.equal((await h.handler(request(payload({ title: 'é'.repeat(300), message: 'a'.repeat(4998) + '\n\t', agent_slug: 'a'.repeat(100) })))).status, 201);
});

for (const [label, body, status] of [
  ['invalid UTF-8', Uint8Array.of(123, 34, 120, 34, 58, 34, 255, 34, 125), 400],
  ['byte limit', ' '.repeat(32_769), 413],
  ['multibyte byte limit', JSON.stringify(payload({ message: 'é'.repeat(17_000) })), 413],
]) test(`notification: bounded body ${label}`, async () => {
  const h = await harness(); await failure(h, await h.handler(request(body)), status); noEffects(h);
});
test('notification: exact 32 KiB input is accepted without truncation', async () => {
  const h = await harness(); const json = JSON.stringify(payload());
  assert.equal((await h.handler(request(json + ' '.repeat(32_768 - encoder.encode(json).length)))).status, 201);
});
for (const declared of ['-1', '1.5', 'unknown', '9007199254740993', '1']) test(`notification: invalid Content-Length ${declared}`, async () => {
  const h = await harness(); await failure(h, await h.handler(request(undefined, { headers: { 'content-length': declared } })), 400); noEffects(h);
});
test('notification: declared oversized input is refused before reading', async () => {
  const h = await harness(); await failure(h, await h.handler(request(undefined, { headers: { 'content-length': '32769' } })), 413); noEffects(h);
});
test('notification: stalled body respects shared five-second deadline and non-cooperative cancellation', async () => {
  let cancels = 0;
  const stream = new ReadableStream({ cancel() { cancels++; return new Promise(() => {}); } });
  const h = await harness(); const pending = h.handler(request(stream)); await flush(); h.advance(5_001);
  await failure(h, await settled(pending), 408); assert.equal(cancels, 1); noEffects(h);
});
test('notification: an aborted request cannot read profiles or perform effects', async () => {
  const controller = new AbortController(); controller.abort(); const h = await harness();
  await failure(h, await h.handler(request(undefined, { signal: controller.signal })), 408); noEffects(h); assert.equal(h.state.clients.length, 0);
});
for (const [phase, result] of [
  ['profile', { data: { user_id: USER, email: EMAIL }, error: null }],
  ['preferences', { data: prefs(), error: null }],
  ['identity', { data: { user: { id: USER, email: EMAIL, email_confirmed_at: '2026-10-01T12:00:00Z' } }, error: null }],
]) test(`notification: cancellation during ${phase} prevents subsequent effects`, async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const controller = new AbortController(), h = await harness({ [phase]: () => gate });
  const pending = h.handler(request(undefined, { signal: controller.signal }));
  await flush(); controller.abort(); resolve(result);
  await failure(h, await pending, 408); noEffects(h);
});
test('notification: cancellation during insertion keeps its receipt and stops the additional email', async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const controller = new AbortController(), h = await harness({ insert: () => gate });
  const pending = h.handler(request(undefined, { signal: controller.signal }));
  await flush(); assert.equal(h.state.writes.length, 1); controller.abort();
  resolve({ data: { id: NOTIFICATION }, error: null });
  const response = await pending; assert.equal(response.status, 201); assert.equal((await response.json()).email_sent, false);
  assert.equal(h.state.writes.length, 1); assert.equal(h.state.emails.length, 0);
});

for (const [label, overrides] of [
  ['id only', {}], ['matching id and email', { user_email: EMAIL }], ['case-insensitive matching email', { user_email: EMAIL.toUpperCase() }],
  ['email only', { user_id: undefined, user_email: EMAIL }],
]) test(`notification: verified recipient ${label}`, async () => {
  const h = await harness(); assert.equal((await h.handler(request(payload(overrides)))).status, 201);
  assert.equal(h.state.reads.filter(query => query.table === 'profiles').length, 1);
  assert.deepEqual(h.state.emails[0].to, [EMAIL]); assert.equal(h.state.writes[0].row.user_id, USER);
});
test('notification: different supplied email cannot override the profile recipient', async () => {
  const h = await harness(); await failure(h, await h.handler(request(payload({ user_email: 'other@example.invalid' }))), 400); noEffects(h);
});
for (const [label, profile, status] of [
  ['missing profile', { data: null, error: null }, 404],
  ['failed lookup', { data: null, error: { message: PRIVATE } }, 503],
  ['ambiguous lookup', { data: null, error: { code: 'PGRST116', message: PRIVATE } }, 503],
  ['thrown lookup', new Error(PRIVATE), 503],
  ['wrong id', { data: { user_id: OTHER_USER, email: EMAIL }, error: null }, 503],
  ['invalid profile email', { data: { user_id: USER, email: 'broken' }, error: null }, 503],
]) test(`notification: recipient ${label}`, async () => {
  const h = await harness({ profile }); await failure(h, await h.handler(request()), status); noEffects(h);
});
test('notification: a known profile without email retains the in-app notification', async () => {
  const h = await harness({ profile: { data: { user_id: USER, email: null }, error: null } });
  const response = await h.handler(request()); assert.equal(response.status, 201); assert.equal((await response.json()).email_sent, false);
  assert.equal(h.state.writes.length, 1); assert.equal(h.state.emails.length, 0);
  assert.equal(h.state.identities.length, 0, 'a profile with no email does not enable a new email channel');
});

test('notification: a mutable stale profile email cannot become the outbound recipient', async () => {
  const h = await harness({ profile: { data: { user_id: USER, email: 'stale@example.invalid' }, error: null } });
  assert.equal((await h.handler(request())).status, 201); assert.deepEqual(h.state.emails[0].to, [EMAIL]);
  assert.deepEqual(h.state.identities, [USER]);
});
test('notification: an explicit canonical email can accompany an id whose profile email is stale', async () => {
  const h = await harness({ profile: { data: { user_id: USER, email: 'stale@example.invalid' }, error: null } });
  assert.equal((await h.handler(request(payload({ user_email: EMAIL })))).status, 201); assert.deepEqual(h.state.emails[0].to, [EMAIL]);
});
test('notification: email-only lookup cannot route to an address copied into a mutable profile', async () => {
  const h = await harness({ profile: { data: { user_id: USER, email: 'copied@example.invalid' }, error: null } });
  await failure(h, await h.handler(request(payload({ user_id: undefined, user_email: 'copied@example.invalid' }))), 400); noEffects(h);
});
for (const [label, identity] of [
  ['admin error', { data: { user: null }, error: { message: PRIVATE } }], ['admin throws', new Error(PRIVATE)],
  ['foreign user', { data: { user: { id: OTHER_USER, email: EMAIL, email_confirmed_at: '2026-10-01T12:00:00Z' } }, error: null }],
  ['invalid canonical email', { data: { user: { id: USER, email: PRIVATE + '@invalid', email_confirmed_at: '2026-10-01T12:00:00Z' } }, error: null }],
]) test(`notification: canonical identity ${label} fails before effects`, async () => {
  const h = await harness({ identity }); await failure(h, await h.handler(request()), 503); noEffects(h);
});
for (const [label, user] of [
  ['unconfirmed', { id: USER, email: EMAIL, email_confirmed_at: null }],
  ['absent email', { id: USER, email: null, email_confirmed_at: null }],
  ['invalid confirmation date', { id: USER, email: EMAIL, email_confirmed_at: 'invalid' }],
  ['future confirmation', { id: USER, email: EMAIL, email_confirmed_at: '2999-01-01T00:00:00Z' }],
]) test(`notification: canonical ${label} keeps only the in-app notification`, async () => {
  const h = await harness({ identity: { data: { user }, error: null } }); const response = await h.handler(request());
  assert.equal(response.status, 201); assert.equal((await response.json()).email_sent, false);
  assert.equal(h.state.writes.length, 1); assert.equal(h.state.emails.length, 0);
});

for (const [label, preferences] of [
  ['read error', { data: null, error: { message: PRIVATE } }], ['thrown read', new Error(PRIVATE)],
  ['invalid flag', { data: prefs({ alert_enabled: 'false' }), error: null }],
  ['missing selected flag', { data: { user_id: USER, email_enabled: true }, error: null }],
  ['foreign row', { data: prefs({ user_id: OTHER_USER }), error: null }],
]) test(`notification: preference ${label} stops before effects`, async () => {
  const h = await harness({ preferences }); await failure(h, await h.handler(request()), 503); noEffects(h);
});
for (const [label, preferences] of [
  ['confirmed absence', { data: null, error: null }],
  ['legacy nullable flags', { data: prefs(Object.fromEntries(FLAGS.map(key => [key, null]))), error: null }],
]) test(`notification: ${label} keeps the historical default`, async () => {
  const h = await harness({ preferences }); assert.equal((await h.handler(request())).status, 201); assert.equal(h.state.emails.length, 1);
});
for (const type of ['task_completed', 'question', 'daily_report', 'alert']) test(`notification: disabled ${type} has no effects`, async () => {
  const h = await harness({ preferences: { data: prefs({ [type + '_enabled']: false }), error: null } });
  const response = await h.handler(request(payload({ type }))); assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true); noEffects(h);
  assert.equal(h.state.identities.length, 0);
});
test('notification: disabled email keeps only the in-app effect', async () => {
  const h = await harness({ preferences: { data: prefs({ email_enabled: false }), error: null } });
  const response = await h.handler(request()); assert.equal(response.status, 201); assert.equal((await response.json()).email_sent, false);
  assert.equal(h.state.writes.length, 1); assert.equal(h.state.emails.length, 0);
  assert.equal(h.state.identities.length, 0);
});

for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'http://example.invalid/a', '//example.invalid/a', '/\\example.invalid', 'https://u:p@example.invalid/', 'https:example.invalid', '/a\n/b', '/a" onclick="x', 'https://example.invalid/\u0000x']) test(`notification: unsafe action URL ${JSON.stringify(url)}`, async () => {
  const h = await harness(); await failure(h, await h.handler(request(payload({ action_url: url }))), 400); noEffects(h);
});
for (const url of ['/dashboard', '/dashboard/tasks?view=all&n=2#item', 'https://partner.example.invalid/detail?id=1&view=full', 'https://purama-ai.purama.dev/dashboard']) test(`notification: safe action URL ${url}`, async () => {
  const h = await harness(); assert.equal((await h.handler(request(payload({ action_url: url })))).status, 201);
  const stored = h.state.writes[0].row.action_url;
  assert.ok(stored.startsWith('/') && !stored.startsWith('//') || stored.startsWith('https://'));
  const expected = new URL(url, 'https://purama-ai.purama.dev').href.replaceAll('&', '&amp;');
  assert.ok(h.state.emails[0].html.includes(`href="${expected}"`));
});
test('notification: explicit null action URL retains no link', async () => {
  const h = await harness(); assert.equal((await h.handler(request(payload({ action_url: null })))).status, 201);
  assert.equal(h.state.writes[0].row.action_url, null);
  assert.equal(h.state.emails[0].html.includes('Voir les détails'), false);
});
test('notification: text is escaped in every HTML context without altering stored plain text', async () => {
  const text = '<img src="https://tracker.invalid/pixel"> & \'quoted\'';
  const h = await harness(); assert.equal((await h.handler(request(payload({ title: text, message: text, agent_slug: text })))).status, 201);
  const html = h.state.emails[0].html;
  assert.ok(!html.includes('<img src="https://tracker.invalid/pixel">'));
  assert.ok(html.includes('&lt;img src=&quot;https://tracker.invalid/pixel&quot;&gt; &amp; &#39;quoted&#39;'));
  assert.equal(h.state.writes[0].row.message, text); assert.equal(h.state.writes[0].row.title, text);
});

for (const [label, insert] of [
  ['database error', { data: null, error: { message: PRIVATE } }], ['thrown insert', new Error(PRIVATE)],
  ['missing receipt', { data: null, error: null }], ['invalid receipt', { data: { id: PRIVATE }, error: null }],
]) test(`notification: insertion ${label} cannot acknowledge success or email`, async () => {
  const h = await harness({ insert }); await failure(h, await h.handler(request()), 500);
  assert.equal(h.state.writes.length, 1); assert.equal(h.state.emails.length, 0);
});
for (const [label, email] of [
  ['provider rejection', { data: null, error: { message: PRIVATE } }], ['thrown email', new Error(PRIVATE)],
  ['missing receipt', { data: null, error: null }], ['empty receipt', { data: { id: '' }, error: null }],
]) test(`notification: email ${label} preserves the single successful in-app effect`, async () => {
  const h = await harness({ email }); const response = await h.handler(request());
  assert.equal(response.status, 201); const body = await response.text(); assert.equal(JSON.parse(body).email_sent, false);
  assert.match(JSON.parse(body).message, /acceptance not confirmed/);
  assert.doesNotMatch(body + h.state.logs.join('\n'), new RegExp(PRIVATE));
  assert.equal(h.state.writes.length, 1); assert.equal(h.state.emails.length, 1); assert.equal(h.state.network.length, 0);
});
test('notification: absent email configuration preserves only the in-app effect', async () => {
  const h = await harness({ env: { RESEND_API_KEY: '' } }); const response = await h.handler(request());
  assert.equal(response.status, 201); assert.equal((await response.json()).email_sent, false); assert.equal(h.state.writes.length, 1); assert.equal(h.state.emails.length, 0);
});
test('notification: success logs do not expose recipient email or user text', async () => {
  const h = await harness(); const response = await h.handler(request(payload({ title: PRIVATE, message: PRIVATE })));
  assert.equal(response.status, 201); const body = await response.text();
  assert.ok(!h.state.logs.join('\n').includes(EMAIL)); assert.ok(!h.state.logs.join('\n').includes(PRIVATE)); assert.ok(!body.includes(PRIVATE));
});
