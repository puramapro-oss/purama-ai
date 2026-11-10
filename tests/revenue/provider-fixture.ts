import RealStripe from "stripe-sdk-test";
import type { StripeReconciliationEvent } from "../../supabase/functions/_shared/stripe-reconciliation.ts";

type Data = Record<string, unknown>;
interface FixtureRow {
  id: string;
  user_id: string;
  promo_code: string;
  expires_at: string;
  beneficiary_name: string;
}
interface SubscriptionRow extends Data {
  user_id: string;
  stripe_customer_id: string | null;
}
interface QueryResult {
  data: (FixtureRow & SubscriptionRow) | null;
  error: { message: string; code?: string } | null;
}

const defaultSubscription = () => ({
  id: "sub_a",
  object: "subscription",
  customer: "cus_a",
  status: "trialing",
  metadata: {} as Record<string, string>,
  items: {
    has_more: false,
    data: [{ price: { product: "prod_UHwPSU2o4DW6Ej" } }],
  },
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
  clients: [] as Array<{ url: string; key: string; options: unknown }>,
  influencer: null as FixtureRow | null,
  subscription: defaultSubscription(),
  subscriptionRows: [{
    user_id: "user_a",
    stripe_customer_id: "cus_a",
  }] as SubscriptionRow[],
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
  state.clients.length = 0;
  state.influencer = null;
  state.subscription = defaultSubscription();
  state.subscriptionRows = [{ user_id: "user_a", stripe_customer_id: "cus_a" }];
}

class Query implements PromiseLike<QueryResult> {
  private operation = "select";
  private value: Data = {};
  private filters: Array<[string, unknown]> = [];
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
  private execute(required = false): QueryResult {
    if (state.queryFailure === `${this.table}:${this.operation}`) {
      return {
        data: null,
        error: { message: "simulated database operation failure" },
      };
    }
    if (this.table === "influencers") {
      return { data: state.influencer as QueryResult["data"], error: null };
    }
    const rows = state.subscriptionRows.filter((row) =>
      this.filters.every(([field, value]) => row[field] === value)
    );
    if (rows.length > 1) {
      return {
        data: null,
        error: { message: "multiple rows", code: "PGRST116" },
      };
    }
    const found = rows[0] ?? null;
    if (this.operation !== "select") {
      if (state.updateReturnsNoRow) return { data: null, error: null };
      if (found) {
        Object.assign(found, this.value);
        state.writes.push({
          table: this.table,
          operation: this.operation,
          value: this.value,
        });
      }
    }
    return {
      data: found as QueryResult["data"],
      error: !found && required
        ? { message: "no row", code: "PGRST116" }
        : null,
    };
  }
  single() {
    return Promise.resolve(this.execute(true));
  }
  maybeSingle() {
    return Promise.resolve(this.execute());
  }
  then<T = QueryResult, U = never>(
    fulfilled?: ((value: QueryResult) => T | PromiseLike<T>) | null,
    rejected?: ((reason: unknown) => U | PromiseLike<U>) | null,
  ): PromiseLike<T | U> {
    return Promise.resolve(this.execute()).then(fulfilled, rejected);
  }
}

export function createClient(url: string, key: string, options: unknown) {
  state.clients.push({ url, key, options });
  return {
    auth: {
      getUser: (_token: string) =>
        Promise.resolve({
          data: { user: { id: "user_a", email: "buyer@example.test" } },
        }),
      admin: {
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
      if (name === "apply_stripe_overage_credit") {
        if (state.overageFailure) {
          return Promise.resolve({
            data: null,
            error: { message: "simulated credit failure" },
          });
        }
        const evidence = state.events.get(
          `platform:${args.p_livemode}:${args.p_event_id}`,
        );
        const facts = evidence?.source_facts;
        const userId = (facts?.attribution_hints as Data | undefined)?.user_id;
        const sessionId = evidence?.object_id;
        if (
          !sessionId || !userId || facts?.checkout_mode !== "payment" ||
          facts.checkout_payment_status !== "paid" ||
          facts.checkout_purchase_type !== "overage_pack"
        ) {
          return Promise.resolve({
            data: null,
            error: { message: "invalid paid overage evidence" },
          });
        }
        const prior = state.overageCredits.get(sessionId);
        if (prior && (prior.user_id !== userId || prior.actions !== 2000)) {
          return Promise.resolve({
            data: null,
            error: { message: "conflicting credit" },
          });
        }
        if (!prior) {
          const value = {
            user_id: userId,
            actions: 2000,
            stripe_session_id: sessionId,
          };
          state.overageCredits.set(sessionId, value);
          state.writes.push({
            table: "overage_credits",
            operation: "insert",
            value,
          });
        }
        return Promise.resolve({
          data: {
            credited: true,
            session_id: sessionId,
            duplicate: Boolean(prior),
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
      return state.subscription as unknown as RealStripe.Subscription;
    },
  };
  customers = {
    list: async (_params: unknown) => ({ data: [] as Array<{ id: string }> }),
  };
  checkout = {
    sessions: {
      create: async (params: RealStripe.Checkout.SessionCreateParams) => {
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
