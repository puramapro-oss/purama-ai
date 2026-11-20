import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const OWNER = '11111111-1111-4111-8111-111111111111';
const STATE = 'ef'.repeat(32);

// Runs the actual handler and local imports. Only identity, SQL and provider
// ports are inert; unexpected imports and network destinations fail the test.
function harness(options = {}) {
  let handler;
  const calls = { auth: [], rpc: [], fetches: [], writes: [], logs: [] };
  const env = {
    SUPABASE_URL: 'https://database.fixture.invalid', SUPABASE_ANON_KEY: 'fixture-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', GOOGLE_CLIENT_ID: 'fixture-client',
    GOOGLE_CLIENT_SECRET: 'fixture-secret', APP_URL: 'https://app.fixture.invalid',
    // Deliberately public synthetic encryption fixture, never a production key.
    GMAIL_TOKEN_ENCRYPTION_KEY: btoa('0123456789abcdef'.repeat(2)),
    ...options.env,
  };
  let config = { user_id: OWNER, gmail_email: 'owner@fixture.invalid', gmail_refresh_token: 'fixture-existing-encrypted-refresh' };
  let consumed = false;
  function createClient(_url, key) {
    return {
      auth: {
        getUser: async token => {
          calls.auth.push(token);
          return { data: { user: token === 'fixture-owner' && !(options.revokeAfterStart && calls.auth.length > 1) ? { id: OWNER } : null }, error: null };
        },
        admin: { getUserById: async id => ({ data: { user: id === OWNER ? { id } : null }, error: null }) },
      },
      rpc(name, args) {
        const result = (async () => {
          assert.equal(key, 'fixture-service');
          calls.rpc.push({ name, args });
          if (options.stateDbError) return { data: null, error: { message: 'private-state-detail' } };
          if (name === 'create_oauth_connection_state') {
            assert.equal(args.p_user_id, OWNER);
            return { data: new Date(Date.now() + 600_000).toISOString(), error: null };
          }
          assert.equal(name, 'consume_oauth_connection_state');
          const valid = !consumed && !options.expired && args.p_purpose === 'email_agent_gmail' && args.p_actor_id === OWNER
            && args.p_state_hash === createHash('sha256').update(STATE).digest('hex');
          if (!valid) return { data: [], error: null };
          consumed = true;
          return { data: [{ user_id: OWNER, provider: 'gmail', return_path: '/dashboard/email-agent' }], error: null };
        })();
        result.abortSignal = () => result;
        return result;
      },
      from(table) {
        assert.equal(table, 'email_agent_config');
        let values;
        const filters = {};
        let result;
        const execute = single => {
          if (result) return result;
          result = Promise.resolve().then(() => {
            if (!values) return { data: options.noPrevious ? null : config,
              error: options.readError ? { message: 'private-read-detail' } : null };
            calls.writes.push({ values, filters: { ...filters } });
            if (options.writeError) return { data: null, error: { message: 'private-write-detail' } };
            if (options.missingWrite) return { data: single ? null : [], error: null };
            config = { ...config, ...values };
            return { data: single ? config : [config], error: null };
          });
          return result;
        };
        const query = {
          select() { return query; }, eq(k, v) { filters[k] = v; return query; },
          upsert(row) { values = row; return query; }, update(row) { values = row; return query; },
          abortSignal() { return query; },
          single() { return execute(true); }, maybeSingle() { return execute(true); },
          then(yes, no) { return execute(false).then(yes, no); },
        };
        return query;
      },
    };
  }
  async function providerFetch(input, init) {
    const url = String(input); calls.fetches.push({ url, init });
    if (options.providerPending) return new Promise(() => {});
    if (options.providerThrows) throw new Error('private-provider-detail');
    if (url === 'https://oauth2.googleapis.com/token') return options.tokenResponse?.()
      ?? Response.json(options.tokens ?? { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 });
    if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') return options.profileResponse?.()
      ?? Response.json({ email: 'owner@fixture.invalid', verified_email: true });
    throw new Error(`Unexpected network destination: ${url}`);
  }
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const module = { exports: {} }; cache.set(file, module.exports);
    const requireModule = specifier => {
      if (specifier.includes('@supabase/supabase-js')) return { createClient };
      if (specifier.startsWith('.')) return load(resolve(dirname(file), specifier));
      throw new Error(`Unexpected import: ${specifier}`);
    };
    runInNewContext(compiled, {
      module, exports: module.exports, require: requireModule,
      Deno: { env: { get: name => env[name] }, serve: fn => { handler = fn; } },
      fetch: providerFetch, crypto: webcrypto, Request, Response, Headers, URL, URLSearchParams,
      TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa, AbortController, performance,
      setTimeout: (fn, delay) => setTimeout(fn, options.timerLimit ? Math.min(delay, options.timerLimit) : delay),
      clearTimeout, console: { error: (...args) => calls.logs.push(args), warn: (...args) => calls.logs.push(args), log() {} },
    }, { filename: file });
    return module.exports;
  }
  load(resolve(options.sourceRoot ?? root, 'supabase/functions/email-agent-gmail-oauth/index.ts'));
  return { handler, calls, getConfig: () => config };
}

