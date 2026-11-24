import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the real Edge entry point and its local helpers. Only auth/database,
// Deno environment and the two provider transports are replaced. No live data.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const owner = '11111111-1111-4111-8111-111111111111';
const stranger = '22222222-2222-4222-8222-222222222222';
const tavilyUrl = 'https://api.tavily.com/search';
const anthropicUrl = 'https://api.anthropic.com/v1/messages';
const sourceUrl = 'https://publisher.example.invalid/about';
const email = 'partner@publisher.example.invalid';
const privateDetail = 'PRIVATE-PROVIDER-OR-DATABASE-DETAIL';
type Row = Record<string, unknown>;
type DbError = { message: string; code?: string };
type DbResult = { data: unknown; error: DbError | null };
type Stage = 'search' | 'model';
type Provider = (stage: Stage, body: Row, init: RequestInit) => Promise<Response>;
type Handler = (req: Request) => Promise<Response>;
const searchResult = () => ({ title: 'Fictitious Publisher', url: sourceUrl,
  content: `Fictitious Publisher. Professional partnerships: ${email}.` });
const candidate = (patch: Row = {}) => ({ name: 'Fictitious Publisher', email,
  website: 'https://publisher.example.invalid', type: 'website', niche: null,
  followers_count: null, ai_score: 70, ai_reasoning: 'Public professional contact.',
  source_index: 1, ...patch });
const config = (patch: Row = {}) => ({ user_id: owner, require_approval_new_prospect: false,
  target_countries: ['CA'], target_languages: ['fr', 'en'], ...patch });
const modelResponse = (value: unknown) => Response.json({
  content: [{ type: 'text', text: JSON.stringify(value) }], stop_reason: 'end_turn',
});

