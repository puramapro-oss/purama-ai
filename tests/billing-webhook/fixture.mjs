import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

export const userId = '11111111-1111-4111-8111-111111111111';
export const otherUserId = '22222222-2222-4222-8222-222222222222';
const clone = value => structuredClone(value);
const root = new URL('../../', import.meta.url);
const sourcePath = fileURLToPath(new URL('supabase/functions/stripe-webhook/index.ts', root));
const overagePath = fileURLToPath(new URL('supabase/functions/stripe-webhook/overage.ts', root));
const reconciliationPath = fileURLToPath(new URL('supabase/functions/_shared/stripe-reconciliation.ts', root));
const compiled = new Map();

export function subscriptionRow(overrides = {}) {
  return {
    id: `subscription_${overrides.user_id ?? userId}`, user_id: userId,
    stripe_customer_id: null, stripe_subscription_id: null, revision: 0, plan_type: 'free', status: 'active',
    trial_ends_at: null, has_used_trial: false, updated_at: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

export function createFixture(options = {}) {
  const state = {
    event: {
      id: 'evt_fixture', type: 'checkout.session.completed', created: 1800000010, livemode: false,
      data: { object: {
        id: 'cs_fixture', mode: 'subscription', status: 'complete', payment_status: 'paid', livemode: false,
        subscription: 'sub_fixture', customer: 'cus_fixture', created: 1800000000,
        customer_email: 'untrusted-email@example.invalid', client_reference_id: userId,
        metadata: { user_id: userId },
      } },
    },
    subscription: {
      id: 'sub_fixture', customer: 'cus_fixture', status: 'active', livemode: false,
      metadata: { user_id: userId }, trial_end: null, trial_start: null,
      latest_invoice: 'in_fixture',
      items: { has_more: false, data: [{ price: { product: 'prod_UHwPSU2o4DW6Ej' }, current_period_end: 4102444800 }] },
    },
    customer: { id: 'cus_fixture', livemode: false, metadata: { user_id: userId } },
    invoice: { id: 'in_fixture', customer: 'cus_fixture', status: 'paid' }, invoiceError: null,
    subscriptionList: null, subscriptionsHasMore: false,
    users: [{ id: userId, email: 'server-user@example.invalid' }], authError: null,
    tables: { subscriptions: [], influencers: [], commissions: [], notifications: [], profiles: [] },
    failures: [], calls: [], mutations: [], logs: [], credits: new Set(),
    observations: new Map(), journalFailures: [],
    beforeQuery: null, afterSubscriptionList: null, normalizeTimestamps: false,
  };

  function query(table) {
    if (!Object.hasOwn(state.tables, table)) throw new Error(`Unexpected table: ${table}`);
    const spec = { table, action: 'select', filters: [], limit: Infinity, values: undefined, single: false };
    const execute = async () => {
      state.calls.push(clone({ kind: 'database', ...spec }));
      if (state.beforeQuery) await state.beforeQuery(spec);
      const failureIndex = state.failures.findIndex(failure => failure.table === table && failure.action === spec.action);
      const failure = failureIndex < 0 ? null : state.failures.splice(failureIndex, 1)[0];
      if (failure && !failure.afterWrite) return { data: failure.data ?? null, error: failure.error ?? null };
      const rows = state.tables[table];
      const matches = row => spec.filters.every(([key, value]) => row[key] === value);
      let data;
      if (spec.action === 'select') data = rows.filter(matches).slice(0, spec.limit);
      else if (spec.action === 'update') {
        data = rows.filter(matches);
        for (const row of data) {
          const revision = row.revision;
          Object.assign(row, clone(spec.values));
          // Mirrors the BEFORE UPDATE contract; the separate SQL suite runs
          // the actual migration and proves that every writer advances it.
          if (table === 'subscriptions') row.revision = revision + 1;
        }
        if (data.length) state.mutations.push(clone({ table, action: spec.action, values: spec.values, count: data.length }));
      } else if (spec.action === 'insert') {
        if (table === 'subscriptions' && rows.some(row => row.user_id === spec.values.user_id)) {
          return { data: null, error: { code: '23505', message: 'fixture unique user_id violation' } };
        }
        const row = table === 'subscriptions' ? subscriptionRow(spec.values) : { id: `fixture_${rows.length + 1}`, ...clone(spec.values) };
        rows.push(row); data = [row];
        state.mutations.push(clone({ table, action: spec.action, values: spec.values, count: 1 }));
      } else throw new Error(`Unexpected action: ${spec.action}`);
      if (state.normalizeTimestamps) for (const row of data) {
        if (typeof row.trial_ends_at === 'string') row.trial_ends_at = row.trial_ends_at.replace(/(?:\.000)?Z$/, '+00:00');
      }
      if (failure?.afterWrite) return { data: failure.data ?? null, error: failure.error ?? null };
      return { data: clone(spec.single ? (data[0] ?? null) : data), error: null };
    };
    const chain = {
      select() { return chain; },
      eq(key, value) { spec.filters.push([key, value]); return chain; },
      is(key, value) { spec.filters.push([key, value]); return chain; },
      limit(value) { spec.limit = value; return chain; },
      update(values) { spec.action = 'update'; spec.values = values; return chain; },
      insert(values) { spec.action = 'insert'; spec.values = values; return chain; },
      single() { spec.single = true; return execute(); },
      maybeSingle() { spec.single = true; return execute(); },
      then(resolve, reject) { return execute().then(resolve, reject); },
    };
    return chain;
  }

  const database = {
    auth: { admin: {
      async getUserById(id) {
        state.calls.push({ kind: 'getUserById', id });
        return { data: { user: clone(state.users.find(user => user.id === id) ?? null) }, error: state.authError };
      },
      async listUsers() { throw new Error('Email-based auth pagination is forbidden by this fixture'); },
    } },
    from: query,
    async rpc(name, parameters) {
      state.calls.push(clone({ kind: 'rpc', name, parameters }));
      if (name === 'record_stripe_reconciliation_event') {
        const failure = state.journalFailures.shift();
        if (failure && !failure.afterWrite) return { data: failure.data ?? null, error: failure.error ?? null };
        const event = parameters.p_event;
        const key = `${event.stripe_account_key}:${event.livemode}:${event.event_id}`;
        const prior = state.observations.get(key);
        if (prior && JSON.stringify(prior) !== JSON.stringify(event)) {
          return { data: null, error: { message: 'conflicting fixture evidence' } };
        }
        state.observations.set(key, clone(event));
        if (failure?.afterWrite) return { data: failure.data ?? null, error: failure.error ?? null };
        return { data: { recorded: true, event_id: event.event_id, duplicate: !!prior, reconciliation: 'required' }, error: null };
      }
      if (name !== 'credit_overage_pack') throw new Error(`Unexpected RPC: ${name}`);
      const credited = !state.credits.has(parameters.p_stripe_session_id);
      state.credits.add(parameters.p_stripe_session_id);
      return { data: { credited, credit_id: 'credit_fixture', period_start: `${parameters.p_payment_confirmed_at.slice(0, 7)}-01` }, error: null };
    },
  };
  class StripeFixture {
    static createFetchHttpClient() { return { fixture: true }; }
    static createSubtleCryptoProvider() { return { fixture: true }; }
    constructor(key) {
      if (!['sk_test_inert', 'rk_test_inert', 'sk_live_inert', 'rk_live_inert', 'opaque_inert_key'].includes(key)) {
        throw new Error('Only the fixed inert fixture keys are allowed');
      }
      this.webhooks = { constructEventAsync: async (body, signature, secret) => {
        state.calls.push({ kind: 'verifySignature' });
        if (signature !== 'fixture_signature' || secret !== 'whsec_inert') throw new Error('fixture signature invalid');
        // Tests exercise the real handler after the SDK signature boundary;
        // they do not pretend to test Stripe's cryptography.
        return JSON.parse(body);
      } };
      this.subscriptions = {
        retrieve: async id => { state.calls.push({ kind: 'retrieveSubscription', id }); return clone(state.subscription); },
        list: async parameters => {
          state.calls.push(clone({ kind: 'listSubscriptions', parameters }));
          // Capture the provider observation before the test barrier. A second
          // delivery can change provider and database state while this response
          // is in flight; returning a fresh clone afterwards would hide races.
          const page = { data: clone(state.subscriptionList ?? [state.subscription]), has_more: state.subscriptionsHasMore };
          if (state.afterSubscriptionList) await state.afterSubscriptionList(page, parameters);
          return page;
        },
      };
      this.customers = { retrieve: async id => { state.calls.push({ kind: 'retrieveCustomer', id }); return clone(state.customer); } };
      this.invoices = { retrieve: async id => {
        state.calls.push({ kind: 'retrieveInvoice', id });
        if (state.invoiceError) throw state.invoiceError;
        return clone(state.invoice);
      } };
    }
  }
  class ResendFixture {
    constructor() { throw new Error('Unexpected email: no mail credentials are exposed in this harness'); }
  }
  let handler;
  const env = { STRIPE_SECRET_KEY: 'sk_test_inert', STRIPE_WEBHOOK_SECRET: 'whsec_inert', SUPABASE_URL: 'https://database.example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service_inert' };
  const context = vm.createContext({
    Request, Response, Headers, URL, Date, JSON, Uint8Array, TextEncoder, TextDecoder,
    console: { log: (...args) => state.logs.push(args.join(' ')) },
    Deno: { env: { get: key => env[key] } },
    fetch: () => { throw new Error('Network access is forbidden in webhook tests'); },
  }, { codeGeneration: { strings: false, wasm: false } });
  const modules = new Map();
  function load(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const source = path === sourcePath && options.source !== undefined ? options.source : readFileSync(path, 'utf8');
    const cacheKey = `${path}\n${source}`;
    if (!compiled.has(cacheKey)) {
      const output = ts.transpileModule(source, { fileName: path, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
      const errors = output.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [];
      if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => '', getCanonicalFileName: value => value, getNewLine: () => '\n' }));
      compiled.set(cacheKey, output.outputText);
    }
    const module = { exports: {} }; modules.set(path, module);
    const requireFixture = specifier => {
      if (specifier === 'https://deno.land/std@0.190.0/http/server.ts') return { serve: value => {
        if (handler) throw new Error('Multiple server registrations');
        handler = value;
      } };
      if (specifier === 'https://esm.sh/stripe@18.5.0') return { default: StripeFixture, __esModule: true };
      if (specifier === 'https://esm.sh/@supabase/supabase-js@2.91.0') return { createClient: () => database };
      if (specifier === 'https://esm.sh/resend@2.0.0') return { Resend: ResendFixture };
      if (path === sourcePath && specifier === './overage.ts') return load(overagePath);
      if (path === sourcePath && specifier === '../_shared/stripe-reconciliation.ts') return load(reconciliationPath);
      throw new Error(`Unapproved module import: ${specifier}`);
    };
    const factory = new vm.Script(`(function(require, module, exports) {\n${compiled.get(cacheKey)}\n})`, { filename: path }).runInContext(context, { timeout: 1000 });
    factory(requireFixture, module, module.exports);
    return module.exports;
  }
  load(sourcePath);
  if (typeof handler !== 'function') throw new Error('The real handler was not captured');
  return {
    state, env,
    async deliver({ signature = 'fixture_signature', event = state.event } = {}) {
      const headers = { 'content-type': 'application/json' };
      if (signature !== null) headers['stripe-signature'] = signature;
      return handler(new Request('https://webhook.example.invalid/', { method: 'POST', headers, body: JSON.stringify(event) }));
    },
  };
}
