import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, afterEach, beforeEach, test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// Production React hook and scope helpers. Only identity and Supabase transport
// are replaced; this suite cannot call a provider or a database.
const require = createRequire(import.meta.url);
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://agent-execution.invalid' });
const originals = new Map();
for (const [key, value] of Object.entries({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  File: dom.window.File, IS_REACT_ACT_ENVIRONMENT: true,
  fetch: () => { throw new Error('Unexpected network access in agent execution test'); },
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const React = require('react');
const { act, createContext, createElement, useContext } = React;
const { createRoot } = require('react-dom/client');
const AuthContext = createContext({ user: null });
const userA = { id: 'agent-owner-a' };
const userB = { id: 'agent-owner-b' };
let root, mounted, latest, actor, proxyReply, agentReply, sessionReply, calls;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function loadProduction(relativePath, dependencies = {}) {
  const filename = fileURLToPath(new URL('../' + relativePath, import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext('(function(require, module, exports) {\n' + outputText + '\n})', { filename })(
    name => {
      assert.ok(Object.hasOwn(dependencies, name), 'Unexpected production import: ' + name);
      return dependencies[name];
    }, module, module.exports,
  );
  return module.exports;
}
const requestScope = loadProduction('src/lib/request-scope.ts');
const reactScope = loadProduction('src/hooks/useRequestScope.ts', { react: React });
const supabase = {
  auth: { getSession: () => sessionReply() },
  functions: {
    invoke(name, options) {
      assert.equal(name, 'agent-proxy');
      calls.proxy.push({ owner: actor?.id, options });
      return proxyReply();
    },
  },
  from(table) {
    if (table === 'agents') {
      const query = {
        select(columns) { assert.equal(columns, 'id'); return query; },
        eq(column, value) { assert.equal(column, 'slug'); calls.read.push({ owner: actor?.id, slug: value }); return query; },
        setHeader() { return query; },
        abortSignal() { return query; },
        maybeSingle() { return agentReply(); },
      };
      return query;
    }
    assert.equal(table, 'agent_usage');
    return { insert(rows) {
      calls.writes.push({ owner: actor?.id, rows });
      const reply = Promise.resolve({ data: null, error: null });
      reply.setHeader = () => reply;
      reply.abortSignal = () => reply;
      return reply;
    } };
  },
};
const { useAgentExecution } = loadProduction('src/hooks/useAgentExecution.ts', {
  react: React,
  './useAuth': { useAuth: () => useContext(AuthContext) },
  './useRequestScope': reactScope,
  '@/hooks/useRequestScope': reactScope,
  '@/lib/request-scope': requestScope,
  '@/config/agentConfigs': { getAgentConfig: () => ({ fields: [] }) },
  '@/integrations/supabase/client': { supabase },
});
function Probe({ slug }) { latest = useAgentExecution(slug); return null; }
async function render(user, slug = 'draft-agent') {
  actor = user;
  await act(async () => {
    root.render(createElement(AuthContext.Provider, { value: { user } }, createElement(Probe, { slug })));
  });
}
async function start(form = { subject: 'prepared content' }) {
  let operation;
  await act(async () => { operation = latest.execute(form); await Promise.resolve(); });
  return { operation };
}
async function complete(operation) {
  let value;
  await act(async () => { value = await operation; });
  return value;
}
const proxyResult = value => ({ data: { success: true, data: value }, error: null });
const test = (name, run) => nodeTest(name, { timeout: 3000 }, run);
beforeEach(() => {
  actor = null; latest = undefined; mounted = true;
  calls = { proxy: [], read: [], writes: [] };
  proxyReply = async () => proxyResult('current result');
  agentReply = async () => ({ data: { id: 'known-agent-id' }, error: null });
  sessionReply = async () => ({
    data: { session: actor ? { user: actor, access_token: 'synthetic-' + actor.id } : null },
    error: null,
  });
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => { if (mounted) await act(async () => { root.unmount(); }); });
after(() => {
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

test('a current execution returns its result and records one usage for its owner', async () => {
  await render(userA);
  const { operation } = await start();
  assert.equal((await complete(operation)).success, true);
  assert.equal(latest.result.data, 'current result');
  assert.equal(latest.isLoading, false);
  assert.equal(calls.proxy.length, 1);
  assert.equal(calls.read.length, 1);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].rows[0].user_id, userA.id);
});
for (const [label, transitions] of [
  ['another account', [userB]],
  ['logout', [null]],
  ['A to B to A', [userB, userA]],
]) {
  test('a late proxy result after ' + label + ' cannot read, write usage or replace current state', async () => {
    const held = deferred();
    proxyReply = () => held.promise;
    await render(userA);
    const { operation } = await start();
    assert.equal(calls.proxy.length, 1);
    for (const next of transitions) await render(next);
    await act(async () => { held.resolve(proxyResult('obsolete result')); await operation; });
    assert.deepEqual(calls.read, [], 'no continuation to the global database client');
    assert.deepEqual(calls.writes, [], 'no stale usage write');
    assert.equal(latest.result, null);
    assert.equal(latest.error, null);
    assert.equal(latest.isLoading, false);
    assert.equal((await operation).success, false);
  });
}
test('unmount cancels continuation after a delayed proxy response', async () => {
  const held = deferred();
  proxyReply = () => held.promise;
  await render(userA);
  const { operation } = await start();
  await act(async () => { root.unmount(); mounted = false; });
  held.resolve(proxyResult('obsolete result'));
  assert.equal((await operation).success, false);
  assert.deepEqual(calls.read, []);
  assert.deepEqual(calls.writes, []);
});
test('an account switch during the usage lookup cannot start a later write', async () => {
  const held = deferred();
  agentReply = () => held.promise;
  await render(userA);
  const { operation } = await start();
  assert.equal(calls.read.length, 1);
  await render(userB);
  await act(async () => { held.resolve({ data: { id: 'known-agent-id' }, error: null }); await operation; });
  assert.deepEqual(calls.writes, []);
  assert.equal(latest.result, null);
});
test('reset cancels a previous execution and an old result cannot replace its successor', async () => {
  const held = deferred();
  proxyReply = () => held.promise;
  await render(userA);
  const old = await start();
  await act(async () => { latest.reset(); });
  proxyReply = async () => proxyResult('successor result');
  const next = await start();
  assert.equal((await complete(next.operation)).success, true);
  await act(async () => { held.resolve(proxyResult('obsolete result')); await old.operation; });
  assert.equal(latest.result.data, 'successor result');
  assert.equal(latest.isLoading, false);
  assert.equal(calls.writes.length, 1);
  assert.equal((await old.operation).success, false);
});
test('session acquisition must complete for the same owner before a proxy call', async () => {
  const held = deferred();
  sessionReply = () => held.promise;
  await render(userA);
  const { operation } = await start();
  await render(userB);
  await act(async () => {
    held.resolve({ data: { session: { user: userB, access_token: 'synthetic-b' } }, error: null });
    await operation;
  });
  assert.deepEqual(calls.proxy, [], 'no proxy call with the successor session');
  assert.deepEqual(calls.writes, []);
});
test('concurrent submissions admit a single execution until it settles', async () => {
  const held = deferred();
  proxyReply = () => held.promise;
  await render(userA);
  const first = await start();
  const second = await start();
  assert.equal(calls.proxy.length, 1);
  await act(async () => { held.resolve(proxyResult('single result')); await first.operation; await second.operation; });
  assert.equal((await second.operation).success, false);
  assert.equal(calls.writes.length, 1);
});
test('the proxy receives the captured owner bearer and an abortable signal', async () => {
  const held = deferred();
  proxyReply = () => held.promise;
  await render(userA);
  const { operation } = await start();
  const options = calls.proxy[0].options;
  assert.equal(options.headers?.Authorization, 'Bearer synthetic-' + userA.id);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  await render(userB);
  assert.equal(options.signal.aborted, true);
  held.resolve(proxyResult('obsolete result'));
  await complete(operation);
});

test('real PostgREST retains captured A bearer when SDK session moves to B before React commits', async () => {
  const { createClient } = require('@supabase/supabase-js');
  const transport = [];
  const realClient = createClient('https://agent-sdk.invalid', 'inert-public-key', {
    accessToken: async () => actor ? 'synthetic-' + actor.id : null,
    global: { fetch: async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      assert.equal(url.origin, 'https://agent-sdk.invalid');
      const table = url.pathname.split('/').pop();
      const authorization = new Headers(init.headers).get('authorization');
      const body = init.body ? JSON.parse(init.body) : null;
      transport.push({ table, authorization, bodyOwner: body?.[0]?.user_id ?? null });
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      if (table === 'agents') return new Response(JSON.stringify([{ id: 'known-agent-id' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (table === 'agent_usage') return new Response(null, { status: 201 });
      throw new Error('Unexpected table: ' + table);
    } },
  });
  const originalFrom = supabase.from;
  try {
    supabase.from = realClient.from.bind(realClient);
    proxyReply = async () => { actor = userB; return proxyResult('result for captured A'); };
    await render(userA);
    const { operation } = await start();
    assert.equal((await complete(operation)).success, true);
    assert.deepEqual(transport, [
      { table: 'agents', authorization: 'Bearer synthetic-' + userA.id, bodyOwner: null },
      { table: 'agent_usage', authorization: 'Bearer synthetic-' + userA.id, bodyOwner: userA.id },
    ]);
  } finally {
    supabase.from = originalFrom;
  }
});