function runtime(options: {
  env?: Record<string, string | undefined>;
  auth?: 'missing' | 'error' | 'throw';
  configAtRead?: (read: number) => DbResult;
  prospects?: Row[];
  provider?: Provider;
  search?: unknown;
  extracted?: unknown;
  lookupError?: DbError;
  insertErrorAt?: number;
  onInsert?: () => void;
  insertGate?: Promise<void>;
} = {}) {
  const tables = { partner_prospects: [...(options.prospects ?? [])] };
  const writes: Row[] = [];
  const queries: { table: string; operation: string; filters: [string, unknown][] }[] = [];
  const events: string[] = [];
  const unexpected: string[] = [];
  const logs: unknown[][] = [];
  let configReads = 0;
  let insertAttempts = 0;
  let now = 0;
  let handler: Handler | undefined;
  const auth = vi.fn(async () => {
    if (options.auth === 'throw') throw new Error(privateDetail);
    return { data: { user: options.auth ? null : { id: owner } },
      error: options.auth === 'error' ? { message: privateDetail } : null };
  });
  function from(table: string) {
    let operation = 'select';
    let payload: Row = {};
    const filters: [string, unknown][] = [];
    const insensitive = new Set<string>();
    let singleton = false;
    let maximum = Infinity;
    let executed: Promise<DbResult> | undefined;
    const execute = (): Promise<DbResult> => {
      if (executed) return executed;
      queries.push({ table, operation, filters: [...filters] });
      events.push(`db:${table}:${operation}`);
      if (table === 'partner_agent_config' && operation === 'select') {
        configReads++;
        return executed = Promise.resolve(options.configAtRead?.(configReads)
          ?? { data: config(), error: null });
      }
      if (table !== 'partner_prospects') throw new Error(`Unexpected table: ${table}`);
      if (operation === 'insert') {
        insertAttempts++;
        options.onInsert?.();
        const persist = (): DbResult => {
          if (options.insertErrorAt === insertAttempts) return {
            data: null, error: { message: privateDetail, code: 'XX000' },
          };
          const duplicate = payload.email != null && tables.partner_prospects.some(row =>
            row.user_id === payload.user_id && row.email === payload.email);
          if (duplicate) return { data: null,
            error: { message: 'unique fixture constraint', code: '23505' } };
          const saved = { id: `fixture-${insertAttempts}`, ...payload };
          writes.push(saved);
          tables.partner_prospects.push(saved);
          return { data: singleton ? saved : [saved], error: null };
        };
        return executed = options.insertGate ? options.insertGate.then(persist) : Promise.resolve(persist());
      }
      if (options.lookupError) return executed = Promise.resolve({ data: null, error: options.lookupError });
      const rows = tables.partner_prospects.filter(row => filters.every(([key, value]) => {
        if (!insensitive.has(key)) return row[key] === value;
        const expected = String(value).replace(/\\([\\%_])/g, '$1').toLowerCase();
        return String(row[key]).toLowerCase() === expected;
      })).slice(0, maximum);
      return executed = Promise.resolve({ data: singleton ? rows[0] ?? null : rows, error: null });
    };
    const query = {
      select: (_columns?: string) => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      ilike: (key: string, value: string) => { filters.push([key, value]); insensitive.add(key); return query; },
      limit: (value: number) => { maximum = value; return query; },
      maybeSingle: () => { singleton = true; return query; },
      single: () => { singleton = true; return query; },
      insert: (value: Row) => { operation = 'insert'; payload = value; return query; },
      then: <T = DbResult, R = never>(ok?: ((value: DbResult) => T | PromiseLike<T>) | null,
        bad?: ((reason: unknown) => R | PromiseLike<R>) | null) => execute().then(ok, bad),
    };
    return query;
  }
  const client = { from, auth: { getUser: auth }, rpc: vi.fn(async () => {
    unexpected.push('rpc'); return { data: null, error: null };
  }) };
  const transport = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url !== tavilyUrl && url !== anthropicUrl) {
      unexpected.push(url); throw new Error(`Unapproved transport: ${url}`);
    }
    const stage = url === tavilyUrl ? 'search' : 'model';
    events.push(`provider:${stage}`);
    const body = JSON.parse(String(init.body)) as Row;
    if (options.provider) return options.provider(stage, body, init);
    return stage === 'search'
      ? Response.json(options.search ?? { results: [searchResult()] })
      : modelResponse(options.extracted ?? { prospects: [candidate()] });
  });
  const cache = new Map<string, Record<string, unknown>>();
  function load(input: string): Record<string, unknown> {
    const path = resolve(repo, input).replace(/\.js$/, '.ts');
    const previous = cache.get(path);
    if (previous) return previous;
    const source = readFileSync(path, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(path, module.exports);
    const requireModule = (specifier: string): unknown => {
      if (specifier.includes('@supabase/supabase-js')) return { createClient: () => client };
      if (specifier.startsWith('.')) return load(resolve(dirname(path), specifier));
      throw new Error(`Unmocked import: ${specifier}`);
    };
    runInNewContext(compiled, {
      module, exports: module.exports, require: requireModule,
      Deno: { serve: (fn: Handler) => { handler = fn; }, env: { get: (name: string) => {
        if (options.env && Object.hasOwn(options.env, name)) return options.env[name];
        return name.endsWith('_URL') ? 'https://example.invalid' : 'fixture-only-not-a-secret';
      } } },
      fetch: transport, Request, Response, Headers, URL, AbortController, AbortSignal,
      ReadableStream, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
      setTimeout, clearTimeout, performance: { now: () => now },
      console: { error: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) },
    }, { filename: path });
    return module.exports;
  }
  load('supabase/functions/partner-find-prospects/index.ts');
  return { writes, queries, events, unexpected, logs, transport, auth, client,
    configReads: () => configReads,
    advance: (milliseconds: number) => { now += milliseconds; },
    handler: (req: Request) => { if (!handler) throw new Error('No Edge handler'); return handler(req); },
  };
}

function request(body: unknown = { query: 'Publishers Canada' }, options: {
  authorization?: string; signal?: AbortSignal; raw?: string;
} = {}) {
  return new Request('https://example.invalid/partner-find-prospects', {
    method: 'POST', headers: { authorization: options.authorization ?? 'Bearer fixture-user-token',
      'content-type': 'application/json' }, body: options.raw ?? JSON.stringify(body), signal: options.signal,
  });
}
function assertNoProviderOrWrite(h: ReturnType<typeof runtime>) {
  expect(h.transport).not.toHaveBeenCalled();
  expect(h.writes).toEqual([]);
}
function assertNoPrivateDetail(h: ReturnType<typeof runtime>, value: unknown) {
  expect(JSON.stringify({ value, logs: h.logs })).not.toContain(privateDetail);
}

