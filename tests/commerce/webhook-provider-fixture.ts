/* eslint-disable @typescript-eslint/no-explicit-any */
// This is an inert SDK boundary for the real edge handler. No provider module,
// socket, message, real credential or network request is involved.
export type Invoice = {
  id: string; status: string | null; customer: string | { id: string };
  subscription?: string | null; billing_reason?: string | null;
};
export type Subscription = {
  id: string; status: string; customer: string | { id: string };
  livemode: boolean; metadata: Record<string, string>; trial_start: number | null;
  items: { has_more?: boolean; data: { price: { product: string | { id: string; deleted?: boolean } } }[] };
  latest_invoice: string | Invoice | null; trial_end: number | null;
};
type Session = {
  id: string; mode: string; status?: string; payment_status?: string;
  subscription?: string | Subscription | null; customer?: string | { id: string } | null;
  customer_email?: string | null; customer_details?: { email?: string | null };
  metadata?: Record<string, string>; [key: string]: unknown;
};
type Event = { id: string; type: string; data: { object: unknown }; created: number; livemode: boolean; account?: string };

export const fixture: {
  subscription: Subscription; invoice: Invoice; event: Event | null;
  customer: { id: string; livemode: boolean; metadata: Record<string, string>; deleted?: boolean };
  authUser: { id: string; email: string } | null;
  subscriptionRow: Record<string, any>; users: { id: string; email: string }[];
  calls: { operation: string; value?: unknown }[]; writes: { table: string; operation: string; value: any }[];
  failPersistence: boolean; failSignature: boolean; creditedSessions: Set<string>;
  observations: Map<string, Record<string, unknown>>;
  influencer: Record<string, any> | null;
  additionalSubscriptions: Record<string, any>[]; subscriptionAbsent: boolean;
  failLookup: boolean; missingWriteReceipt: boolean; changeCustomerOnWrite: string | null;
  failUserPage: number | null; malformedUserPage: number | null; repeatUserPage: boolean; neverEndingUserPages: boolean;
} = {} as typeof fixture;

export function resetFixture(): void {
  fixture.invoice = { id: 'in_fixture', status: 'paid', customer: 'cus_fixture', subscription: 'sub_fixture' };
  fixture.subscription = {
    id: 'sub_fixture', status: 'active', customer: 'cus_fixture',
    livemode: false, metadata: { user_id: '00000000-0000-4000-8000-000000002701' }, trial_start: null,
    items: { has_more: false, data: [{ price: { product: 'prod_UHwPSU2o4DW6Ej' } }] },
    latest_invoice: 'in_fixture', trial_end: null,
  };
  fixture.event = null;
  fixture.subscriptionRow = { id: '00000000-0000-4000-8000-000000002702', user_id: '00000000-0000-4000-8000-000000002701', plan_type: 'free',
    status: 'active', stripe_customer_id: 'cus_fixture', stripe_subscription_id: 'sub_fixture', revision: 0,
    has_used_trial: true, trial_ends_at: null,
    updated_at: '2026-01-01T00:00:00.000Z' };
  fixture.users = [{ id: fixture.subscriptionRow.user_id, email: 'fixture@example.invalid' }];
  // The direct identity record is independent of the legacy email-search pages.
  fixture.authUser = structuredClone(fixture.users[0]);
  fixture.customer = { id: 'cus_fixture', livemode: false, metadata: { user_id: fixture.subscriptionRow.user_id } };
  fixture.calls = []; fixture.writes = []; fixture.failPersistence = false; fixture.failSignature = false;
  fixture.creditedSessions = new Set(); fixture.influencer = null;
  fixture.observations = new Map();
  fixture.additionalSubscriptions = []; fixture.subscriptionAbsent = false;
  fixture.failLookup = false; fixture.missingWriteReceipt = false; fixture.changeCustomerOnWrite = null;
  fixture.failUserPage = null; fixture.malformedUserPage = null; fixture.repeatUserPage = false; fixture.neverEndingUserPages = false;
}
resetFixture();

