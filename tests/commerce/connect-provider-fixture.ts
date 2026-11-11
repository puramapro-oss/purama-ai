type Binding = { user_id: string; stripe_account_id: string; [key: string]: unknown };
type DatabaseResult = { data: Binding | null; error: { message: string } | null };
type RpcResult = { data: Record<string, unknown> | null; error: { message: string } | null };
type Provision = {
  user: string; id: string; parameters: Record<string, unknown>; version: string; context: string;
  retryUntil: number; leaseUntil: number; state: 'pending' | 'bound' | 'reconcile';
  account: string | null;
};
export const fixture = {
  user: { id: 'fixture-user-a', email: 'fixture@example.invalid' } as { id: string; email: string } | null,
  authError: null as { message: string } | null,
  lookup: { data: null, error: null } as DatabaseResult,
  insertion: null as DatabaseResult | null,
  events: [] as string[], lookupUsers: [] as unknown[], inserts: [] as Binding[],
  createdAccounts: [] as unknown[],
  sessions: [] as { account: string; components: Record<string, { enabled: boolean }> }[],
  provisionEvents: [] as string[],
  claimArguments: [] as Record<string, unknown>[],
  operation: null as Provision | null,
  persisted: null as Binding | null,
  claimError: null as { message: string } | null,
  claimOverride: null as Record<string, unknown> | null,
  finalizeResults: [] as ('reject' | 'commit-response-lost')[],
  providerResults: [] as ('throw-before' | 'accept-response-lost')[],
  providerAccounts: [] as { key: string; id: string; input: Record<string, unknown> }[],
  createOptions: [] as { idempotencyKey?: string }[],
  stripeOptions: [] as Record<string, unknown>[],
  accountMetadataOverride: undefined as Record<string, unknown> | undefined,
  sessionErrors: [] as boolean[],
  sessionOverride: null as Record<string, unknown> | null,
  now: Date.now(),
  lookupBarrier: 0,
  lookupWaiters: [] as (() => void)[],
};

export function resetConnectFixture(): void {
  fixture.user = { id: 'fixture-user-a', email: 'fixture@example.invalid' };
  fixture.authError = null; fixture.lookup = { data: null, error: null }; fixture.insertion = null;
  fixture.events.length = 0; fixture.lookupUsers.length = 0; fixture.inserts.length = 0;
  fixture.createdAccounts.length = 0; fixture.sessions.length = 0;
  fixture.provisionEvents.length = 0; fixture.claimArguments.length = 0; fixture.operation = null; fixture.persisted = null;
  fixture.claimError = null; fixture.claimOverride = null; fixture.finalizeResults.length = 0;
  fixture.providerResults.length = 0; fixture.providerAccounts.length = 0;
  fixture.createOptions.length = 0; fixture.stripeOptions.length = 0;
  fixture.accountMetadataOverride = undefined; fixture.sessionErrors.length = 0; fixture.sessionOverride = null;
  fixture.now = Date.now(); fixture.lookupBarrier = 0; fixture.lookupWaiters.length = 0;
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'STRIPE_SECRET_KEY']) {
    Deno.env.set(key, key === 'SUPABASE_URL' ? 'https://fixture.invalid' : 'fixture-not-a-credential');
  }
}

// Synthetic qualification input only. It is never selected by the served
// handler and does not adopt or authorize a production financial policy.
export const syntheticCreationPolicy = (email: string | undefined): Record<string, unknown> => ({
  type: 'express', country: 'FR', ...(email ? { email } : {}),
  capabilities: { transfers: { requested: true } },
});

export async function seedConfirmedConnectAccount(account = 'acct_existing'): Promise<void> {
  if (!fixture.user) throw new Error('A fixture user is required');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(Deno.env.get('STRIPE_SECRET_KEY')!));
  const id = '00000000-0000-4000-8000-000000000001';
  fixture.operation = {
    user: fixture.user.id, id,
    parameters: { ...syntheticCreationPolicy(fixture.user.email), metadata: { purama_connect_operation: id } },
    version: '2025-09-30.clover', context: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    retryUntil: fixture.now + 23 * 60 * 60 * 1000, leaseUntil: 0, state: 'bound', account,
  };
  fixture.persisted = { user_id: fixture.user.id, stripe_account_id: account };
}

