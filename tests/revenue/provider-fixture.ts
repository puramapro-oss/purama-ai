import RealStripe from "stripe-sdk-test";
import type { StripeReconciliationEvent } from "../../supabase/functions/_shared/stripe-reconciliation.ts";

type Data = Record<string, unknown>;
export const USER_ID = "00000000-0000-4000-8000-000000000001";
export const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
export const PARTNER_USER_ID = "00000000-0000-4000-8000-000000000003";
export const PLAN_PRICE = "price_1TxuHo4Y1unNvKtXJJRsMOIR";
interface FixtureRow {
  id: string;
  user_id: string;
  promo_code: string;
  expires_at: string;
  beneficiary_name: string;
  contract_status: string;
}
interface SubscriptionRow extends Data {
  id: string;
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  revision: number;
  plan_type: string;
  status: string;
  trial_ends_at: string | null;
  has_used_trial: boolean;
  updated_at: string | null;
}
type Row = FixtureRow & SubscriptionRow;
interface QueryResult<T = Row | null> {
  data: T;
  error: { message: string; code?: string } | null;
}

const defaultSubscription = () => ({
  id: "sub_a",
  object: "subscription",
  customer: "cus_a",
  livemode: false,
  status: "trialing",
  metadata: { user_id: USER_ID } as Record<string, string>,
  trial_start: Math.floor(Date.now() / 1000) - 60,
  trial_end: Math.floor(Date.now() / 1000) + 86_400,
  latest_invoice: "in_current" as string | null,
  items: {
    has_more: false,
    data: [{ price: { product: "prod_UHwPSU2o4DW6Ej" } }],
  },
});

const defaultRow = (): SubscriptionRow => ({
  id: "00000000-0000-4000-8000-000000000101",
  user_id: USER_ID,
  stripe_customer_id: "cus_a",
  stripe_subscription_id: "sub_a",
  revision: 0,
  plan_type: "free",
  status: "active",
  trial_ends_at: null,
  has_used_trial: false,
  updated_at: "2026-01-01T00:00:00.000Z",
});

const defaultCustomer = () => ({
  id: "cus_a", livemode: false, metadata: { user_id: USER_ID },
  deleted: false as boolean,
});

const defaultInvoice = () => ({
  id: "in_current", customer: "cus_a", status: "paid" as string | null,
});

export const state = {
  events: new Map<string, StripeReconciliationEvent>(),
  overageCredits: new Map<string, Data>(),
  writes: [] as Array<{ table: string; operation: string; value: Data }>,
  rpcCalls: 0,
  rpcFailure: false,
  overageFailure: false,
  invalidReceipt: false,
  queryFailure: null as string | null,
  updateReturnsNoRow: false,
  checkoutRequests: [] as RealStripe.Checkout.SessionCreateParams[],
  subscriptionRequests: [] as string[],
  subscriptionListRequests: [] as unknown[],
  invoiceRequests: [] as string[],
  customerRequests: [] as string[],
  userRequests: [] as string[],
  operations: [] as string[],
  clients: [] as Array<{ url: string; key: string; options: unknown }>,
  influencer: null as FixtureRow | null,
  subscription: defaultSubscription(),
  customer: defaultCustomer(),
  invoice: defaultInvoice(),
  invoiceFailure: false,
  subscriptionList: null as ReturnType<typeof defaultSubscription>[] | null,
  subscriptionListHasMore: false,
  subscriptionRows: [defaultRow()] as SubscriptionRow[],
};

export function reset() {
  state.events.clear();
  state.overageCredits.clear();
  state.writes.length = 0;
  state.rpcCalls = 0;
  state.rpcFailure = false;
  state.overageFailure = false;
  state.invalidReceipt = false;
  state.queryFailure = null;
  state.updateReturnsNoRow = false;
  state.checkoutRequests.length = 0;
  state.subscriptionRequests.length = 0;
  state.subscriptionListRequests.length = 0;
  state.invoiceRequests.length = 0;
  state.customerRequests.length = 0;
  state.userRequests.length = 0;
  state.operations.length = 0;
  state.clients.length = 0;
  state.influencer = null;
  state.subscription = defaultSubscription();
  state.customer = defaultCustomer();
  state.invoice = defaultInvoice();
  state.invoiceFailure = false;
  state.subscriptionList = null;
  state.subscriptionListHasMore = false;
  state.subscriptionRows = [defaultRow()];
}

