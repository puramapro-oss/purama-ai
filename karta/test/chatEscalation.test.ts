import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../../supabase/functions/escalate-chat/index.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const { json } = await import(new URL('../../supabase/functions/_shared/response.ts', import.meta.url).href);
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const conversationId = 'abcdef01-0000-4000-8000-000000000011';
type DbResult = { data: unknown; error: unknown };
type Query = { table: string; action: string; selection?: string; patch?: unknown;
  filters: Array<[string, unknown]>; orders: Array<[string, unknown]>; limit?: number };
type Handler = (request: Request) => Promise<Response>;

function harness() {
  const events: string[] = [];
  const queries: Query[] = [];
  const state = {
    env: { SUPABASE_URL: 'https://db.example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
      RESEND_API_KEY: 'test-resend-key' } as Record<string, string | undefined>,
    auth: { data: { user: { id: owner, email: 'owner@example.com', is_anonymous: false } }, error: null } as DbResult,
    conversation: { data: { id: conversationId, user_id: owner, escalated: false }, error: null } as DbResult,
    history: { data: [
      { id: 'm2', role: 'assistant', content: 'Stored answer', created_at: '2026-11-02T01:00:01Z' },
      { id: 'm1', role: 'user', content: 'Stored question', created_at: '2026-11-02T01:00:00Z' },
    ], error: null } as DbResult,
    update: { data: { id: conversationId }, error: null } as DbResult,
    allowed: true,
    onQuery: undefined as ((query: Query) => void) | undefined,
  };
  const getUser = vi.fn(async (_token: string) => { events.push('auth'); return state.auth; });
  const from = vi.fn((table: string) => {
    const query: Query = { table, action: 'select', filters: [], orders: [] };
    queries.push(query);
    const execute = async () => {
      events.push(`${query.action}:${table}`);
      state.onQuery?.(query);
      return table === 'chat_messages' ? state.history : query.action === 'update' ? state.update : state.conversation;
    };
    const builder = {
      select(selection: string) { query.selection = selection; return builder; },
      update(patch: unknown) { query.action = 'update'; query.patch = patch; return builder; },
      eq(column: string, value: unknown) { query.filters.push([column, value]); return builder; },
      in(column: string, value: unknown) { query.filters.push([column, value]); return builder; },
      order(column: string, options: unknown) { query.orders.push([column, options]); return builder; },
      limit(limit: number) { query.limit = limit; return builder; },
      maybeSingle() { return execute(); },
      then(resolve: (result: DbResult) => unknown, reject?: (error: unknown) => unknown) {
        return execute().then(resolve, reject);
      },
    };
    return builder;
  });
  const createClient = vi.fn((_url: string, _key: string, _options: unknown) => ({ auth: { getUser }, from }));
  const rateLimit = vi.fn((_key: string, _max: number, _windowMs: number) => ({ allowed: state.allowed }));
  const fetch = vi.fn(async (_url: Request | string | URL, _init?: RequestInit): Promise<Response> => {
    events.push('mail');
    return Response.json({ id: 'accepted-email-id' });
  });
  let handler: Handler | undefined;
  // Evaluate the real endpoint, substituting only its runtime boundaries. This
  // imports no remote Deno modules and sends no mail or database/network request.
  const require = (name: string) => {
    if (name === 'https://deno.land/std@0.168.0/http/server.ts') return { serve: (value: Handler) => { handler = value; } };
    if (name === 'https://esm.sh/@supabase/supabase-js@2.91.0') return { createClient };
    if (name === '../_shared/response.ts') return { json };
    if (name === '../_shared/rate-limit.ts') return { rateLimit };
    throw new Error(`Unexpected endpoint import: ${name}`);
  };
  new Function('require', 'exports', 'Deno', 'fetch', compiled)(require, {},
    { env: { get: (key: string) => state.env[key] } }, fetch);
  if (!handler) throw new Error('Endpoint did not register a handler');
  return { handle: handler, state, events, queries, getUser, createClient, rateLimit, fetch };
}

