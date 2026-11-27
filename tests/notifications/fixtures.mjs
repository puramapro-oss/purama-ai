// Inert ports shared by the Node and Deno handler recipes. No HTTP client or
// real credential is used; every database write and email attempt is captured.
export const USER = '00000000-0000-4000-8000-000000000001';
export const OTHER_USER = '00000000-0000-4000-8000-000000000002';
export const NOTIFICATION = '00000000-0000-4000-8000-000000000003';
export const EMAIL = 'alice@example.invalid';
export const PRIVATE = 'PRIVATE_NOTIFICATION_customer@example.invalid';
export const SECRET = 'fixture-notification-secret';
export const FLAGS = ['email_enabled', 'task_completed_enabled', 'question_enabled', 'daily_report_enabled', 'alert_enabled'];
export const prefs = overrides => ({ user_id: USER, ...Object.fromEntries(FLAGS.map(key => [key, true])), ...overrides });
export const payload = overrides => ({ user_id: USER, type: 'alert', title: 'Notification', message: 'Une information utile.', ...overrides });

export function createFixture(options = {}) {
  /** @type {{
   * clients: unknown[][],
   * reads: { table: string, columns: string | undefined, filters: [string, unknown][] }[],
   * identities: string[],
   * writes: { table: string, row: Record<string, unknown> }[],
   * emails: { from: string, to: string[], subject: string, html: string }[],
   * logs: string[], network: unknown[][]
   * }} */
  const state = { clients: [], reads: [], identities: [], writes: [], emails: [], logs: [], network: [] };
  const config = {
    WEBHOOK_SECRET: SECRET, SUPABASE_URL: 'https://supabase.fixture.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role', RESEND_API_KEY: 'fixture-resend',
    ...options.env,
  };
  const outcome = async (kind, fallback, query) => {
    const value = Object.hasOwn(options, kind) ? options[kind] : fallback;
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? await value(query) : value;
  };
  const createClient = (...args) => {
    state.clients.push(args);
    return {
      auth: { admin: { getUserById: async id => {
        state.identities.push(id);
        return await outcome('identity', { data: { user: { id: USER, email: EMAIL, email_confirmed_at: '2026-10-01T12:00:00Z' } }, error: null }, id);
      } } },
      from(table) {
        const query = { table, columns: undefined, filters: [] };
        return {
          select(columns) { query.columns = columns; return this; },
          eq(field, value) { query.filters.push([field, value]); return this; },
          async maybeSingle() {
            state.reads.push(query);
            if (table === 'profiles') return await outcome('profile', { data: { user_id: USER, email: EMAIL }, error: null }, query);
            if (table === 'notification_preferences') return await outcome('preferences', { data: prefs(), error: null }, query);
            throw new Error(`Unexpected fixture relation: ${table}`);
          },
          insert(row) { state.writes.push({ table, row: structuredClone(row) }); return this; },
          async single() { return await outcome('insert', { data: { id: NOTIFICATION }, error: null }, query); },
        };
      },
    };
  };
  class Resend {
    constructor(key) { if (key !== config.RESEND_API_KEY) throw new Error('Unexpected fixture credential'); }
    emails = { send: async value => {
      state.emails.push(structuredClone(value));
      return await outcome('email', { data: { id: 'fixture-accepted-email' }, error: null }, value);
    } };
  }
  const log = (...args) => state.logs.push(args.map(String).join(' '));
  const noNetwork = async (...args) => { state.network.push(args); throw new Error('Unexpected network attempt'); };
  return { state, config, createClient, Resend, noNetwork, console: { log, warn: log, error: log, info: log } };
}

export function request(body = payload(), { method = 'POST', secret = SECRET, headers = {}, signal } = {}) {
  const stream = body instanceof ReadableStream;
  return new Request('https://notifications.fixture.invalid/send-notification', {
    method, signal,
    headers: { 'content-type': 'application/json', ...(secret === null ? {} : { 'x-webhook-secret': secret }), ...headers },
    ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? {
      body: typeof body === 'string' || body instanceof Uint8Array || stream ? body : JSON.stringify(body),
      ...(stream ? { duplex: 'half' } : {}),
    } : {}),
  });
}