describe('partner discovery request boundary', () => {
  it.each([
    ['null body', null], ['array body', []], ['missing query', {}], ['numeric query', { query: 12 }],
    ['object query', { query: {} }], ['blank query', { query: '  ' }],
    ['excessive query', { query: 'x'.repeat(2001) }], ['invalid niche', { query: 'valid', niche: 12 }],
    ['unknown type', { query: 'valid', type: 'administrator' }],
  ])('refuses %s before paid providers', async (_label, body) => {
    const h = runtime();
    expect((await h.handler(request(body))).status).toBe(400);
    assertNoProviderOrWrite(h);
  });
  it('reports malformed JSON as a client error', async () => {
    const h = runtime();
    expect((await h.handler(request(null, { raw: '{' }))).status).toBe(400);
    assertNoProviderOrWrite(h);
  });
  it('bounds the raw request including irrelevant fields', async () => {
    const h = runtime();
    expect((await h.handler(request({ query: 'valid', padding: 'x'.repeat(300_000) }))).status).toBe(413);
    assertNoProviderOrWrite(h);
  });
  it.each(['Basic fixture-user-token', 'Bearer', 'Bearer one two'])('rejects malformed authorization %s', async authorization => {
    const h = runtime();
    expect((await h.handler(request(undefined, { authorization }))).status).toBe(401);
    expect(h.auth).not.toHaveBeenCalled();
    assertNoProviderOrWrite(h);
  });
  it.each(['missing', 'error', 'throw'] as const)('fails closed on authentication %s', async auth => {
    const h = runtime({ auth });
    const response = await h.handler(request());
    expect(response.status).toBe(401);
    assertNoProviderOrWrite(h);
    assertNoPrivateDetail(h, await response.json());
  });
  it.each(['TAVILY_API_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY'])('requires configured %s before providers', async name => {
    const h = runtime({ env: { [name]: '' } });
    expect((await h.handler(request())).status).toBe(503);
    assertNoProviderOrWrite(h);
  });
  it('keeps OPTIONS and unsupported methods free from effects', async () => {
    const h = runtime();
    expect((await h.handler(new Request('https://example.invalid', { method: 'OPTIONS' }))).status).toBe(200);
    expect((await h.handler(new Request('https://example.invalid'))).status).toBe(405);
    expect(h.auth).not.toHaveBeenCalled();
    assertNoProviderOrWrite(h);
  });
  it.each([
    ['project default', undefined, 'claude-sonnet-4-6'],
    ['explicit server choice', 'configured-model-fixture', 'configured-model-fixture'],
  ])('uses the %s without changing the output budget', async (_label, configured, expected) => {
    const h = runtime({ env: { ANTHROPIC_MODEL_MAIN: configured } });
    expect((await h.handler(request())).status).toBe(200);
    const call = h.transport.mock.calls.find(value => String(value[0]) === anthropicUrl)!;
    expect(JSON.parse(String(call[1]!.body))).toMatchObject({ model: expected, max_tokens: 2500 });
  });
  it('refuses an explicitly blank model before either paid provider', async () => {
    const h = runtime({ env: { ANTHROPIC_MODEL_MAIN: '  ' } });
    expect((await h.handler(request())).status).toBe(503);
    assertNoProviderOrWrite(h);
  });
});