function callback(state = STATE, options = {}) {
  if (options.providerGet) return new Request(`https://database.fixture.invalid/functions/v1/email-agent-gmail-oauth?code=fixture-code&state=${state}`);
  return new Request('https://database.fixture.invalid/functions/v1/email-agent-gmail-oauth', {
    method: 'POST', headers: { Authorization: `Bearer ${options.token ?? 'fixture-owner'}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'callback', code: 'fixture-code', state }), signal: options.signal,
  });
}

test('raw user identifier is rejected before Google exchange or persistence', async () => {
  const { handler, calls } = harness();
  const response = await handler(callback(OWNER, { providerGet: true }));
  assert.equal(calls.fetches.length, 0);
  assert.equal(calls.writes.length, 0);
  assert.doesNotMatch(response.headers.get('Location') ?? '', /gmail=connected/);
});

test('a rejected database write cannot redirect as connected', async () => {
  const { handler, calls } = harness({ writeError: true });
  const response = await handler(callback());
  assert.equal(calls.writes.length, 1);
  assert.equal(response.status, 500);
  assert.doesNotMatch(response.headers.get('Location') ?? '', /gmail=connected/);
  assert.doesNotMatch(await response.text(), /fixture-access|fixture-refresh|private-write-detail/);
});

test('start produces a random server-recorded state instead of exposing the actor id', async () => {
  const { handler, calls } = harness();
  const response = await handler(new Request('https://functions.fixture.invalid/gmail', {
    method: 'POST', headers: { Authorization: 'Bearer fixture-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start' }),
  }));
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).url);
  assert.match(url.searchParams.get('state'), /^[a-f0-9]{64}$/);
  assert.notEqual(url.searchParams.get('state'), OWNER);
  assert.equal(calls.rpc[0].args.p_user_id, OWNER);
  assert.equal(calls.rpc[0].args.p_purpose, 'email_agent_gmail');
});

test('a failed Google profile request cannot create a connected account', async () => {
  const { handler, calls } = harness({ profileResponse: () => Response.json({ email: 'attacker@fixture.invalid' }, { status: 503 }) });
  const response = await handler(callback());
  assert.equal(calls.writes.length, 0);
  assert.equal(response.status, 500);
  assert.doesNotMatch(response.headers.get('Location') ?? '', /gmail=connected/);
});

test('provider GET only relays to the fixed frontend without consuming or exchanging', async () => {
  const { handler, calls } = harness();
  const response = await handler(callback(STATE, { providerGet: true }));
  assert.equal(response.status, 302);
  const destination = new URL(response.headers.get('Location'));
  assert.equal(destination.origin, 'https://app.fixture.invalid');
  assert.equal(destination.pathname, '/oauth/callback');
  assert.equal(destination.searchParams.get('state'), STATE);
  assert.equal(calls.rpc.length, 0);
  assert.equal(calls.fetches.length, 0);
  assert.equal(calls.writes.length, 0);
});

test('a valid random state does not substitute for the initiating actor', async () => {
  const { handler, calls } = harness();
  const response = await handler(callback(STATE, { token: 'invalid-user' }));
  assert.equal(response.status, 401);
  assert.equal(calls.rpc.length, 0);
  assert.equal(calls.fetches.length, 0);
});

test('successful completion returns a receipt without credentials', async () => {
  const { handler, calls, getConfig } = harness();
  const response = await handler(callback());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, provider: 'gmail', returnUrl: '/dashboard/email-agent' });
  assert.equal(calls.rpc[0].args.p_actor_id, OWNER);
  assert.equal(calls.writes[0].values.user_id, OWNER);
  assert.notEqual(getConfig().gmail_access_token, 'fixture-access');
  assert.notEqual(getConfig().gmail_refresh_token, 'fixture-refresh');
});

test('replayed and simultaneous callbacks start only one provider exchange', async () => {
  const { handler, calls } = harness();
  const responses = await Promise.all(Array.from({ length: 8 }, () => handler(callback())));
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.equal(responses.filter(response => response.status === 409).length, 7);
  assert.equal(calls.fetches.length, 2);
  assert.equal(calls.writes.length, 1);
});

test('expired state is refused before any provider effect', async () => {
  const { handler, calls } = harness({ expired: true });
  const response = await handler(callback());
  assert.equal(response.status, 409);
  assert.equal(calls.fetches.length, 0);
});

test('missing refresh token preserves only the same verified Google account', async () => {
  const { handler, getConfig } = harness({ tokens: { access_token: 'fixture-access', expires_in: 3600 } });
  const response = await handler(callback());
  assert.equal(response.status, 200);
  assert.equal(getConfig().gmail_refresh_token, 'fixture-existing-encrypted-refresh');
});

test('missing refresh token never mixes another Google account with old credentials', async () => {
  const { handler, calls } = harness({ tokens: { access_token: 'fixture-access', expires_in: 3600 },
    profileResponse: () => Response.json({ email: 'different@fixture.invalid', verified_email: true }) });
  assert.equal((await handler(callback())).status, 500);
  assert.equal(calls.writes.length, 0);
});

test('missing refresh authorization for a first connection fails closed', async () => {
  const { handler, calls } = harness({ noPrevious: true, tokens: { access_token: 'fixture-access', expires_in: 3600 } });
  assert.equal((await handler(callback())).status, 500);
  assert.equal(calls.writes.length, 0);
});

test('zero returned rows cannot be acknowledged as persisted', async () => {
  const { handler } = harness({ missingWrite: true });
  assert.equal((await handler(callback())).status, 500);
});

test('cancelled callback cannot consume state or contact Google', async () => {
  const controller = new AbortController(); controller.abort();
  const { handler, calls } = harness();
  assert.notEqual((await handler(callback(STATE, { signal: controller.signal }))).status, 200);
  assert.equal(calls.rpc.length, 0);
  assert.equal(calls.fetches.length, 0);
});

test('a non-cooperative provider is bounded without a late write', async () => {
  const { handler, calls } = harness({ providerPending: true, timerLimit: 25 });
  assert.equal((await handler(callback())).status, 504);
  assert.equal(calls.writes.length, 0);
});

test('private provider and database diagnostics are never returned or logged', async () => {
  const { handler, calls } = harness({ providerThrows: true });
  const response = await handler(callback());
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private-provider-detail|fixture-secret/);
  assert.doesNotMatch(JSON.stringify(calls.logs), /private-provider-detail|fixture-secret/);
});

test('state database failure cannot start token exchange', async () => {
  const { handler, calls } = harness({ stateDbError: true });
  assert.equal((await handler(callback())).status, 500);
  assert.equal(calls.fetches.length, 0);
});

test('configured application origin cannot redirect to an executable scheme', async () => {
  const { handler, calls } = harness({ env: { APP_URL: 'javascript:alert(1)' } });
  const response = await handler(callback(STATE, { providerGet: true }));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('Location'), null);
  assert.equal(calls.fetches.length, 0);
});

test('revoked actor after provider exchange cannot persist credentials', async () => {
  const { handler, calls } = harness({ revokeAfterStart: true });
  assert.equal((await handler(callback())).status, 401);
  assert.equal(calls.auth.length, 2);
  assert.equal(calls.writes.length, 0);
});

test('partial Google consent cannot be reported as a ready Gmail connection', async () => {
  const { handler, calls } = harness({ tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly' } });
  assert.equal((await handler(callback())).status, 403);
  assert.equal(calls.fetches.length, 1);
  assert.equal(calls.writes.length, 0);
});

test('gmail.modify grants the sending capability without a redundant scope entry', async () => {
  const { handler } = harness({ tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.email' } });
  assert.equal((await handler(callback())).status, 200);
});
