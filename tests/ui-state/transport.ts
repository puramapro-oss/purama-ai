import { configFixture, type SettingsTable } from './fixtures';

export const ACCOUNT_A = '00000000-0000-4000-8000-000000000001';
export const ACCOUNT_B = '00000000-0000-4000-8000-000000000002';
export const SESSION_A = '10000000-0000-4000-8000-000000000001';
export const SESSION_B = '10000000-0000-4000-8000-000000000002';
type Result = { data: unknown; error: null | { message: string; code: string }; count?: number };
type Request = { table: string; ownerId: string; sessionId?: string; done: boolean; resolve: (result: Result) => void };
type ReplyRequest = { sessionId: string; message: string; signal?: AbortSignal; done: boolean; resolve: (result: Result) => void };
type WriteRequest = { table: string; ownerId: string; data: Record<string, unknown>; done: boolean; resolve: (result: Result) => void };
type EmailRequest = { name: string; body: Record<string, unknown>; signal?: AbortSignal; done: boolean; resolve: (result: Result) => void };
const loadedConfigs = new Map<string, Record<string, unknown>>();
export const harness = {
  pending: [] as Request[],
  replies: [] as ReplyRequest[],
  writes: [] as { table: string; ownerId: string; payload: Record<string, unknown> }[],
  deferWrites: false,
  pendingWrites: [] as WriteRequest[],
  currentUserId: ACCOUNT_A as string | null,
  emailLogs: [] as Record<string, unknown>[],
  emailCalls: [] as EmailRequest[],
  resolveEmail(index: number, data: unknown, error = false) {
    const pending = harness.emailCalls[index];
    if (!pending || pending.done) throw new Error(`No pending email request ${index}`);
    pending.done = true;
    // Deliberately deliver after cancellation to test actual UI/client guards.
    pending.resolve({ data, error: error ? { message: 'Fixture unavailable', code: '503' } : null });
  },
  setIdentity: (_id: string | null) => {},
  defer(table: string, ownerId: string, sessionId?: string): Promise<Result> {
    return new Promise(resolve => harness.pending.push({ table, ownerId, sessionId, resolve, done: false }));
  },
  resolveConfig(table: SettingsTable, ownerId: string, marker: string, patch: Record<string, unknown> = {}, latest = false) {
    const queue = latest ? [...harness.pending].reverse() : harness.pending;
    const pending = queue.find(p => !p.done && p.table === table && p.ownerId === ownerId);
    if (!pending) throw new Error(`No pending config ${table}:${ownerId}`);
    pending.done = true;
    const data = { ...configFixture(table, ownerId, marker), ...patch };
    loadedConfigs.set(`${table}:${ownerId}`, data);
    pending.resolve({ data, error: null });
  },
  resolveWrite(index: number, error = false) {
    const pending = harness.pendingWrites[index];
    if (!pending || pending.done) throw new Error(`No pending write ${index}`);
    pending.done = true;
    // Deliver even after page teardown; client admission must reject the result.
    pending.resolve(error ? { data: null, error: { message: 'Fixture write unavailable', code: '503' } }
      : { data: pending.data, error: null });
  },
  rejectConfig(table: SettingsTable, ownerId: string) {
    const pending = harness.pending.find(p => !p.done && p.table === table && p.ownerId === ownerId);
    if (!pending) throw new Error(`No pending config ${table}:${ownerId}`);
    pending.done = true;
    pending.resolve({ data: null, error: { message: 'Fixture unavailable', code: '503' } });
  },
  resolveHistory(sessionId: string, ownerId: string, content: string) {
    const pending = harness.pending.find(p => !p.done && p.sessionId === sessionId && p.ownerId === ownerId);
    if (!pending) throw new Error(`No pending history ${sessionId}:${ownerId}`);
    pending.done = true;
    pending.resolve({ data: [{
      id: `message-${sessionId}`, user_id: ownerId, session_id: sessionId, role: 'user', content,
      sources_cited: [], documents_referenced: [], cases_referenced: [],
      confidence: null, category: null, disclaimer_shown: false, created_at: '2026-11-10T00:00:00Z',
    }], error: null });
  },
  resolveReply(sessionId: string, reply: string) {
    const pending = harness.replies.find(p => !p.done && p.sessionId === sessionId);
    if (!pending) throw new Error(`No pending reply ${sessionId}`);
    pending.done = true;
    // Deliberately complete after cancellation to exercise the real helper's late-result guard.
    pending.resolve({ data: { reply, sources: [] }, error: null });
  },
};