function request(body: unknown = { conversationId }, authorization: string | null = 'Bearer account-token', signal?: AbortSignal) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (authorization !== null) headers.set('Authorization', authorization);
  return new Request('https://edge.example.invalid/escalate-chat', {
    method: 'POST', headers, signal, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

afterEach(() => vi.useRealTimers());

it('allows preflight and rejects non-POST methods without downstream work', async () => {
  const h = harness();
  expect((await h.handle(new Request('https://edge.example.invalid', { method: 'OPTIONS' }))).status).toBe(200);
  expect((await h.handle(new Request('https://edge.example.invalid'))).status).toBe(405);
  expect(h.getUser).not.toHaveBeenCalled();
  expect(h.fetch).not.toHaveBeenCalled();
});

it.each([null, '', 'Basic token', 'Bearer ', 'Bearer a b'])('rejects missing or malformed authentication: %s', async authorization => {
  const h = harness();
  expect((await h.handle(request({ conversationId }, authorization))).status).toBe(401);
  expect(h.createClient).not.toHaveBeenCalled();
  expect(h.fetch).not.toHaveBeenCalled();
});

it.each([
  { data: { user: null }, error: { message: 'expired' } },
  { data: { user: { id: owner, email: 'owner@example.com', is_anonymous: true } }, error: null },
])('requires a verified account user rather than a supplied account identifier', async auth => {
  const h = harness(); h.state.auth = auth;
  expect((await h.handle(request({ conversationId, userId: owner }))).status).toBe(401);
  expect(h.getUser).toHaveBeenCalledExactlyOnceWith('account-token');
  expect(h.queries).toEqual([]);
  expect(h.fetch).not.toHaveBeenCalled();
});

it.each([undefined, '', 'not-an-email', 'a\nb@example.com'])('refuses a missing or malformed account email: %s', async email => {
  const h = harness(); h.state.auth = { data: { user: { id: owner, email } }, error: null };
  expect((await h.handle(request())).status).toBe(422);
  expect(h.queries).toEqual([]);
  expect(h.fetch).not.toHaveBeenCalled();
});

it.each(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY'])('fails closed without %s', async key => {
  const h = harness(); delete h.state.env[key];
  expect((await h.handle(request())).status).toBe(503);
  expect(h.queries).toEqual([]);
  expect(h.fetch).not.toHaveBeenCalled();
});

it.each([null, [], {}, { conversationId: 'not-a-uuid' }, '{broken'])('rejects invalid request bodies: %j', async body => {
  const h = harness();
  expect((await h.handle(request(body))).status).toBe(400);
  expect(h.queries).toEqual([]);
  expect(h.fetch).not.toHaveBeenCalled();
});

it('bounds the request bytes even without a Content-Length header', async () => {
  const h = harness();
  expect((await h.handle(request({ conversationId, history: 'x'.repeat(1024) }))).status).toBe(413);
  expect(h.queries).toEqual([]);
  expect(h.fetch).not.toHaveBeenCalled();
});

it.each([null, { id: conversationId, user_id: other, escalated: false },
  { id: conversationId, user_id: null, escalated: false }])('rejects inaccessible or unowned conversations before effects: %j', async data => {
  const h = harness(); h.state.conversation = { data, error: null };
  expect((await h.handle(request())).status).toBe(404);
  expect(h.queries).toHaveLength(1);
  expect(h.queries[0].filters).toEqual([['id', conversationId], ['user_id', owner]]);
  expect(h.fetch).not.toHaveBeenCalled();
});

it('does not treat a client-editable escalated flag as evidence of mail delivery', async () => {
  const h = harness(); h.state.conversation = { data: { id: conversationId, user_id: owner, escalated: true }, error: null };
  const response = await h.handle(request());
  expect(response.status).toBe(409);
  expect(await response.json()).not.toHaveProperty('success', true);
  expect(h.fetch).not.toHaveBeenCalled();
});

it('uses only server account/history values, escapes HTML, and marks only after acceptance', async () => {
  const h = harness();
  h.state.history = { data: [
    { id: 'm2', role: 'assistant', content: 'answer & "quoted"' },
    { id: 'm1', role: 'user', content: '<img src=x onerror="bad()"> & \'test\'' },
  ], error: null };
  const response = await h.handle(request({ conversationId, userEmail: 'attacker@example.com',
    userMessage: 'FORGED', conversationHistory: [{ role: 'user', content: 'FORGED' }] }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true });
  expect(h.fetch).toHaveBeenCalledOnce();
  const [url, init] = h.fetch.mock.calls[0];
  expect(url).toBe('https://api.resend.com/emails');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  const sent = JSON.parse(init?.body as string);
  expect(sent.to).toEqual(['support@purama.app']);
  expect(sent.html).toContain('owner@example.com');
  expect(sent.html).toContain('&lt;img src=x onerror=&quot;bad()&quot;&gt; &amp; &#39;test&#39;');
  expect(sent.html).not.toContain('<img');
  expect(sent.html).not.toContain('attacker@example.com');
  expect(sent.html).not.toContain('FORGED');
  expect(h.events).toEqual(['auth', 'select:chat_conversations', 'select:chat_messages', 'mail', 'update:chat_conversations']);
  expect(h.queries[1]).toMatchObject({ limit: 10, filters: [['conversation_id', conversationId], ['role', ['user', 'assistant']]],
    orders: [['created_at', { ascending: false }], ['id', { ascending: false }]] });
  expect(h.queries[2]).toMatchObject({ patch: { escalated: true, status: 'escalated' },
    filters: [['id', conversationId], ['user_id', owner]] });
});

it('uses one stable provider key and payload for repeated equivalent requests', async () => {
  const h = harness();
  expect((await h.handle(request({ conversationId: conversationId.toUpperCase() }))).status).toBe(200);
  expect((await h.handle(request())).status).toBe(200);
  const first = h.fetch.mock.calls[0][1]; const second = h.fetch.mock.calls[1][1];
  expect(new Headers(first?.headers).get('Idempotency-Key')).toBe(`chat-support/v1/${conversationId}`);
  expect(new Headers(second?.headers).get('Idempotency-Key')).toBe(new Headers(first?.headers).get('Idempotency-Key'));
  expect(second?.body).toBe(first?.body);
});

it('throttles by the authenticated account before reading history or sending mail', async () => {
  const h = harness(); h.state.allowed = false;
  expect((await h.handle(request({ conversationId, sessionId: 'arbitrary' }))).status).toBe(429);
  expect(h.rateLimit).toHaveBeenCalledExactlyOnceWith(`escalate-chat:${owner}`, 5, 3_600_000);
  expect(h.queries).toHaveLength(1);
  expect(h.fetch).not.toHaveBeenCalled();
});

it.each(['conversation', 'history'] as const)('does not send or mark after a %s query error', async stage => {
  const h = harness(); h.state[stage] = { data: null, error: { message: 'private database detail' } };
  const response = await h.handle(request());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private database detail');
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.queries.some(query => query.action === 'update')).toBe(false);
});

