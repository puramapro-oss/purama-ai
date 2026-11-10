
type Result = { data: unknown; error: null | { message: string } };
type Pending = {
  table: string; filters: Record<string, string>; done: boolean;
  resolve: (result: Result) => void;
};
type Reply = {
  endpoint: string; body: Record<string, string>; signal?: AbortSignal; done: boolean;
  resolve: (result: Result) => void;
};
type AuthSession = { user: { id: string; email: string }; access_token: string; refresh_token: string; token_type: string; expires_in: number };
type AuthResult = { data: { session: AuthSession | null }; error: null };
type InitialAuth = { resolve: (result: AuthResult) => void; reject: (error: Error) => void; done: boolean };
function session(id: string | null): AuthSession | null {
  return id ? { user: { id, email: 'fixture@example.invalid' }, access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600 } : null;
}

export const harness = {
  pending: [] as Pending[], replies: [] as Reply[], initialAuth: [] as InitialAuth[],
  authListener: (_event: string, _session: AuthSession | null) => {},
  setIdentity: (_id: string | null) => {}, setAgentType: (_type: string) => {},
  defer(table: string, filters: Record<string, string>): Promise<Result> {
    return new Promise(resolve => harness.pending.push({ table, filters: { ...filters }, done: false, resolve }));
  },
  resolveQuery(index: number, data: unknown, error?: string) {
    const p = harness.pending[index];
    if (!p || p.done) throw new Error('Missing pending query');
    p.done = true; p.resolve({ data, error: error ? { message: error } : null });
  },
  resolveReply(index: number, reply: string) {
    const p = harness.replies[index];
    if (!p || p.done) throw new Error('Missing pending reply');
    p.done = true;
    // The transport deliberately ignores abort so late-result admission is tested.
    p.resolve({ data: { reply, tokens: 1 }, error: null });
  },
  emitAuth(id: string | null) { harness.authListener(id ? 'SIGNED_IN' : 'SIGNED_OUT', session(id)); },
  resolveInitialAuth(id: string | null) {
    const p = harness.initialAuth.find(p => !p.done);
    if (!p) throw new Error('No pending initial auth');
    p.done = true; p.resolve({ data: { session: session(id) }, error: null });
  },
  rejectInitialAuth() {
    const p = harness.initialAuth.find(p => !p.done);
    if (!p) throw new Error('No pending initial auth');
    p.done = true; p.reject(new Error('Session unavailable'));
  },
};

class Query implements PromiseLike<Result> {
  filters: Record<string, string> = {};
  result?: Promise<Result>;
  constructor(readonly table: string) {}
  select() { return this; }
  update() { return this; }
  delete() { return this; }
  eq(key: string, value: string) { this.filters[key] = value; return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { return this.run(); }
  single() { return this.run(); }
  run() {
    if (this.result) return this.result;
    if (this.table === 'voice_settings') this.result = Promise.resolve({ data: null, error: null });
    else if (this.table === 'creator_agent_runs') this.result = Promise.resolve({ data: [], error: null });
    else if (['agent_chat_messages', 'agent_chat_history', 'creator_agent_chats', 'creator_agents'].includes(this.table)) {
      this.result = harness.defer(this.table, this.filters);
    } else throw new Error(`Unexpected query ${this.table}`);
    return this.result;
  }
  then<T = Result, U = never>(fulfilled?: ((value: Result) => T | PromiseLike<T>) | null,
    rejected?: ((reason: unknown) => U | PromiseLike<U>) | null): Promise<T | U> {
    return this.run().then(fulfilled, rejected);
  }
}
export const supabase = {
  from: (table: string) => new Query(table),
  auth: {
    onAuthStateChange: (listener: typeof harness.authListener) => {
      harness.authListener = listener;
      return { data: { subscription: { unsubscribe() {} } } };
    },
    getSession: () => new Promise<AuthResult>((resolve, reject) => harness.initialAuth.push({ resolve, reject, done: false })),
  },
  functions: { invoke: (endpoint: string, options: { body: Record<string, string>; signal?: AbortSignal }) => {
    if (!['agent-chat', 'creator-agent-chat'].includes(endpoint)) throw new Error(`No provider authorized: ${endpoint}`);
    return new Promise<Result>(resolve => harness.replies.push({ endpoint, body: options.body, signal: options.signal, done: false, resolve }));
  } },
};
declare global { interface Window { asyncHarness: typeof harness } }
window.asyncHarness = harness;
