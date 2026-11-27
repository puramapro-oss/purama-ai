// Native Deno entrypoint: the real handler and shared helpers are loaded with
// an import map whose only external modules are inert local ports.
import { reset, getFixture } from './deno-fixture.ts';
import { request, payload, prefs, USER, EMAIL, PRIVATE, FLAGS } from './fixtures.mjs';

const environment = {
  WEBHOOK_SECRET: 'fixture-notification-secret', SUPABASE_URL: 'https://supabase.fixture.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role', RESEND_API_KEY: 'fixture-resend',
};
for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
let handler: (request: Request) => Promise<Response>;
const originalServe = Deno.serve;
try {
  Deno.serve = ((fn: typeof handler) => { handler = fn; return {}; }) as unknown as typeof Deno.serve;
  await import('../../supabase/functions/send-notification/index.ts');
} finally { Deno.serve = originalServe; }
if (typeof handler! !== 'function') throw new Error('Native handler was not captured');

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function noEffects() { const { state } = getFixture(); equal(state.writes.length, 0); equal(state.emails.length, 0); equal(state.network.length, 0); }
async function run(body = payload(), options = {}, requestOptions = {}) {
  const fixture = reset(options);
  for (const [key, value] of Object.entries(fixture.config)) Deno.env.set(key, String(value));
  const log = console.log, error = console.error, warn = console.warn, fetch = globalThis.fetch;
  console.log = fixture.console.log; console.error = fixture.console.error; console.warn = fixture.console.warn;
  globalThis.fetch = fixture.noNetwork;
  try { return await handler(request(body, requestOptions)); }
  finally { console.log = log; console.error = error; console.warn = warn; globalThis.fetch = fetch; }
}

Deno.test('notifications native runtime has network and processes denied', async () => {
  equal((await Deno.permissions.query({ name: 'net' })).state, 'denied');
  equal((await Deno.permissions.query({ name: 'run' })).state, 'denied');
});
Deno.test('notifications native valid request keeps its contract and canonical recipient', async () => {
  const response = await run(); equal(response.status, 201); const data = await response.json();
  equal(data.success, true); equal(data.email_sent, true); equal(data.message.includes('delivered'), false);
  const { state } = getFixture(); equal(state.writes.length, 1); equal(state.emails.length, 1);
  equal(state.identities[0], USER); equal(state.emails[0].to[0], EMAIL); equal(state.network.length, 0);
});
for (const [label, body] of [
  ['null', null], ['array', []], ['malformed JSON', '{'],
  ['title number', payload({ title: 7 })], ['message object', payload({ message: { private: PRIVATE } })],
  ['invalid URL', payload({ action_url: 'javascript:alert(1)' })],
  ['encoded external path', payload({ action_url: '/%252foutside.invalid' })],
  ['invalid user id', payload({ user_id: 'invalid' })],
]) Deno.test(`notifications native refuses ${label}`, async () => {
  const response = await run(body); equal(response.status, 400); noEffects();
  equal((await response.text()).includes(PRIVATE), false);
});
for (const [label, options, status] of [
  ['wrong secret', { secret: 'wrong' }, 401], ['GET', { method: 'GET' }, 405], ['PUT', { method: 'PUT' }, 405],
]) Deno.test(`notifications native refuses ${label} before database work`, async () => {
  equal((await run(undefined, {}, options)).status, status); noEffects(); equal(getFixture().state.clients.length, 0);
});
Deno.test('notifications native bounds bytes before decoding', async () => {
  equal((await run(' '.repeat(32_769))).status, 413); noEffects();
});
Deno.test('notifications native refuses malformed UTF-8', async () => {
  equal((await run(Uint8Array.of(123, 34, 120, 34, 58, 34, 255, 34, 125))).status, 400); noEffects();
});
Deno.test('notifications native honors caller cancellation', async () => {
  const controller = new AbortController(); controller.abort();
  equal((await run(undefined, {}, { signal: controller.signal })).status, 408); noEffects();
});
Deno.test('notifications native fails closed when preferences cannot be read', async () => {
  const response = await run(undefined, { preferences: { data: null, error: { message: PRIVATE } } });
  equal(response.status, 503); noEffects(); equal((await response.text()).includes(PRIVATE), false);
});
Deno.test('notifications native preserves nullable preference defaults', async () => {
  equal((await run(undefined, { preferences: { data: prefs(Object.fromEntries(FLAGS.map(key => [key, null]))), error: null } })).status, 201);
  equal(getFixture().state.emails.length, 1);
});
Deno.test('notifications native respects disabled types', async () => {
  equal((await run(undefined, { preferences: { data: prefs({ alert_enabled: false }), error: null } })).status, 200); noEffects();
  equal(getFixture().state.identities.length, 0);
});
Deno.test('notifications native refuses an email copied into a mutable profile', async () => {
  const response = await run(payload({ user_id: undefined, user_email: 'copied@example.invalid' }), {
    profile: { data: { user_id: USER, email: 'copied@example.invalid' }, error: null },
  });
  equal(response.status, 400); noEffects();
});
Deno.test('notifications native unconfirmed email keeps only the in-app notification', async () => {
  const response = await run(undefined, { identity: { data: { user: { id: USER, email: EMAIL, email_confirmed_at: null } }, error: null } });
  equal(response.status, 201); equal((await response.json()).email_sent, false);
  equal(getFixture().state.writes.length, 1); equal(getFixture().state.emails.length, 0);
});
Deno.test('notifications native profile without email keeps the previously enabled channel only', async () => {
  equal((await run(undefined, { profile: { data: { user_id: USER, email: null }, error: null } })).status, 201);
  equal(getFixture().state.writes.length, 1); equal(getFixture().state.emails.length, 0); equal(getFixture().state.identities.length, 0);
});
Deno.test('notifications native escapes HTML and preserves a safe URL', async () => {
  const text = '<img src="https://tracker.invalid/pixel">';
  equal((await run(payload({ title: text, message: text, agent_slug: text, action_url: '/dashboard?x=1&y=2' }))).status, 201);
  const html = getFixture().state.emails[0].html;
  equal(html.includes(text), false); equal(html.includes('&lt;img'), true);
  equal(html.includes('href="https://purama-ai.purama.dev/dashboard?x=1&amp;y=2"'), true);
});
Deno.test('notifications native explicit null action URL retains no link', async () => {
  equal((await run(payload({ action_url: null }))).status, 201);
  equal(getFixture().state.writes[0].row.action_url, null);
  equal(getFixture().state.emails[0].html.includes('Voir les détails'), false);
});
Deno.test('notifications native insert failure does not acknowledge success or leak details', async () => {
  const response = await run(undefined, { insert: { data: null, error: { message: PRIVATE } } });
  equal(response.status, 500); equal((await response.text()).includes(PRIVATE), false);
  equal(getFixture().state.writes.length, 1); equal(getFixture().state.emails.length, 0);
});
Deno.test('notifications native email failure keeps one in-app insertion without retry', async () => {
  const response = await run(undefined, { email: new Error(PRIVATE) });
  equal(response.status, 201); equal((await response.json()).email_sent, false);
  equal(getFixture().state.writes.length, 1); equal(getFixture().state.emails.length, 1);
  equal(getFixture().state.logs.join('\n').includes(PRIVATE), false);
});
