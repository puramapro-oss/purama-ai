import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const allowed = new Set([
  'supabase/functions/create-checkout/index.ts',
  'supabase/functions/customer-portal/index.ts',
  'supabase/functions/_shared/billing-boundary.ts',
  'supabase/functions/_shared/request-body.ts',
  'supabase/functions/_shared/plans.ts',
]);
export const userId = 'fixture-user-a';
export const price = 'price_1TxuHo4Y1unNvKtXJJRsMOIR';
export const packPrice = 'price_1TxuIO4Y1unNvKtXRito4dsU';
export const intent = '20c2b2bd-f987-43c2-8580-63cb11bef540';
export const prices = [
  'price_1TxuHo4Y1unNvKtXhx3LhtPW', 'price_1TxuHo4Y1unNvKtXX4yZ3BlN',
  price, 'price_1TxuHp4Y1unNvKtX1x0UT3ri',
  'price_1TxuHp4Y1unNvKtXU2bagDZs', 'price_1TxuHp4Y1unNvKtXcUIp2Qxb',
];
export const ownedCustomer = (id = userId) => ({ id: 'cus_owned', metadata: { user_id: id } });
export function request(body = { priceId: price, requestId: intent }, options = {}) {
  const { token = 'Bearer fixture-token', method = 'POST', headers, ...rest } = options;
  return new Request('https://edge.invalid/billing', {
    method, headers: { ...(token === null ? {} : { authorization: token }), 'content-type': 'application/json', ...headers },
    ...(method === 'GET' || method === 'OPTIONS' ? {} : { body: typeof body === 'string' || body instanceof ReadableStream || body instanceof Uint8Array ? body : JSON.stringify(body) }),
    ...rest,
  });
}
export function noEffects(h) {
  assert.equal(h.calls.createCustomer.length + h.calls.checkout.length + h.calls.portal.length, 0);
  assert.equal(h.calls.network.length, 0);
}
export async function harness(options = {}, entry = 'create-checkout') {
  const calls = Object.fromEntries(['auth','clients','queries','customerList','retrieve','createCustomer','subscriptions','checkout','portal','network','logs'].map(name => [name, []]));
  const identity = options.userId ?? userId;
  const env = { STRIPE_SECRET_KEY: 'sk_test_fixture_not_live', SUPABASE_URL: 'https://supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key', ...options.env };
  let handler;
  let now = 0;
  const timers = new Map();
  let sequence = 0;
  const schedule = (callback, delay) => {
    if (!options.manualClock) return setTimeout(callback, delay);
    const id = ++sequence; timers.set(id, { callback, due: now + delay }); return id;
  };
  const cancel = id => options.manualClock ? timers.delete(id) : clearTimeout(id);
  const step = async (name, defaultValue, ...args) => {
    if (options[name + 'Throws']) throw new Error('private-provider-error fixture@email.invalid');
    return typeof options[name] === 'function' ? await options[name](...args) : defaultValue;
  };
  function createClient(url, key, config) {
    calls.clients.push({ url, key, config });
    return {
      auth: { getUser: async token => {
        calls.auth.push(token);
        return await step('auth', { data: { user: options.noUser ? null : { id: identity, email: 'fixture@email.invalid' } }, error: options.authError ? { message: 'private-auth-error' } : null });
      } },
      from(table) {
        const query = { table, filters: [] };
        calls.queries.push(query);
        const builder = {
          select(columns) { query.columns = columns; return builder; },
          eq(column, value) { query.filters.push([column, value]); return builder; },
          async maybeSingle() {
            if (table === 'influencers') return await step('referral', { data: options.influencer ?? null, error: options.referralError ? { message: 'private-db-error' } : null }, query);
            assert.equal(table, 'subscriptions');
            return await step('subscriptionRow', { data: Object.hasOwn(options, 'row') ? options.row : { user_id: identity, plan_type: 'free', status: 'active', stripe_customer_id: null }, error: options.rowError ? { message: 'private-db-error' } : null }, query);
          },
          single() { return builder.maybeSingle(); },
          async limit(count) {
            query.limit = count;
            return await step('bindings', { data: options.bindings ?? [], error: options.bindingError ? { message: 'private-db-error' } : null }, query);
          },
        };
        return builder;
      },
    };
  }
  class Stripe {
    static createFetchHttpClient(fetcher) { return { fetcher }; }
    constructor(key, config) {
      calls.stripeConfig = config;
      this.customers = {
        list: async args => { calls.customerList.push(args); return await step('customerList', { data: options.customers ?? [ownedCustomer(identity)], has_more: !!options.customersMore }, args); },
        retrieve: async id => { calls.retrieve.push(id); return await step('retrieve', options.retrieved ?? ownedCustomer(identity), id); },
        create: async (args, extra) => { calls.createCustomer.push({ args, extra }); return await step('createCustomer', { id: 'cus_created', metadata: { ...args.metadata } }, args, extra); },
      };
      this.subscriptions = { list: async args => { calls.subscriptions.push(args); return await step('subscriptions', { data: options.subscriptions ?? [], has_more: !!options.subscriptionsMore }, args); } };
      this.checkout = { sessions: { create: async (args, extra) => { calls.checkout.push({ args, extra }); return await step('checkout', { id: 'cs_fixture', url: options.checkoutUrl ?? 'https://checkout.stripe.com/c/pay/fixture' }, args, extra); } } };
      this.billingPortal = { sessions: { create: async (args, extra) => { calls.portal.push({ args, extra }); return await step('portal', { id: 'bps_fixture', url: options.portalUrl ?? 'https://billing.stripe.com/p/session/fixture' }, args, extra); } } };
    }
  }
  const context = vm.createContext({
    URL, Request, Response, Headers, AbortController, AbortSignal, ReadableStream,
    TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto,
    performance: options.manualClock ? { now: () => now } : performance,
    setTimeout: schedule, clearTimeout: cancel,
    console: { log: (...args) => calls.logs.push(args), error: (...args) => calls.logs.push(args) },
    Deno: { env: { get: name => env[name] } },
    fetch: async (...args) => { calls.network.push(args); throw new Error('Network forbidden in billing regression tests'); },
  });
  const modules = new Map();
  const virtual = (identifier, exports) => {
    if (!modules.has(identifier)) modules.set(identifier, new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context, identifier }));
    return modules.get(identifier);
  };
  const load = async filename => {
    const relative = path.relative(root, filename);
    assert.ok(allowed.has(relative), `Only reviewed local production imports are allowed: ${relative}`);
    if (modules.has(filename)) return modules.get(filename);
    const source = relative === `supabase/functions/${entry}/index.ts` && options.entrySource !== undefined ? options.entrySource : await readFile(filename, 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, fileName: filename }).outputText;
    const module = new vm.SourceTextModule(code, { context, identifier: filename });
    modules.set(filename, module);
    await module.link(async (specifier, parent) => {
      if (specifier === 'https://deno.land/std@0.190.0/http/server.ts') return virtual(specifier, { serve: value => { handler = value; } });
      if (specifier === 'https://esm.sh/stripe@18.5.0') return virtual(specifier, { default: Stripe });
      if (specifier === 'npm:@supabase/supabase-js@2.91.0') return virtual(specifier, { createClient });
      assert.ok(specifier.startsWith('.'), `External import forbidden: ${specifier}`);
      return load(fileURLToPath(new URL(specifier, pathToFileURL(parent.identifier))));
    });
    return module;
  };
  const module = await load(path.join(root, 'supabase/functions', entry, 'index.ts'));
  await module.evaluate();
  assert.equal(typeof handler, 'function');
  return {
    handler, calls, env, pendingTimers: () => timers.size,
    advance(ms) {
      assert.ok(options.manualClock); now += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.callback(); }
    },
  };
}