describe('partner discovery account configuration', () => {
  it.each([
    { data: null, error: null },
    { data: null, error: { message: privateDetail } },
  ])('does not pay for discovery without readable saved configuration %j', async result => {
    const h = runtime({ configAtRead: () => result });
    const response = await h.handler(request());
    expect(response.status).toBe(503);
    assertNoProviderOrWrite(h);
    assertNoPrivateDetail(h, await response.json());
  });
  it.each([true, null, undefined])('keeps a proven contact identified when approval is %s', async approval => {
    const h = runtime({ configAtRead: () => ({ data: config({ require_approval_new_prospect: approval }), error: null }) });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.status).toBe('identified');
  });
  it('preserves explicit automatic mode for a proven email without touching money', async () => {
    const h = runtime({ configAtRead: () => ({ data: config({ commission_first_payment: 30, commission_recurring: 17 }), error: null }) });
    expect((await h.handler(request({ query: 'Publishers Canada', user_id: stranger }))).status).toBe(200);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ user_id: owner, email, status: 'ready_to_contact', source: 'ai_search', found_by_ai: true });
    expect(h.queries.every(value => value.operation === 'select' || value.table === 'partner_prospects')).toBe(true);
    expect(JSON.stringify(h.writes)).not.toContain('commission');
    expect(h.configReads()).toBeGreaterThanOrEqual(2);
    expect(h.events.indexOf('db:partner_agent_config:select')).toBeLessThan(h.events.indexOf('provider:search'));
    expect(h.queries.filter(value => value.table === 'partner_agent_config').every(value =>
      value.filters.some(([key, expected]) => key === 'user_id' && expected === owner))).toBe(true);
  });
  it('rereads approval after provider work and before any persistence', async () => {
    const h = runtime({ configAtRead: read => ({ data: config({ require_approval_new_prospect: read > 1 }), error: null }) });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.configReads()).toBeGreaterThanOrEqual(2);
    expect(h.writes[0]!.status).toBe('identified');
    const lastConfig = h.events.lastIndexOf('db:partner_agent_config:select');
    expect(lastConfig).toBeGreaterThan(h.events.indexOf('provider:model'));
    expect(lastConfig).toBeLessThan(h.events.indexOf('db:partner_prospects:insert'));
  });
  it('refuses persistence if configuration becomes unreadable after generation', async () => {
    const h = runtime({ configAtRead: read => read === 1 ? { data: config(), error: null }
      : { data: null, error: { message: privateDetail } } });
    const response = await h.handler(request());
    expect(response.status).toBe(503);
    expect(h.writes).toEqual([]);
    assertNoPrivateDetail(h, await response.json());
  });
  it('does not impose France over the explicit search and persists dated source evidence', async () => {
    const h = runtime();
    expect((await h.handler(request())).status).toBe(200);
    const body = JSON.parse(String(h.transport.mock.calls[0]![1]!.body)) as Row;
    expect(body.query).toContain('Canada');
    expect(body.query).not.toMatch(/France/i);
    expect(h.writes[0]!.notes).toEqual(expect.stringContaining(sourceUrl));
    expect(h.writes[0]!.notes).toMatch(/20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
    expect(h.writes[0]!.notes).not.toMatch(/(?:consentement|opt.in)\s*[:=]\s*(?:true|oui)/i);
    expect(h.unexpected).toEqual([]);
  });
});

