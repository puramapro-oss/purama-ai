import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import ts from 'typescript';

export const OWNER = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const STATE = 'ab'.repeat(32);
export const root = fileURLToPath(new URL('../../', import.meta.url));

/** The real Edge source and its local imports run unchanged. Only external ports
 * are replaced. No key, network, account or database from the user is loaded. */
export function oauthHarness(options = {}) {
  let handler;
  const calls = { auth: [], clients: [], provider: [], queries: [], writes: [], rpc: [], logs: [] };
  const env = {
    SUPABASE_URL: 'https://database.fixture.invalid',
    SUPABASE_ANON_KEY: 'fixture-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service',
    GOOGLE_CLIENT_ID: 'fixture-google-client',
    GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
    ...options.env,
  };
  const states = new Map();
  if (options.initialState !== false) states.set(createHash('sha256').update(STATE).digest('hex'), {
    user_id: options.stateOwner ?? OWNER,
    provider: options.stateProvider ?? 'gmail',
    purpose: options.statePurpose ?? 'google_connections',
    return_path: '/mes-connexions',
    expires_at: Date.now() + 600_000,
    consumed: false,
  });
  const connections = new Map([[OWNER, {
    id: '33333333-3333-4333-8333-333333333333', user_id: OWNER, provider: 'gmail',
    access_token: 'fixture-old-access', refresh_token: 'fixture-refresh',
    token_expires_at: '2026-11-10T01:00:00Z', updated_at: '2026-11-10T00:00:00Z',
  }], [OTHER, {
    id: '44444444-4444-4444-8444-444444444444', user_id: OTHER, provider: 'gmail',
    access_token: 'fixture-other-access', refresh_token: 'fixture-other-refresh',
    token_expires_at: '2026-11-10T01:00:00Z', updated_at: '2026-11-10T00:00:00Z',
  }]]);

  function createClient(_url, key, config) {
    const service = key === 'fixture-service';
    calls.clients.push({ service, schema: config?.db?.schema });
    return {
      auth: { getUser: async token => {
        calls.auth.push(token);
        if (options.authPending) return new Promise(() => {});
        if (options.authThrows) throw new Error('private-auth-error');
        const id = options.revokeOnRecheck && calls.auth.length > 1 ? null
          : token === 'fixture-owner' ? OWNER : token === 'fixture-other' ? OTHER : null;
        return { data: { user: id && !options.authFailure ? { id } : null },
          error: id && !options.authFailure ? null : { message: 'private-auth-error' } };
      } },
      rpc(name, args) {
        const promise = (async () => {
          calls.rpc.push({ name, args, service });
          if (!service) throw new Error('OAuth state must use the service boundary');
          if (options.stateDbFailure) return { data: null, error: { message: 'private-state-error' } };
          if (name === 'create_oauth_connection_state') {
            states.set(args.p_state_hash, { user_id: args.p_user_id, purpose: args.p_purpose,
              provider: args.p_provider, return_path: args.p_purpose === 'google_connections'
                ? '/mes-connexions' : '/dashboard/email-agent', expires_at: Date.now() + 600_000, consumed: false });
            return { data: new Date(Date.now() + 600_000).toISOString(), error: null };
          }
          if (name !== 'consume_oauth_connection_state') throw new Error(`Unexpected RPC ${name}`);
          const state = states.get(args.p_state_hash);
          if (!state || state.consumed || options.expiredState || state.expires_at <= Date.now() ||
            state.purpose !== args.p_purpose ||
            !args.p_actor_id || args.p_actor_id !== state.user_id) return { data: [], error: null };
          state.consumed = true;
          return { data: [{ user_id: state.user_id, provider: state.provider, return_path: state.return_path }], error: null };
        })();
        promise.abortSignal = () => promise;
        return promise;
      },
      from(table) {
        const filters = {};
        let operation = 'select'; let values;
        let result;
        function execute(single = false) {
          if (result) return result;
          result = (async () => {
            calls.queries.push({ table, operation, filters: { ...filters } });
            if (table !== 'user_connections') throw new Error(`Unexpected table ${table}`);
            const owner = values?.user_id ?? filters.user_id;
            if (operation === 'select') return { data: connections.get(owner) ?? null,
              error: options.readFailure ? { message: 'private-read-error' } : null };
            calls.writes.push({ table, operation, values, filters: { ...filters }, service });
            if (options.writeFailure) return { data: null, error: { message: 'private-write-error' } };
            if (operation === 'update' && options.missingUpdate) return { data: single ? null : [], error: null };
            const previous = connections.get(owner) ?? { id: 'fixture-new-connection' };
            const next = { ...previous, ...values };
            connections.set(owner, next);
            return { data: single ? next : [next], error: null };
          })();
          return result;
        }
        const query = {
          select() { return query; }, eq(key, value) { filters[key] = value; return query; },
          is(key, value) { filters[key] = value; return query; },
          upsert(next) { operation = 'upsert'; values = next; return query; },
          update(next) { operation = 'update'; values = next; return query; },
          abortSignal() { return query; },
          single() { return execute(true); }, maybeSingle() { return execute(true); },
          then(accept, reject) { return execute().then(accept, reject); },
        };
        return query;
      },
    };
  }

  async function providerFetch(input, init) {
    const url = String(input);
    calls.provider.push({ url, init });
    if (url !== 'https://oauth2.googleapis.com/token') throw new Error('Unexpected network blocked');
    if (options.providerPending) return new Promise(() => {});
    if (options.providerThrows) throw new Error('private-provider-error');
    if (options.providerResponse) return options.providerResponse();
    return Response.json(options.tokens ?? { access_token: 'fixture-new-access',
      refresh_token: 'fixture-new-refresh', expires_in: 3600, token_type: 'Bearer' });
  }

  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const source = readFileSync(file, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const module = { exports: {} }; cache.set(file, module.exports);
    const requireModule = specifier => {
      if (specifier.includes('@supabase/supabase-js')) return { createClient };
      if (specifier.startsWith('.')) return load(resolve(dirname(file), specifier));
      throw new Error(`Unexpected import blocked: ${specifier}`);
    };
    runInNewContext(compiled, {
      module, exports: module.exports, require: requireModule,
      Deno: { env: { get: name => env[name] }, serve: fn => { handler = fn; } },
      fetch: providerFetch, crypto: webcrypto, Request, Response, Headers, URL, URLSearchParams,
      TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa, AbortController,
      performance, setTimeout: (fn, delay) => setTimeout(fn, options.timerLimit ? Math.min(delay, options.timerLimit) : delay),
      clearTimeout, console: { error: (...args) => calls.logs.push(args), warn: (...args) => calls.logs.push(args), log: (...args) => calls.logs.push(args) },
    }, { filename: file });
    return module.exports;
  }
  load(resolve(options.sourceRoot ?? root, 'supabase/functions/oauth-google/index.ts'));
  if (typeof handler !== 'function') throw new Error('Real handler did not register');
  return { handler, calls, states, connections, load };
}

export function oauthRequest(action, body = {}, token = 'fixture-owner', options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (options.legacyGet) {
    const url = new URL('https://functions.fixture.invalid/oauth-google');
    url.searchParams.set('action', action);
    for (const [name, value] of Object.entries(body)) url.searchParams.set(name, String(value));
    return new Request(url, { headers, signal: options.signal });
  }
  return new Request(`https://functions.fixture.invalid/oauth-google?action=${action}`, {
    method: 'POST', headers, body: JSON.stringify({ action, ...body }), signal: options.signal,
  });
}