export function createClient(...args: unknown[]) {
  void args;
  return {
    auth: { admin: { getUserById: (id: string) => {
      fixture.calls.push({ operation: 'getUserById', value: id });
      return Promise.resolve({ data: { user: fixture.authUser?.id === id ? structuredClone(fixture.authUser) : null }, error: null });
    }, listUsers: (options: { page?: number; perPage?: number } = {}): Promise<{
      data: { users: { id: string; email: string }[] }; error: { message: string } | null;
    }> => {
      const page = options.page ?? 1; const perPage = options.perPage ?? 50;
      fixture.calls.push({ operation: 'listUsers', value: { page, perPage } });
      if (fixture.failUserPage === page) return Promise.resolve({ data: { users: [] }, error: { message: 'fixture auth failure' } });
      if (fixture.malformedUserPage === page) return Promise.resolve({ data: { users: null as any }, error: null });
      const users = fixture.neverEndingUserPages
        ? Array.from({ length: perPage }, (_, i) => ({ id: `catalog-${page}-${i}`, email: `catalog-${page}-${i}@example.invalid` }))
        : fixture.repeatUserPage ? fixture.users.slice(0, perPage)
        : fixture.users.slice((page - 1) * perPage, page * perPage);
      return Promise.resolve({ data: { users }, error: null });
    } } },
    from(table: string) {
      let operation = 'select'; let value: any; let limit = Infinity; const filters: Record<string, unknown> = {};
      function execute(mode: 'none' | 'single' | 'maybe' = 'none'): Promise<{ data: any; error: { message: string } | null }> {
        fixture.calls.push({ operation: table + '.' + operation, value: { filters: structuredClone(filters) } });
        const allRows = table === 'subscriptions'
          ? [...(fixture.subscriptionAbsent ? [] : [fixture.subscriptionRow]), ...fixture.additionalSubscriptions]
          : table === 'influencers' && fixture.influencer ? [fixture.influencer] : [];
        const matches = (row: Record<string, any>) => Object.entries(filters).every(([key, v]) => row[key] === v);
        if (operation === 'select') {
          if (table === 'subscriptions' && fixture.failLookup) return Promise.resolve({ data: null, error: { message: 'fixture lookup failure' } });
          const rows = allRows.filter(matches).slice(0, limit);
          if (mode !== 'none' && (rows.length > 1 || (mode === 'single' && rows.length === 0))) {
            return Promise.resolve({ data: null, error: { message: 'fixture non-singular row' } });
          }
          return Promise.resolve({ data: mode === 'none' ? structuredClone(rows) : rows[0] ? structuredClone(rows[0]) : null, error: null });
        }
        fixture.writes.push({ table, operation, value: structuredClone(value) });
        if (table === 'subscriptions' && fixture.failPersistence) return Promise.resolve({ data: null, error: { message: 'fixture persistence failure' } });
        if (table === 'subscriptions' && fixture.changeCustomerOnWrite) {
          fixture.subscriptionRow.stripe_customer_id = fixture.changeCustomerOnWrite;
          fixture.changeCustomerOnWrite = null;
        }
        if (operation === 'update') {
          const rows = allRows.filter(matches);
          for (const row of rows) {
            const revision = row.revision;
            Object.assign(row, value);
            if (table === 'subscriptions') row.revision = revision + 1;
          }
          if (mode === 'single') {
            if (rows.length !== 1) return Promise.resolve({ data: null, error: { message: 'fixture write affected zero or multiple rows' } });
            return Promise.resolve({ data: fixture.missingWriteReceipt ? null : structuredClone(rows[0]), error: null });
          }
          return Promise.resolve({ data: fixture.missingWriteReceipt ? null : structuredClone(rows), error: null });
        }
        if (table === 'subscriptions' && operation === 'insert') {
          if (allRows.some(row => row.user_id === value.user_id)) {
            return Promise.resolve({ data: null, error: { message: 'fixture duplicate subscription user' } });
          }
          fixture.subscriptionRow = { id: '00000000-0000-4000-8000-000000002702', trial_ends_at: null,
            has_used_trial: false, stripe_subscription_id: null, revision: 0, ...structuredClone(value) };
          fixture.subscriptionAbsent = false;
          return Promise.resolve({ data: fixture.missingWriteReceipt ? null : [structuredClone(fixture.subscriptionRow)], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }
      return {
        select(...args: unknown[]) { void args; return this; },
        update(patch: unknown) { operation = 'update'; value = patch; return this; },
        insert(patch: unknown) { operation = 'insert'; value = patch; return this; },
        eq(key: string, v: unknown) { filters[key] = v; return this; },
        is(key: string, v: unknown) { filters[key] = v; return this; },
        limit(count: number) { limit = count; return this; },
        single: () => execute('single'), maybeSingle: () => execute('maybe'),
        then(onfulfilled: (result: any) => unknown, onrejected?: (reason: unknown) => unknown) { return execute().then(onfulfilled, onrejected); },
      };
    },
    rpc(name: string, parameters: Record<string, unknown>) {
      fixture.calls.push({ operation: 'rpc.' + name, value: structuredClone(parameters) });
      if (name === 'record_stripe_reconciliation_event') {
        const event = parameters.p_event as Record<string, unknown>;
        const key = `${event.stripe_account_key}:${event.livemode}:${event.event_id}`;
        const prior = fixture.observations.get(key);
        if (prior && JSON.stringify(prior) !== JSON.stringify(event)) {
          return Promise.resolve({ data: null, error: { message: 'conflicting fixture evidence' } });
        }
        fixture.observations.set(key, structuredClone(event));
        return Promise.resolve({ data: { recorded: true, event_id: event.event_id, duplicate: !!prior, reconciliation: 'required' }, error: null });
      }
      if (name !== 'credit_overage_pack') throw new Error('Unexpected RPC: ' + name);
      const session = String(parameters.p_stripe_session_id);
      const credited = !fixture.creditedSessions.has(session);
      fixture.creditedSessions.add(session);
      const period = String(parameters.p_payment_confirmed_at).slice(0, 7) + '-01';
      return Promise.resolve({ data: { credited, credit_id: 'fixture-credit', period_start: period }, error: null });
    },
  };
}

export class Resend {
  constructor(...args: unknown[]) { void args; }
  emails = { send: (value: unknown) => {
    fixture.calls.push({ operation: 'inert.email', value });
    return Promise.resolve({ data: { id: 'inert-email' }, error: null });
  } };
}

class Stripe {
  constructor(...args: unknown[]) { void args; }
  static createFetchHttpClient(): null { return null; }
  static createSubtleCryptoProvider(): null { return null; }
  webhooks = { constructEventAsync: (...args: unknown[]) => {
    void args;
    if (fixture.failSignature) return Promise.reject(new Error('fixture signature rejected'));
    if (!fixture.event) return Promise.reject(new Error('No fixture event'));
    fixture.calls.push({ operation: 'verifySignature' });
    return Promise.resolve(structuredClone(fixture.event));
  } };
  subscriptions = { list: (parameters: unknown) => {
    fixture.calls.push({ operation: 'listSubscriptions', value: parameters });
    return Promise.resolve({ data: [structuredClone(fixture.subscription)], has_more: false });
  }, retrieve: (id: string) => {
    fixture.calls.push({ operation: 'retrieveSubscription', value: id });
    if (id !== fixture.subscription.id) return Promise.reject(new Error('Unknown fixture subscription'));
    return Promise.resolve(structuredClone(fixture.subscription));
  } };
  customers = { retrieve: (id: string) => {
    fixture.calls.push({ operation: 'retrieveCustomer', value: id });
    if (id !== fixture.customer.id) return Promise.reject(new Error('Unknown fixture customer'));
    return Promise.resolve(structuredClone(fixture.customer));
  } };
  invoices = { retrieve: (id: string) => {
    fixture.calls.push({ operation: 'retrieveInvoice', value: id });
    if (id !== fixture.invoice.id) return Promise.reject(new Error('Unknown fixture invoice'));
    return Promise.resolve(structuredClone(fixture.invoice));
  } };
}
// Mirror only the SDK type qualifiers used by the handler, without remote imports.
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Stripe {
  export type Event = EventShape;
  export type Subscription = SubscriptionShape;
  export type Invoice = InvoiceShape;
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Checkout { export type Session = SessionShape; }
}
type SessionShape = Session;
type EventShape = Event;
type SubscriptionShape = Subscription;
type InvoiceShape = Invoice;
export default Stripe;