describe('partner discovery source and provider validation', () => {
  it.each([
    { results: {} }, { results: [null] },
    { results: [{ title: 'fixture', url: 'javascript:alert(1)', content: email }] },
    { results: [{ title: 'fixture', url: 'https://secret@example.invalid/contact', content: email }] },
  ])('rejects invalid search data %j before generation or persistence', async search => {
    const h = runtime({ search });
    expect((await h.handler(request())).status).toBe(502);
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.writes).toEqual([]);
  });
  it('returns a genuine empty search without calling the model', async () => {
    const h = runtime({ search: { results: [] } });
    const response = await h.handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ inserted: 0, prospects: [] });
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.writes).toEqual([]);
  });
  it('preserves a valid empty extraction without creating a contact', async () => {
    const h = runtime({ extracted: { prospects: [] } });
    const response = await h.handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ inserted: 0, prospects: [] });
    expect(h.transport).toHaveBeenCalledTimes(2);
    expect(h.writes).toEqual([]);
  });
  it('rejects malformed model JSON without returning or logging its private text', async () => {
    const h = runtime({ provider: async stage => stage === 'search'
      ? Response.json({ results: [searchResult()] })
      : Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: `${privateDetail} {` }] }) });
    const response = await h.handler(request());
    expect(response.status).toBe(502);
    expect(h.writes).toEqual([]);
    assertNoPrivateDetail(h, await response.json());
  });
  it.each([undefined, 'max_tokens', 'pause_turn', 'refusal', 'tool_use'])('does not persist syntactically valid JSON from a model stop reason %s', async stopReason => {
    const h = runtime({ provider: async stage => stage === 'search'
      ? Response.json({ results: [searchResult()] })
      : Response.json({ stop_reason: stopReason, content: [{ type: 'text', text: JSON.stringify({ prospects: [candidate()] }) }] }) });
    expect((await h.handler(request())).status).toBe(502);
    expect(h.writes).toEqual([]);
  });
  it('accepts a completed textual stop_sequence without weakening source checks', async () => {
    const h = runtime({ provider: async stage => stage === 'search'
      ? Response.json({ results: [searchResult()] })
      : Response.json({ stop_reason: 'stop_sequence', content: [{ type: 'text', text: JSON.stringify({ prospects: [candidate()] }) }] }) });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.writes[0]).toMatchObject({ email, status: 'ready_to_contact' });
  });
  it.each([
    ['non-array prospects', { prospects: {} }], ['null candidate', { prospects: [null] }],
    ['non-text name', { prospects: [candidate({ name: 12 })] }],
    ['zero source index', { prospects: [candidate({ source_index: 0 })] }],
    ['unknown source index', { prospects: [candidate({ source_index: 2 })] }],
    ['string source index', { prospects: [candidate({ source_index: '1' })] }],
    ['missing source index', { prospects: [candidate({ source_index: undefined })] }],
    ['non-text email', { prospects: [candidate({ email: { address: email } })] }],
    ['unbounded result count', { prospects: Array.from({ length: 100 }, () => candidate()) }],
  ])('refuses extraction with %s without saving a prefix', async (_label, extracted) => {
    const h = runtime({ extracted });
    expect((await h.handler(request())).status).toBe(502);
    expect(h.writes).toEqual([]);
  });
  it.each(['fabricated@example.invalid', `prefix${email}`, `${email}.attacker.invalid`])('does not promote an unsupported email %s', async unsupported => {
    const h = runtime({ extracted: { prospects: [candidate({ email: unsupported })] } });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ email: null, status: 'identified' });
  });
  it.each([`prefix${email}`, `${email}.attacker.invalid`])('does not accept an email embedded in the larger source address %s', async published => {
    const h = runtime({ search: { results: [{ ...searchResult(), content: `Contact ${published}` }] } });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.writes[0]).toMatchObject({ email: null, status: 'identified' });
  });
  it.each([`é${email}`, `${email}é`, `${email}_suffix`])('does not extract a mailbox prefix from a larger Unicode or identifier token %s', async published => {
    const h = runtime({ search: { results: [{ ...searchResult(), content: `Contact ${published}` }] } });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.writes[0]).toMatchObject({ email: null, status: 'identified' });
  });
  it('uses the source excerpt actually supplied to the model for email evidence', async () => {
    const h = runtime({ search: { results: [{ ...searchResult(), content: `${'Public professional introduction. '.repeat(700)} ${email}` }] } });
    expect((await h.handler(request())).status).toBe(200);
    const modelCall = h.transport.mock.calls.find(call => String(call[0]) === anthropicUrl)!;
    const body = JSON.parse(String(modelCall[1]!.body));
    expect(JSON.stringify(body.messages)).not.toContain(email);
    expect(h.writes[0]).toMatchObject({ email: null, status: 'identified' });
  });
  it.each([['content', 4_000], ['title', 500]] as const)('does not create email evidence by cutting a larger token at the %s limit', async (field, limit) => {
    const source = { ...searchResult(), content: 'Fictitious Publisher public information.',
      [field]: ' '.repeat(limit - email.length) + email + '.attacker.invalid' };
    const h = runtime({ search: { results: [source] } });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.writes[0]).toMatchObject({ email: null, status: 'identified' });
  });
  it('does not treat a number in an address or date as a follower measurement', async () => {
    const h = runtime({ search: { results: [{ ...searchResult(), content: `${email}. Adresse: 1200 rue Fictive, publication 2026.` }] },
      extracted: { prospects: [candidate({ followers_count: 1 })] } });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.writes[0]!.followers_count).toBeNull();
  });
  it('preserves an explicitly published audience count with its unit', async () => {
    const h = runtime({ search: { results: [{ ...searchResult(), content: `${email}. Audience: 1200 abonnés.` }] },
      extracted: { prospects: [candidate({ followers_count: 1200 })] } });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.writes[0]!.followers_count).toBe(1200);
  });
  it.each([['1.234 followers', 234], ['-12 followers', 12]] as const)(
    'does not recognize a numeric suffix as an audience in %s', async (measurement, proposed) => {
      const h = runtime({ search: { results: [{ ...searchResult(), content: email + '. Audience: ' + measurement + '.' }] },
        extracted: { prospects: [candidate({ followers_count: proposed })] } });
      expect((await h.handler(request())).status).toBe(200);
      expect(h.writes[0]!.followers_count).toBeNull();
    });
  it('does not retain unrelated model-invented website or social URLs', async () => {
    const h = runtime({ extracted: { prospects: [candidate({ website: 'https://invented.example.invalid',
      social_links: { linkedin: 'https://linkedin.com/in/invented-fixture', unsafe: 'javascript:alert(1)' },
    })] } });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.website).not.toBe('https://invented.example.invalid');
    expect(h.writes[0]!.social_links).toEqual({});
  });
  it('binds email evidence to the cited result, not another publisher in the batch', async () => {
    const h = runtime({ search: { results: [
      { ...searchResult(), content: 'No contact email is published here.' },
      { title: 'Different publisher', url: 'https://other.example.invalid', content: email },
    ] }, extracted: { prospects: [candidate({ source_index: 1 })] } });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.writes[0]).toMatchObject({ email: null, status: 'identified' });
  });
  it('normalizes a proven address and ignores model-controlled identity/status', async () => {
    const h = runtime({ extracted: { prospects: [candidate({
      email: ` ${email.toUpperCase()} `, user_id: stranger, status: 'active', source: 'manual', found_by_ai: false,
    })] } });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.writes[0]).toMatchObject({ user_id: owner, email, status: 'ready_to_contact', source: 'ai_search', found_by_ai: true });
  });
  it.each(['search', 'model'] as const)('does not disclose a failed %s provider response', async failedStage => {
    const h = runtime({ provider: async stage => stage === failedStage
      ? new Response(privateDetail, { status: 503 })
      : Response.json({ results: [searchResult()] }) });
    const response = await h.handler(request());
    expect(response.status).toBe(502);
    expect(h.writes).toEqual([]);
    assertNoPrivateDetail(h, await response.json());
  });
  it.each(['search', 'model'] as const)('bounds an excessive %s response body', async largeStage => {
    const h = runtime({ provider: async stage => stage === largeStage
      ? new Response('x'.repeat(2_000_000), { headers: { 'content-type': 'application/json' } })
      : Response.json({ results: [searchResult()] }) });
    expect((await h.handler(request())).status).toBe(502);
    expect(h.writes).toEqual([]);
  });
});

