type Binding = { user_id: string; stripe_account_id: string; [key: string]: unknown };
type DatabaseResult = { data: Binding | null; error: { message: string } | null };

export const fixture: {
  user: { id: string; email: string } | null;
  authError: { message: string } | null;
  lookup: DatabaseResult;
  insertion: DatabaseResult | null;
  events: string[];
  lookupUsers: unknown[];
  inserts: Binding[];
  createdAccounts: unknown[];
  sessions: { account: string; components: Record<string, { enabled: boolean }> }[];
} = {
  user: { id: 'fixture-user-a', email: 'fixture@example.invalid' }, authError: null,
  lookup: { data: null, error: null }, insertion: null,
  events: [], lookupUsers: [], inserts: [], createdAccounts: [], sessions: [],
};

export function resetConnectFixture(): void {
  fixture.user = { id: 'fixture-user-a', email: 'fixture@example.invalid' };
  fixture.authError = null; fixture.lookup = { data: null, error: null }; fixture.insertion = null;
  fixture.events.length = 0; fixture.lookupUsers.length = 0; fixture.inserts.length = 0;
  fixture.createdAccounts.length = 0; fixture.sessions.length = 0;
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'STRIPE_SECRET_KEY']) {
    Deno.env.set(key, key === 'SUPABASE_URL' ? 'https://fixture.invalid' : 'fixture-not-a-credential');
  }
}

class ConnectQuery implements PromiseLike<DatabaseResult> {
  private userId: unknown;
  private inserted: Binding | null = null;
  select(_columns: string): this { return this; }
  eq(column: string, value: unknown): this {
    if (column !== 'user_id') throw new Error('Unexpected Connect query filter');
    this.userId = value; return this;
  }
  maybeSingle(): Promise<DatabaseResult> {
    fixture.events.push('lookup'); fixture.lookupUsers.push(this.userId);
    return Promise.resolve(structuredClone(fixture.lookup));
  }
  insert(value: Binding): this {
    fixture.events.push('insert'); fixture.inserts.push(structuredClone(value));
    this.inserted = structuredClone(value); return this;
  }
  single(): Promise<DatabaseResult> {
    if (!this.inserted) throw new Error('Unexpected Connect insertion receipt');
    return Promise.resolve(structuredClone(fixture.insertion ?? { data: this.inserted, error: null }));
  }
  then<TResult1 = DatabaseResult, TResult2 = never>(
    onfulfilled?: ((value: DatabaseResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.single().then(onfulfilled, onrejected);
  }
}

// Inert adapters only. Deno's test command denies network and subprocesses.
export function createClient(..._args: unknown[]) {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: fixture.user }, error: fixture.authError }) },
    from(table: string) {
      if (table !== 'connect_accounts') throw new Error('Unexpected Connect table');
      return new ConnectQuery();
    },
  };
}

export default class Stripe {
  constructor(_key: string, _options: unknown) {}
  static createFetchHttpClient(): null { return null; }
  accounts = { create: (input: unknown) => {
    fixture.events.push('create-account'); fixture.createdAccounts.push(structuredClone(input));
    return Promise.resolve({ id: 'acct_fixture_created' });
  } };
  accountSessions = { create: (input: { account: string; components: Record<string, { enabled: boolean }> }) => {
    fixture.events.push('create-session'); fixture.sessions.push(structuredClone(input));
    return Promise.resolve({ client_secret: 'fixture-session-only', expires_at: 2000000000 });
  } };
}
