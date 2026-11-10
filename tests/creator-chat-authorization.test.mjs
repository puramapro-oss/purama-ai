import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod-edge-validation';

// Execute the actual Edge handler and shared validation module. Only imports
// and environment are replaced; no predicate, schema or query is reimplemented.
// All credentials, accounts, responses and rows below are synthetic fixtures.
function compileSource(relativePath, module = ts.ModuleKind.None) {
  const sourceUrl = new URL(relativePath, import.meta.url);
  const source = readFileSync(sourceUrl, 'utf8');
  const parsed = ts.createSourceFile(sourceUrl.pathname, source, ts.ScriptTarget.ES2022, true);
  const executableSource = parsed.statements.filter(ts.isImportDeclaration).reduceRight(
    (text, statement) => text.slice(0, statement.getStart(parsed)) + text.slice(statement.end), source,
  );
  const emitted = ts.transpileModule(executableSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module }, reportDiagnostics: true,
  });
  assert.deepEqual((emitted.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error)
    .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
  return new vm.Script(emitted.outputText, { filename: sourceUrl.pathname });
}

// Match the version pinned by the Edge import without changing the frontend's
// Zod dependency. The real schemas and validateBody run with that exact version;
// Deno bootstrap and the external services remain outside this Node harness.
const testRequire = createRequire(import.meta.url);
const validationVersion = testRequire('zod-edge-validation/package.json').version;
assert.ok(readFileSync(new URL('../supabase/functions/_shared/validation.ts', import.meta.url), 'utf8')
  .includes(`https://deno.land/x/zod@v${validationVersion}/mod.ts`), 'Update the test alias with the Edge Zod version');
const validationExports = {};
compileSource('../supabase/functions/_shared/validation.ts', ts.ModuleKind.CommonJS)
  .runInContext(vm.createContext({ z, exports: validationExports }), { timeout: 1_000 });
const { ChatMessageSchema, validateBody } = validationExports;
assert.equal(typeof ChatMessageSchema.safeParse, 'function');
assert.equal(typeof validateBody, 'function');
const script = compileSource('../supabase/functions/creator-agent-chat/index.ts');

const USER_A = 'a1000000-0000-4000-8000-000000000001';
const USER_B = 'b1000000-0000-4000-8000-000000000001';
const AGENT_ID = 'c1000000-0000-4000-8000-000000000001';
const SESSION_ID = 'd1000000-0000-4000-8000-000000000001';
const OTHER_ID = 'e1000000-0000-4000-8000-000000000001';
const TOKEN = 'synthetic-user-token';
const MESSAGE = 'Continue ma conversation.';
const REPLY = 'Réponse synthétique du fournisseur.';