class ConnectQuery {
  private userId: unknown;
  select(columns: string): this {
    if (columns !== 'user_id, stripe_account_id') throw new Error('Unexpected Connect projection');
    return this;
  }
  eq(column: string, value: unknown): this {
    if (column !== 'user_id') throw new Error('Unexpected Connect query filter');
    this.userId = value; return this;
  }
  async maybeSingle(): Promise<DatabaseResult> {
    fixture.events.push('lookup'); fixture.lookupUsers.push(this.userId);
    const result = structuredClone({ data: fixture.lookup.data ?? fixture.persisted, error: fixture.lookup.error });
    if (fixture.lookupBarrier) await new Promise<void>(resolve => {
      fixture.lookupWaiters.push(resolve);
      if (fixture.lookupWaiters.length === fixture.lookupBarrier) for (const wake of fixture.lookupWaiters) wake();
    });
    return result;
  }
}

async function rpc(name: string, args: Record<string, unknown>): Promise<RpcResult> {
  fixture.provisionEvents.push(name);
  if (name === 'claim_connect_account_provision') {
    fixture.claimArguments.push(structuredClone(args));
    fixture.events.push('lookup'); fixture.lookupUsers.push(args.p_user_id);
    if (fixture.lookup.error) return { data: null, error: fixture.lookup.error };
    if (fixture.claimError) return { data: null, error: fixture.claimError };
    if (fixture.lookupBarrier) await new Promise<void>(resolve => {
      fixture.lookupWaiters.push(resolve);
      if (fixture.lookupWaiters.length === fixture.lookupBarrier) for (const wake of fixture.lookupWaiters) wake();
    });
    if (fixture.operation?.state === 'reconcile') return { data: { decision: 'reconcile', user_id: args.p_user_id }, error: null };
    const existing = fixture.lookup.data ?? fixture.persisted;
    if (!fixture.operation) {
      if (existing || args.p_parameters === null) return { data: { decision: 'reconcile', user_id: args.p_user_id }, error: null };
      const id = '00000000-0000-4000-8000-000000000001';
      fixture.operation = {
        user: String(args.p_user_id), id,
        parameters: { ...structuredClone(args.p_parameters as Record<string, unknown>), metadata: { purama_connect_operation: id } },
        version: String(args.p_api_version), context: String(args.p_provider_context),
        retryUntil: fixture.now + 23 * 60 * 60 * 1000, leaseUntil: 0, state: 'pending', account: null,
      };
    }
    const operation = fixture.operation;
    if (operation.context !== args.p_provider_context || operation.version !== args.p_api_version
      || operation.state === 'reconcile') {
      return { data: { decision: 'reconcile', user_id: operation.user }, error: null };
    }
    if (operation.state === 'bound' || existing) {
      if (operation.state === 'bound' && existing?.user_id === operation.user && existing.stripe_account_id === operation.account) return {
        data: { decision: 'bound', user_id: operation.user, stripe_account_id: operation.account,
          operation_id: operation.id, api_version: operation.version, provider_context: operation.context, ...fixture.claimOverride }, error: null,
      };
      operation.state = 'reconcile';
      return { data: { decision: 'reconcile', user_id: operation.user }, error: null };
    }
    if (args.p_parameters === null || fixture.now >= operation.retryUntil - 15_000) {
      return { data: { decision: 'reconcile', user_id: operation.user }, error: null };
    }
    if (fixture.now < operation.leaseUntil) return { data: { decision: 'busy', user_id: operation.user }, error: null };
    operation.leaseUntil = fixture.now + 60_000;
    return { data: {
      decision: 'create', user_id: operation.user, operation_id: operation.id,
      parameters: structuredClone(operation.parameters), api_version: operation.version, provider_context: operation.context,
      idempotency_key: `connect-create:${operation.id}`, server_now: new Date(fixture.now).toISOString(),
      retry_until: new Date(operation.retryUntil).toISOString(), lease_until: new Date(operation.leaseUntil).toISOString(),
      ...fixture.claimOverride,
    }, error: null };
  }
  if (name !== 'finalize_connect_account_provision') throw new Error('Unexpected Connect RPC');
  const operation = fixture.operation;
  if (!operation || operation.id !== args.p_operation_id || operation.user !== args.p_user_id) {
    return { data: { decision: 'reconcile' }, error: null };
  }
  if (args.p_provider_verified !== true || operation.state === 'reconcile'
    || (operation.account !== null && operation.account !== args.p_account_id)) {
    operation.state = 'reconcile'; return { data: { decision: 'reconcile', user_id: operation.user }, error: null };
  }
  const binding: Binding = { user_id: operation.user, stripe_account_id: String(args.p_account_id) };
  fixture.events.push('insert'); fixture.inserts.push(structuredClone(binding));
  const result = fixture.finalizeResults.shift();
  if (result === 'reject') return { data: null, error: { message: 'fixture-private-write-detail' } };
  const receipt = fixture.insertion ?? { data: binding, error: null };
  if (receipt.error || !receipt.data) return { data: null, error: receipt.error };
  if (receipt.data.user_id === binding.user_id && receipt.data.stripe_account_id === binding.stripe_account_id) {
    fixture.persisted = binding; operation.state = 'bound'; operation.account = binding.stripe_account_id;
  }
  if (result === 'commit-response-lost') return { data: null, error: { message: 'fixture-commit-receipt-lost' } };
  return { data: { decision: 'bound', operation_id: operation.id, ...receipt.data }, error: null };
}