class Query implements PromiseLike<Result> {
  filters: Record<string, string> = {};
  payload: Record<string, unknown> | null = null;
  result?: Promise<Result>;
  constructor(readonly table: string) {}
  select() { return this; }
  eq(key: string, value: string) { this.filters[key] = value; return this; }
  order() { return this; }
  limit() { return this; }
  is() { return this; }
  or() { return this; }
  update(payload: Record<string, unknown>) { this.payload = payload; return this; }
  maybeSingle() { return this.run(); }
  single() { return this.run(); }
  run() {
    if (this.result) return this.result;
    const ownerId = this.filters.user_id;
    if (this.payload) {
      harness.writes.push({ table: this.table, ownerId, payload: structuredClone(this.payload) });
      const data = { ...loadedConfigs.get(`${this.table}:${ownerId}`), ...this.payload, user_id: ownerId,
        ...(this.table === 'email_agent_logs' ? { id: this.filters.id } : {}) };
      this.result = harness.deferWrites
        ? new Promise(resolve => harness.pendingWrites.push({ table: this.table, ownerId, data, done: false, resolve }))
        : Promise.resolve({ data, error: null });
    } else if (this.table.endsWith('_agent_config')) {
      this.result = harness.defer(this.table, ownerId);
    } else if (this.table === 'voice_settings') {
      this.result = Promise.resolve({ data: null, error: null });
    } else if (this.table === 'email_agent_logs') {
      const rows = harness.emailLogs.filter(log => log.user_id === ownerId);
      this.result = Promise.resolve({ data: rows, error: null, count: rows.length });
    } else if (['agent_chat_messages', 'agent_chat_history'].includes(this.table)) {
      this.result = Promise.resolve({ data: [], error: null, count: 0 });
    } else if (this.table === 'legal_chat_history') {
      const sessionId = this.filters.session_id;
      this.result = sessionId
        ? ([SESSION_A, SESSION_B].includes(sessionId)
          ? harness.defer(this.table, ownerId, sessionId)
          : Promise.resolve({ data: [], error: null }))
        : Promise.resolve({ data: [
          { session_id: SESSION_A, content: 'Conversation A', created_at: '2026-11-10T00:00:00Z' },
          { session_id: SESSION_B, content: 'Conversation B', created_at: '2026-11-09T00:00:00Z' },
        ], error: null });
    } else throw new Error(`Unexpected fixture query: ${this.table}`);
    return this.result;
  }
  then<T = Result, U = never>(fulfilled?: ((value: Result) => T | PromiseLike<T>) | null,
    rejected?: ((reason: unknown) => U | PromiseLike<U>) | null): Promise<T | U> {
    return this.run().then(fulfilled, rejected);
  }
}
export const supabase = {
  from: (table: string) => new Query(table),
  auth: { getSession: async () => ({ data: { session: harness.currentUserId ? {
    user: { id: harness.currentUserId }, access_token: 'local-fixture-only-token',
  } : null }, error: null }) },
  functions: {
    invoke: (name: string, options: { body: Record<string, unknown>; signal?: AbortSignal }) => {
      if (['email-agent-send-draft', 'email-agent-reconcile-draft'].includes(name)) {
        return new Promise<Result>(resolve => harness.emailCalls.push({
          name, body: structuredClone(options.body), signal: options.signal, done: false, resolve,
        }));
      }
      if (name !== 'legal-chat') throw new Error('No provider call authorized in UI ownership fixture');
      return new Promise<Result>(resolve => harness.replies.push({
        sessionId: String(options.body.session_id), message: String(options.body.message),
        signal: options.signal, done: false, resolve,
      }));
    },
  },
};
declare global { interface Window { uiStateHarness: typeof harness } }
window.uiStateHarness = harness;