function harness({ owner = USER_A, published = false, official = false, identity = USER_A, history = [] } = {}) {
  const agent = {
    id: AGENT_ID, user_id: owner, is_public: published, is_template: official,
    is_active: true, model: 'synthetic-model', system_prompt: 'Consigne synthétique.',
    max_tokens: 400, temperature: 0.5, total_runs: 4, total_tokens: 40,
  };
  const tables = new Map([
    ['creator_agents', [structuredClone(agent)]],
    ['creator_agent_chats', structuredClone(history)],
    ['creator_agent_runs', []],
  ]);
  const state = { authTokens: [], reads: [], writes: [], writeAttempts: [], providerCalls: [], errors: [] };

  class Query {
    constructor(table) {
      assert.ok(tables.has(table), `Unexpected table: ${table}`);
      this.table = table;
      this.operation = 'select';
      this.columns = '*';
      this.filters = [];
    }
    select(columns = '*') { this.columns = columns; return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    order(column, options) { this.ordering = { column, ...options }; return this; }
    limit(count) { this.count = count; return this; }
    insert(value) { return this.write('insert', value); }
    update(value) { return this.write('update', value); }
    write(operation, value) {
      this.operation = operation;
      this.value = structuredClone(value);
      state.writeAttempts.push({ table: this.table, operation });
      return this;
    }
    async single() {
      const result = await this;
      return result.data.length === 1
        ? { data: result.data[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'Expected one fixture row' } };
    }
    then(resolve, reject) {
      this.pending ??= Promise.resolve().then(() => this.execute());
      return this.pending.then(resolve, reject);
    }
    execute() {
      const all = tables.get(this.table);
      let rows = all.filter(row => this.filters.every(([key, value]) => row[key] === value));
      const trace = {
        table: this.table, operation: this.operation,
        filters: structuredClone(this.filters), columns: this.columns, limit: this.count,
      };
      if (this.operation === 'select') {
        state.reads.push(trace);
        if (this.ordering) {
          const { column, ascending = true } = this.ordering;
          rows = [...rows].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1));
        }
        if (this.count !== undefined) rows = rows.slice(0, this.count);
      } else {
        state.writes.push({ ...trace, value: structuredClone(this.value) });
        if (this.operation === 'insert') {
          rows = [structuredClone(this.value)];
          all.push(...rows);
        } else {
          for (const row of rows) Object.assign(row, this.value);
        }
      }
      const data = rows.map(row => this.columns === '*'
        ? structuredClone(row)
        : Object.fromEntries(this.columns.split(',').map(key => [key.trim(), row[key.trim()]])));
      return { data, error: null };
    }
  }

  const environment = {
    SUPABASE_URL: 'https://database.invalid', SUPABASE_ANON_KEY: 'synthetic-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role', ANTHROPIC_API_KEY: 'synthetic-provider-key',
    CORS_ALLOWED_ORIGIN: 'https://frontend.invalid',
  };
  let handler;
  const context = vm.createContext({
    Request, Response, Headers,
    Deno: { env: { get: key => environment[key] }, serve: callback => { handler = callback; } },
    console: { error: (...args) => state.errors.push(args.map(String)) },
    ChatMessageSchema, validateBody,
    // Only rate limiting is fixed to allow these authorization/validation cases.
    rateLimit: () => ({ allowed: true }),
    json: (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 'Content-Type': 'application/json' },
    }),
    createClient: (url, key, options) => {
      assert.equal(url, environment.SUPABASE_URL);
      assert.equal(options.db.schema, 'purama_ai');
      if (key === environment.SUPABASE_ANON_KEY) return {
        auth: { getUser: async token => {
          state.authTokens.push(token);
          assert.equal(token, TOKEN);
          return identity ? { data: { user: { id: identity } }, error: null }
            : { data: { user: null }, error: { message: 'Invalid synthetic session' } };
        } },
      };
      assert.equal(key, environment.SUPABASE_SERVICE_ROLE_KEY);
      return { from: table => new Query(table) };
    },
    fetch: async (url, options) => {
      // Never delegate to global fetch: this test cannot contact a provider.
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.method, 'POST');
      state.providerCalls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        content: [{ text: REPLY }], usage: { input_tokens: 12, output_tokens: 7 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  script.runInContext(context, { timeout: 1_000 });
  assert.equal(typeof handler, 'function');

  return {
    state,
    invoke: ({ authenticated = true, body = {} } = {}) => handler(new Request('https://edge.invalid/creator-agent-chat', {
      method: 'POST', headers: {
        'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify({ agent_id: AGENT_ID, session_id: SESSION_ID, message: MESSAGE, user_id: USER_B, ...body }),
    })),
  };
}

function assertNoEffects(state) {
  assert.equal(state.reads.filter(read => read.table === 'creator_agent_chats').length, 0, 'No history may be read');
  assert.deepEqual(state.writeAttempts, [], 'No write may be attempted');
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.providerCalls, [], 'No provider may be called');
}

for (const scenario of [
  { name: 'another user’s public agent', owner: USER_B, published: true },
  { name: 'another user’s private agent', owner: USER_B, published: false },
  { name: 'an ownerless public official template', owner: null, published: true, official: true },
  { name: 'an ownerless private official template', owner: null, published: false, official: true },
]) {
  test(`chat refuses ${scenario.name} before history, writes or provider access`, async () => {
    const { state, invoke } = harness(scenario);
    const response = await invoke();
    assert.ok([403, 404].includes(response.status), `Expected refusal, got ${response.status}`);
    assert.deepEqual(state.authTokens, [TOKEN]);
    assertNoEffects(state);
  });
}

