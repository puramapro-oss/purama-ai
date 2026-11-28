import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// Actual Edge, API, queue producer and delivery identity sources execute here.
// Inert ports: Supabase Auth/rows, HTTP socket, Redis storage, unrelated routes.
// No SQL uniqueness claim, worker, model or external business effect is executed.
const sources = new Map();
function execute(relativePath, imports = {}, globals = {}) {
  let script = sources.get(relativePath);
  if (!script) {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '../..', relativePath);
    const emitted = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
    });
    assert.deepEqual((emitted.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
    script = new vm.Script(emitted.outputText, { filename: path });
    sources.set(relativePath, script);
  }
  const exports = {};
  script.runInContext(vm.createContext({
    exports, URL, Headers, Request, Response, TextEncoder, TextDecoder,
    // Node's fetch streams emit Node-realm bytes even when Vitest uses jsdom.
    Uint8Array: Object.getPrototypeOf(Buffer.prototype).constructor,
    AbortController, Buffer, setTimeout, clearTimeout, performance, ...globals,
    require: name => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name} from ${relativePath}`);
      return imports[name];
    },
  }), { timeout: 1_000 });
  return exports;
}

export const OWNER = '81000000-0000-4000-8000-000000000001';
export const OTHER_OWNER = '81000000-0000-4000-8000-000000000002';
export const AGENT = '82000000-0000-4000-8000-000000000001';
export const OTHER_AGENT = '82000000-0000-4000-8000-000000000002';
export const INTENT = '83000000-0000-4000-8000-000000000001';
export const TOKEN = 'synthetic-owner-token';
export const ADMIN = 'synthetic-admin-token';
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function customTriggerHarness(options = {}) {
  const state = {
    auth: [], queries: [], internal: [], logs: [], queueAdds: [], jobs: new Map(),
    clients: [], timers: new Map(), clock: 0,
  };
  let handler;
  let api;
  let nextTimer = 0;
  const fixedClock = options.fakeClock === true;
  const globals = {
    console: { error: (...args) => state.logs.push(args), log: () => {} },
    performance: fixedClock ? { now: () => state.clock } : performance,
    setTimeout: fixedClock ? ((callback, ms) => {
      const id = ++nextTimer; state.timers.set(id, { at: state.clock + ms, callback }); return id;
    }) : setTimeout,
    clearTimeout: fixedClock ? (id => state.timers.delete(id)) : clearTimeout,
  };
  function advance(ms) {
    state.clock += ms;
    for (const [id, timer] of [...state.timers]) if (timer.at <= state.clock) {
      state.timers.delete(id); timer.callback();
    }
  }
  const rows = options.rows ?? new Map([
    [AGENT, { id: AGENT, user_id: OWNER, karta_enabled: true }],
    [OTHER_AGENT, { id: OTHER_AGENT, user_id: OWNER, karta_enabled: true }],
  ]);
  const canonicalJson = execute('karta/src/lib/canonical-json.ts');
  const identity = execute('karta/src/queue/delivery-identity.ts', {
    'node:crypto': { createHash, randomUUID }, '../lib/canonical-json.js': canonicalJson,
  });
  class Queue {
    async add(name, data, { jobId }) {
      state.queueAdds.push({ name, data, jobId });
      if (!state.jobs.has(jobId)) state.jobs.set(jobId, { id: jobId, data: JSON.parse(JSON.stringify(data)), timestamp: 1 });
      return { id: jobId };
    }
    async getJob(id) { return state.jobs.get(id); }
  }
  const queues = execute('karta/src/queue/queues.ts', {
    bullmq: { Queue }, './redis.js': { redisConnection: {} }, './delivery-identity.js': identity,
    // Durable SQL compatibility is tested by queueDeliveryIdentity.test.ts.
    './delivery-guard.js': { assertCycleDeliveryCompatible: async () => {} },
  });
  const unused = () => { throw new Error('Unexpected non-trigger operation'); };
  const apiExports = execute('karta/src/api/server.ts', {
    'node:http': { createServer: callback => { api = callback; return { setTimeout() {}, listen(_port, cb) { cb(); } }; } },
    'node:crypto': { createHash, timingSafeEqual }, '../config.js': { config: { port: 0, adminToken: ADMIN } },
    '../db/supabase.js': { supabase: {} }, '../engine/killswitch.js': { setGlobalKillSwitch: unused },
    '../queue/queues.js': queues, '../queue/delivery-identity.js': identity, '../agents/index.js': { AGENT_REGISTRY: {} },
    '../agents/customAgent.js': { loadCustomAgent: async id => rows.get(id) ?? null },
    '../engine/approval.js': { resolvePendingAction: unused },
    '../engine/brief-submission.js': { BriefSubmissionError: class extends Error {}, dispatchBrief: unused, getBriefStatus: unused, listBriefs: unused, submitBrief: unused },
    '../chef/workshop-service.js': { WorkshopError: class extends Error {}, handleWorkshopRequest: unused },
    './consultation.js': { handleConsultationRequest: async () => false },
    './iaoRoutes.js': { isIaoPath: () => false, handleIaoRoute: unused },
    './public-api-routes.js': { isPublicApiPath: () => false, handlePublicApiRequest: unused },
    './public-api-runtime.js': { createPublicApiRuntime: unused },
  }, globals);
  // Keep unrelated public API ports closed without exposing the host process
  // or reading its environment inside this trigger-only VM.
  apiExports.startApiServer(undefined, { consultationHost: null, publicApiRuntime: null });
  const apiFetch = (url, init) => new Promise(resolve => {
    const headers = Object.fromEntries(new Headers(init.headers));
    let status, replyHeaders;
    api({ method: init.method, url: new URL(url).pathname, headers }, {
      writeHead(value, fields) { status = value; replyHeaders = fields; },
      end(body) { resolve(new Response(body, { status, headers: replyHeaders })); },
    });
  });
  const transport = async (url, init) => {
    state.internal.push({ url: String(url), ...init });
    return options.transport ? options.transport(url, init, apiFetch, state) : apiFetch(url, init);
  };
  const deadline = execute('supabase/functions/_shared/request-deadline.ts', {}, { ...globals, fetch: transport });
  const body = execute('supabase/functions/_shared/request-body.ts', {}, globals);
  const env = {
    SUPABASE_URL: 'https://supabase.example.invalid', SUPABASE_ANON_KEY: 'synthetic-anon',
    KARTA_INTERNAL_URL: 'https://karta.example.invalid', KARTA_ADMIN_TOKEN: ADMIN,
    ...options.env,
  };
  const createClient = (_url, _key, config) => {
    state.clients.push(config);
    return {
      auth: { getUser: async token => {
        state.auth.push(token);
        if (options.auth) return options.auth(token);
        return token === TOKEN ? { data: { user: { id: options.identity ?? OWNER } }, error: null }
          : { data: { user: null }, error: { message: 'PRIVATE_AUTH' } };
      } },
      from(table) {
        assert.equal(table, 'creator_agents');
        const query = { table };
        const q = {
          select(columns) { query.columns = columns; return q; },
          eq(column, value) { assert.equal(column, 'id'); query.id = value; return q; },
          abortSignal(signal) { query.signal = signal; return q; },
          async maybeSingle() {
            state.queries.push(query);
            return options.query ? options.query(query) : { data: rows.get(query.id) ?? null, error: null };
          },
        };
        return q;
      },
    };
  };
  execute('supabase/functions/karta-trigger-custom/index.ts', {
    'npm:@supabase/supabase-js@2.119.2': { createClient },
    '../_shared/rate-limit.ts': { rateLimit: (...args) => options.rateLimit?.(...args) ?? { allowed: true } },
    '../_shared/request-body.ts': body, '../_shared/request-deadline.ts': deadline,
  }, { ...globals, fetch: transport, Deno: { env: { get: name => env[name] }, serve: value => { handler = value; } } });
  assert.equal(typeof handler, 'function');
  function request(body = { agentId: AGENT, requestId: INTENT }, init = {}) {
    const { method = 'POST', headers, ...extra } = init;
    return new Request('https://edge.example.invalid/functions/v1/karta-trigger-custom', {
      method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
      ...(method === 'POST' ? { body: typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body) } : {}),
      ...extra,
    });
  }
  return { handler, request, state, advance, rows };
}