describe('partner discovery persistence and interruption', () => {
  it('does not mistake a failed duplicate lookup for an absent contact', async () => {
    const h = runtime({ lookupError: { message: privateDetail } });
    const response = await h.handler(request());
    expect(response.status).toBe(503);
    expect(h.writes).toEqual([]);
    assertNoPrivateDetail(h, await response.json());
  });
  it('reports insertion failure with an explicit partial count', async () => {
    const h = runtime({ insertErrorAt: 1 });
    const response = await h.handler(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ inserted: 0, prospects: [] });
    expect(body).toHaveProperty('error', expect.any(String));
    assertNoPrivateDetail(h, body);
  });
  it('preserves the count of earlier successful writes when a later insertion fails', async () => {
    const nextEmail = 'second@publisher.example.invalid';
    const h = runtime({ insertErrorAt: 2,
      search: { results: [{ ...searchResult(), content: `${email} and ${nextEmail}` }] },
      extracted: { prospects: [candidate(), candidate({ name: 'Second fixture', email: nextEmail })] },
    });
    const response = await h.handler(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toHaveProperty('inserted', 1);
    if (typeof body !== 'object' || body === null || !('prospects' in body)) {
      throw new Error('Expected a discovery response containing prospects');
    }
    expect(body.prospects).toHaveLength(1);
    expect(h.writes).toHaveLength(1);
    assertNoPrivateDetail(h, body);
  });
  it('does not insert an already known exact identity or issue a meaningless RPC', async () => {
    const h = runtime({ prospects: [{ id: 'existing', user_id: owner, email }] });
    const response = await h.handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ inserted: 0 });
    expect(h.writes).toEqual([]);
    expect(h.unexpected).toEqual([]);
  });
  it('deduplicates differently cased repeats within one generated batch', async () => {
    const h = runtime({ extracted: { prospects: [candidate(), candidate({ email: email.toUpperCase() })] } });
    const response = await h.handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ inserted: 1 });
    expect(h.writes).toHaveLength(1);
  });
  it('does not deduplicate a different account into this account', async () => {
    const h = runtime({ prospects: [{ id: 'foreign', user_id: stranger, email }] });
    expect((await h.handler(request())).status).toBe(200);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.user_id).toBe(owner);
  });
  it('rejects a pre-aborted request without a paid operation', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = runtime();
    expect((await h.handler(request(undefined, { signal: controller.signal }))).status).toBe(408);
    assertNoProviderOrWrite(h);
  });
  it('aborts even when the provider ignores AbortSignal and rejects late persistence', async () => {
    let release!: (value: Response) => void;
    let started!: () => void;
    const providerStarted = new Promise<void>(resolveStarted => { started = resolveStarted; });
    const blocked = new Promise<Response>(resolveResponse => { release = resolveResponse; });
    const controller = new AbortController();
    const h = runtime({ provider: async stage => {
      if (stage === 'search') { started(); return blocked; }
      return modelResponse({ prospects: [candidate()] });
    } });
    const pending = h.handler(request(undefined, { signal: controller.signal }));
    await providerStarted;
    controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([pending,
      new Promise<null>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), 100); })]);
    clearTimeout(timer);
    release(Response.json({ results: [searchResult()] }));
    const finished = await pending;
    expect(observed?.status).toBe(408);
    expect(finished.status).toBe(408);
    expect(h.writes).toEqual([]);
  });
  it('enforces the total monotonic deadline before persisting a late result', async () => {
    const h = runtime({ provider: async stage => {
      if (stage === 'search') return Response.json({ results: [searchResult()] });
      advance(10 * 60_000);
      return modelResponse({ prospects: [candidate()] });
    } });
    const advance: (milliseconds: number) => void = h.advance;
    const response = await h.handler(request());
    expect(response.status).toBe(504);
    expect(h.writes).toEqual([]);
  });
  it('reports only confirmed insertions and an unknown outcome when an in-flight write completes after cancellation', async () => {
    let release!: () => void;
    let started!: () => void;
    const insertGate = new Promise<void>(resolveInsert => { release = resolveInsert; });
    const insertStarted = new Promise<void>(resolveStarted => { started = resolveStarted; });
    const controller = new AbortController();
    const h = runtime({ insertGate, onInsert: () => started() });
    const pending = h.handler(request(undefined, { signal: controller.signal }));
    await insertStarted;
    controller.abort();
    const response = await pending;
    const body = await response.json();
    const writesBeforeRelease = h.writes.length;
    release();
    await insertGate;
    await Promise.resolve();
    expect(response.status).toBe(408);
    expect(writesBeforeRelease).toBe(0);
    expect(h.writes).toHaveLength(1);
    expect(body).toMatchObject({ status: 'unknown', inserted: 0, confirmed_inserted: 0, prospects: [] });
  });
});