for (const authenticated of [false, true]) {
  test(`chat refuses ${authenticated ? 'an invalid' : 'a missing'} session before reading an agent`, async () => {
    const { state, invoke } = harness({ identity: null });
    const response = await invoke({ authenticated });
    assert.equal(response.status, 401);
    assert.deepEqual(state.reads, []);
    assertNoEffects(state);
  });
}

for (const scenario of [
  { name: 'a missing agent ID', body: { agent_id: undefined }, field: 'agent_id' },
  { name: 'an invalid agent UUID', body: { agent_id: 'not-a-uuid' }, field: 'agent_id' },
  { name: 'a message exceeding 4000 characters', body: { message: 'x'.repeat(4001) }, field: 'message' },
]) {
  test(`the real validation rejects ${scenario.name} before database reads or effects`, async () => {
    const { state, invoke } = harness();
    const response = await invoke({ body: scenario.body });
    assert.equal(response.status, 400, JSON.stringify(state.errors));
    const body = await response.json();
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.includes(`${scenario.field}:`), 'The real validation helper must identify the invalid field');
    assert.deepEqual(state.authTokens, [TOKEN]);
    assert.deepEqual(state.reads, []);
    assertNoEffects(state);
    assert.deepEqual(state.errors, []);
  });
}

for (const published of [false, true]) {
  test(`the owner can chat with a ${published ? 'public' : 'private'} agent using only their own session history`, async () => {
    const row = (user, agent, session, content, minute, role = 'user') => ({
      user_id: user, agent_id: agent, session_id: session, role, content,
      created_at: `2026-11-10T10:${minute}:00.000Z`,
    });
    const history = [
      row(USER_B, AGENT_ID, SESSION_ID, 'FOREIGN_ACCOUNT_CONFIDENTIAL', '00'),
      row(USER_A, AGENT_ID, SESSION_ID, 'Mon message précédent.', '01'),
      row(USER_A, AGENT_ID, OTHER_ID, 'OTHER_SESSION_CONFIDENTIAL', '02'),
      row(USER_A, OTHER_ID, SESSION_ID, 'OTHER_AGENT_CONFIDENTIAL', '03'),
      row(USER_A, AGENT_ID, SESSION_ID, 'Ma réponse précédente.', '04', 'assistant'),
    ];
    const { state, invoke } = harness({ published, history });
    const response = await invoke();
    assert.equal(response.status, 200, JSON.stringify(state.errors));
    assert.deepEqual(await response.json(), { reply: REPLY, tokens: 7 });
    assert.deepEqual(state.authTokens, [TOKEN]);
    const reads = state.reads.filter(read => read.table === 'creator_agent_chats');
    assert.equal(reads.length, 1);
    for (const filter of [['user_id', USER_A], ['agent_id', AGENT_ID], ['session_id', SESSION_ID]]) {
      assert.ok(reads[0].filters.some(([key, value]) => key === filter[0] && value === filter[1]), `Missing history filter ${filter[0]}`);
    }
    assert.equal(state.providerCalls.length, 1);
    assert.deepEqual(state.providerCalls[0].messages, [
      { role: 'user', content: 'Mon message précédent.' },
      { role: 'assistant', content: 'Ma réponse précédente.' },
      { role: 'user', content: MESSAGE },
    ]);
    assert.doesNotMatch(JSON.stringify(state.providerCalls), /CONFIDENTIAL/);
    assert.equal(state.providerCalls[0].system, 'Consigne synthétique.');
    const inserts = state.writes.filter(write => write.operation === 'insert');
    assert.deepEqual(inserts.map(write => write.table), ['creator_agent_chats', 'creator_agent_chats', 'creator_agent_runs']);
    for (const write of inserts) {
      assert.equal(write.value.user_id, USER_A, 'The JWT identity must own every inserted row');
      assert.equal(write.value.agent_id, AGENT_ID);
    }
    assert.equal(inserts[0].value.content, MESSAGE);
    assert.equal(inserts[1].value.content, REPLY);
    assert.equal(inserts[2].value.output, REPLY);
    assert.deepEqual(state.errors, []);
  });
}