class Query implements PromiseLike<QueryResult<Row[] | null>> {
  private operation = "select";
  private value: Data = {};
  private filters: Array<[string, unknown]> = [];
  private maximum = Infinity;
  constructor(private table: string) {}
  select(_fields = "*") {
    return this;
  }
  eq(field: string, value: unknown) {
    this.filters.push([field, value]);
    return this;
  }
  is(field: string, value: null) {
    return this.eq(field, value);
  }
  update(value: Data) {
    this.operation = "update";
    this.value = value;
    return this;
  }
  insert(value: Data) {
    this.operation = "insert";
    this.value = value;
    return this;
  }
  limit(count: number) {
    this.maximum = count;
    return this;
  }
  private execute(mode: "many" | "maybe" | "single" = "many"): QueryResult<Row | Row[] | null> {
    if (state.queryFailure === `${this.table}:${this.operation}`) {
      return {
        data: null,
        error: { message: "simulated database operation failure" },
      };
    }
    if (this.table === "influencers") {
      return { data: state.influencer as QueryResult["data"], error: null };
    }
    if (this.table !== "subscriptions") {
      throw new Error(`Unexpected legacy table effect: ${this.table}`);
    }
    const rows = state.subscriptionRows.filter((row) =>
      this.filters.every(([field, value]) => row[field] === value)
    ).slice(0, this.maximum);
    if (mode !== "many" && rows.length > 1) {
      return {
        data: null,
        error: { message: "multiple rows", code: "PGRST116" },
      };
    }
    let affected = rows;
    if (this.operation !== "select") {
      if (state.updateReturnsNoRow) return { data: null, error: null };
      // Every entitlement write must follow the append-only journal receipt.
      if (state.events.size === 0) throw new Error("Subscription write before durable journal receipt");
      if (this.operation === "insert") {
        if (state.subscriptionRows.some((row) => row.user_id === this.value.user_id)) {
          return { data: null, error: { message: "duplicate user", code: "23505" } };
        }
        const inserted = { ...defaultRow(), ...structuredClone(this.value) } as SubscriptionRow;
        state.subscriptionRows.push(inserted);
        affected = [inserted];
      } else {
        for (const found of affected) {
          const revision = found.revision;
          Object.assign(found, this.value);
          found.revision = revision + 1;
        }
      }
      if (affected.length) {
        state.writes.push({
          table: this.table,
          operation: this.operation,
          value: this.value,
        });
        state.operations.push(`write:${this.table}:${this.operation}`);
      }
    }
    const result = mode === "many" ? affected : affected[0] ?? null;
    return {
      data: structuredClone(result) as Row | Row[] | null,
      error: !affected.length && mode === "single"
        ? { message: "no row", code: "PGRST116" }
        : null,
    };
  }
  single() {
    return Promise.resolve(this.execute("single") as QueryResult);
  }
  maybeSingle() {
    return Promise.resolve(this.execute("maybe") as QueryResult);
  }
  then<T = QueryResult<Row[] | null>, U = never>(
    fulfilled?: ((value: QueryResult<Row[] | null>) => T | PromiseLike<T>) | null,
    rejected?: ((reason: unknown) => U | PromiseLike<U>) | null,
  ): PromiseLike<T | U> {
    return Promise.resolve(this.execute("many") as QueryResult<Row[] | null>).then(fulfilled, rejected);
  }
}