// Inert adapters only; the native Deno command denies network and subprocesses.
// SQL locking, RLS and immutable state are checked independently by PostgreSQL.
export function createClient(..._args: unknown[]) {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: fixture.user }, error: fixture.authError }) },
    from(table: string) {
      if (table !== 'connect_accounts') throw new Error('Unexpected Connect table');
      return new ConnectQuery();
    },
    rpc,
  };
}

export default class Stripe {
  constructor(_key: string, options: Record<string, unknown>) { fixture.stripeOptions.push(options); }
  static createFetchHttpClient(): null { return null; }
  accounts = { create: async (input: unknown, options: { idempotencyKey?: string } = {}) => {
    fixture.events.push('create-account'); fixture.createdAccounts.push(structuredClone(input));
    fixture.createOptions.push(structuredClone(options));
    const outcome = fixture.providerResults.shift();
    if (outcome === 'throw-before') throw new Error('fixture-private-provider-detail');
    const key = options.idempotencyKey ?? `unkeyed:${fixture.createdAccounts.length}`;
    let account = fixture.providerAccounts.find(value => value.key === key);
    const parameters = input as Record<string, unknown>;
    if (!account) {
      account = { key, id: fixture.providerAccounts.length === 0 ? 'acct_fixture_created' : `acct_fixture_created_${fixture.providerAccounts.length + 1}`,
        input: structuredClone(parameters) };
      fixture.providerAccounts.push(account);
    } else if (JSON.stringify(account.input) !== JSON.stringify(parameters)) throw new Error('fixture-idempotency-parameters-mismatch');
    if (outcome === 'accept-response-lost') throw new Error('fixture-private-provider-response-lost');
    return { id: account.id, metadata: structuredClone(fixture.accountMetadataOverride ?? account.input.metadata) as Record<string, unknown> };
  } };
  accountSessions = { create: (input: { account: string; components: Record<string, { enabled: boolean }> }) => {
    fixture.events.push('create-session'); fixture.sessions.push(structuredClone(input));
    if (fixture.sessionErrors.shift()) throw new Error('fixture-private-session-detail');
    return Promise.resolve({ account: input.account, client_secret: 'fixture-session-only',
      expires_at: Math.floor(Date.now() / 1000) + 3600, ...fixture.sessionOverride });
  } };
}