it.each([
  [], [{ role: 'assistant', content: 'No question' }], [{ role: 'system', content: 'Internal text' }],
  [{ role: 'user', content: 'x'.repeat(2001) }],
  Array.from({ length: 11 }, () => ({ role: 'user', content: 'excess row' })),
])('refuses an empty, invalid or unbounded history (%#)', async data => {
  const h = harness(); h.state.history = { data, error: null };
  expect((await h.handle(request())).status).toBe(409);
  expect(h.fetch).not.toHaveBeenCalled();
});

it.each([401, 409, 429, 500])('does not mark or retry after provider HTTP %s', async status => {
  const h = harness(); h.fetch.mockImplementation(async () => new Response('secret provider detail', { status }));
  const response = await h.handle(request());
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('secret provider detail');
  expect(h.fetch).toHaveBeenCalledOnce();
  expect(h.queries.some(query => query.action === 'update')).toBe(false);
});

it.each(['not-json', '{}', '{"id":""}', 'x'.repeat(16385)])('requires a bounded provider acceptance receipt (%#)', async body => {
  const h = harness(); h.fetch.mockImplementation(async () => new Response(body));
  expect((await h.handle(request())).status).toBe(502);
  expect(h.fetch).toHaveBeenCalledOnce();
  expect(h.queries.some(query => query.action === 'update')).toBe(false);
});

it.each([{ data: null, error: null }, { data: null, error: { message: 'write failed' } }])(
  'does not claim success or resend when recording an accepted email fails: %j', async result => {
    const h = harness(); h.state.update = result;
    const response = await h.handle(request());
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty('success', true);
    expect(h.fetch).toHaveBeenCalledOnce();
  },
);

it('does no downstream work for an already cancelled request', async () => {
  const h = harness(); const controller = new AbortController(); controller.abort();
  expect((await h.handle(request({ conversationId }, 'Bearer token', controller.signal))).status).toBe(499);
  expect(h.getUser).not.toHaveBeenCalled();
  expect(h.fetch).not.toHaveBeenCalled();
});

it('does not send after cancellation during the history lookup', async () => {
  const h = harness(); const controller = new AbortController();
  h.state.onQuery = query => { if (query.table === 'chat_messages') controller.abort(); };
  expect((await h.handle(request({ conversationId }, 'Bearer token', controller.signal))).status).toBe(499);
  expect(h.fetch).not.toHaveBeenCalled();
});

it.each(['caller', 'timeout'] as const)('aborts an in-flight provider request on %s, without marking or retrying', async mode => {
  if (mode === 'timeout') vi.useFakeTimers();
  const h = harness(); const controller = new AbortController();
  let started!: () => void; const providerStarted = new Promise<void>(resolve => { started = resolve; });
  h.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    started();
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  }));
  const pending = h.handle(request({ conversationId }, 'Bearer token', controller.signal));
  await providerStarted;
  if (mode === 'caller') controller.abort(); else await vi.advanceTimersByTimeAsync(15_001);
  expect((await pending).status).toBe(mode === 'caller' ? 499 : 504);
  expect(h.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(h.fetch).toHaveBeenCalledOnce();
  expect(h.queries.some(query => query.action === 'update')).toBe(false);
  if (mode === 'timeout') expect(vi.getTimerCount()).toBe(0);
});