export function createClient(url: string, key: string, options: unknown) {
  state.clients.push({ url, key, options });
  return {
    auth: {
      getUser: (_token: string) =>
        Promise.resolve({
          data: { user: { id: USER_ID, email: "buyer@example.test" } },
          error: null,
        }),
      admin: {
        getUserById: (id: string) => {
          state.userRequests.push(id);
          return Promise.resolve({
            data: { user: id === USER_ID ? { id: USER_ID, email: "buyer@example.test" } : null },
            error: null,
          });
        },
        listUsers: () => {
          throw new Error("Unsafe email lookup must not run");
        },
      },
    },
    from: (table: string) => new Query(table),
    rpc: (name: string, args: Data) => {
      state.rpcCalls++;
      if (state.rpcFailure) {
        return Promise.resolve({
          data: null,
          error: { message: "simulated database unavailable" },
        });
      }
      if (state.invalidReceipt) {
        return Promise.resolve({ data: {}, error: null });
      }
      if (name === "credit_overage_pack") {
        if (state.overageFailure) {
          return Promise.resolve({
            data: null,
            error: { message: "simulated credit failure" },
          });
        }
        // The journal must already have acknowledged this signed event before
        // the real helper reaches the canonical credit RPC.
        const evidence = state.events.get(
          `platform:${args.p_payment_livemode}:${args.p_stripe_event_id}`,
        );
        const sessionId = args.p_stripe_session_id as string;
        if (!evidence || evidence.object_id !== sessionId) {
          throw new Error("Credit attempted before durable journal receipt");
        }
        const value = {
          user_id: args.p_user_id,
          actions: args.p_actions,
          stripe_session_id: sessionId,
          stripe_payment_intent_id: args.p_stripe_payment_intent_id,
          payment_confirmed_at: args.p_payment_confirmed_at,
          payment_amount_total: args.p_payment_amount_total,
          payment_currency: args.p_payment_currency,
          payment_livemode: args.p_payment_livemode,
          period_start: `${String(args.p_payment_confirmed_at).slice(0, 7)}-01`,
        };
        const prior = state.overageCredits.get(sessionId);
        if (
          prior &&
          Object.entries(value).some(([key, item]) => prior[key] !== item)
        ) {
          return Promise.resolve({
            data: null,
            error: { message: "conflicting credit" },
          });
        }
        if (!prior) {
          state.overageCredits.set(sessionId, value);
          state.writes.push({
            table: "overage_credits",
            operation: "insert",
            value,
          });
        }
        return Promise.resolve({
          data: {
            credited: !prior,
            credit_id: `credit_${sessionId}`,
            period_start: value.period_start,
          },
          error: null,
        });
      }
      if (name !== "record_stripe_reconciliation_event") {
        throw new Error(`Unexpected RPC ${name}`);
      }
      const event = args.p_event as StripeReconciliationEvent;
      const key =
        `${event.stripe_account_key}:${event.livemode}:${event.event_id}`;
      const prior = state.events.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(event)) {
        return Promise.resolve({
          data: null,
          error: { message: "conflicting evidence" },
        });
      }
      state.events.set(key, structuredClone(event));
      state.operations.push(`journal:${event.event_id}`);
      return Promise.resolve({
        data: {
          recorded: true,
          event_id: event.event_id,
          duplicate: Boolean(prior),
          reconciliation: "required",
        },
        error: null,
      });
    },
  };
}

// Keep the real SDK signature verifier and crypto provider. Only HTTP resources
// are substituted, and tests run without network permission.
export class Stripe {
  static createFetchHttpClient = RealStripe.createFetchHttpClient;
  static createSubtleCryptoProvider = RealStripe.createSubtleCryptoProvider;
  webhooks = RealStripe.webhooks;
  constructor(_key: string, _options?: RealStripe.StripeConfig) {
    /* Resource HTTP is replaced below. */
  }
  subscriptions = {
    retrieve: async (id: string) => {
      state.subscriptionRequests.push(id);
      if (id !== state.subscription.id) throw new Error("Unknown inert subscription");
      return structuredClone(state.subscription) as unknown as RealStripe.Subscription;
    },
    list: async (params: unknown) => {
      state.subscriptionListRequests.push(params);
      return {
        data: structuredClone(state.subscriptionList ?? [state.subscription]) as unknown as RealStripe.Subscription[],
        has_more: state.subscriptionListHasMore,
      };
    },
  };
  customers = {
    list: async (_params: unknown) => ({ data: [structuredClone(state.customer)] as unknown as RealStripe.Customer[], has_more: false }),
    retrieve: async (id: string) => {
      state.customerRequests.push(id);
      if (id !== state.customer.id) throw new Error("Unknown inert customer");
      return structuredClone(state.customer) as unknown as RealStripe.Customer;
    },
    create: async (params: RealStripe.CustomerCreateParams, _options: unknown) => ({
      ...structuredClone(state.customer), metadata: params.metadata,
    }) as unknown as RealStripe.Customer,
  };
  invoices = {
    retrieve: async (id: string) => {
      state.invoiceRequests.push(id);
      if (state.invoiceFailure) throw new Error("Inert invoice provider unavailable");
      return structuredClone(state.invoice) as unknown as RealStripe.Invoice;
    },
  };
  checkout = {
    sessions: {
      create: async (params: RealStripe.Checkout.SessionCreateParams, _options?: unknown) => {
        state.checkoutRequests.push(structuredClone(params));
        return { id: "cs_created", url: "https://checkout.stripe.com/test" };
      },
    },
  };
}
// Match the SDK's merged constructor/type namespace for the real handlers.
// These aliases contain no runtime implementation.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Stripe {
  export type Event = RealStripe.Event;
  export type Subscription = RealStripe.Subscription;
  export type Invoice = RealStripe.Invoice;
  export type Customer = RealStripe.Customer;
  export type DeletedCustomer = RealStripe.DeletedCustomer;
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Checkout {
    export type Session = RealStripe.Checkout.Session;
    export type SessionCreateParams = RealStripe.Checkout.SessionCreateParams;
  }
}
export default Stripe;

export async function sign(payload: string): Promise<string> {
  return await RealStripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: "whsec_revenue_test_only",
    cryptoProvider: RealStripe.createSubtleCryptoProvider(),
  });
}
