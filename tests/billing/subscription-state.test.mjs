import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, beforeEach, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// Render the production hook with the installed React Query implementation.
// Only identity and the database boundary are replaced; no HTTP is allowed.
const require = createRequire(import.meta.url);
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://billing.invalid' });
const originalGlobals = new Map();
for (const [key, value] of Object.entries({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: () => { throw new Error('Unexpected network access in subscription state test'); },
})) {
  originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const React = require('react');
const { act, createContext, createElement, useContext } = React;
const { createRoot } = require('react-dom/client');
const query = require('@tanstack/react-query');
const { QueryClient, QueryClientProvider, onlineManager } = query;
const AuthContext = createContext({ user: null });
let respond, reads, client, root, latest;

function loadProduction(relativePath, dependencies = {}) {
  const filename = fileURLToPath(new URL('../../' + relativePath, import.meta.url));
  const source = readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  const imported = (name) => {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected production import: ' + name);
    return dependencies[name];
  };
  runInThisContext('(function(require, module, exports) {\n' + outputText + '\n})', { filename })(
    imported, module, module.exports,
  );
  return module.exports;
}
const catalog = loadProduction('supabase/functions/_shared/plans.ts');
const plans = loadProduction('src/lib/plans.ts', { '../../supabase/functions/_shared/plans.ts': catalog });
const constants = loadProduction('src/lib/constants.ts');
const { useSubscription } = loadProduction('src/hooks/useSubscription.ts', {
  react: React,
  '@tanstack/react-query': query,
  './useAuth': { useAuth: () => useContext(AuthContext) },
  '@/lib/constants': constants,
  '@/lib/plans': plans,
  '@/integrations/supabase/client': {
    supabase: {
      from(table) {
        assert.equal(table, 'subscriptions');
        return { select(columns) {
          assert.equal(columns, 'plan_type, status, trial_ends_at, has_used_trial');
          return { eq(column, id) {
            assert.equal(column, 'user_id');
            return { maybeSingle() { reads.push(id); return respond(id); } };
          } };
        } };
      },
    },
  },
});

const userA = { id: 'billing-user-a', email: 'a@example.test' };
const userB = { id: 'billing-user-b', email: 'b@example.test' };
const paid = { plan_type: 'pro', status: 'active', trial_ends_at: null, has_used_trial: true };
function Probe() { latest = useSubscription(); return null; }
async function render(user) {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client },
      createElement(AuthContext.Provider, { value: { user } }, createElement(Probe))));
  });
}
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
function state(user = userA) { return client.getQueryState(['subscription', user?.id]); }
function blocked() { return latest.isLoading || latest.isError; }

beforeEach(() => {
  reads = [];
  latest = undefined;
  respond = async () => ({ data: null, error: null });
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  client.clear();
  onlineManager.setOnline(true);
});
after(() => {
  dom.window.close();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

test('authenticated offline without cache remains blocked while the first subscription read is paused', async () => {
  onlineManager.setOnline(false);
  await render(userA);
  assert.equal(state().status, 'pending');
  assert.equal(state().fetchStatus, 'paused');
  assert.equal(state().data, undefined);
  assert.deepEqual(reads, []);
  assert.equal(latest.isError, false);
  assert.equal(latest.isLoading, true, 'a paused first read must not admit billing actions');
  assert.equal(blocked(), true);
});

test('signed out is not stuck loading even though its disabled query is pending', async () => {
  onlineManager.setOnline(false);
  await render(null);
  assert.equal(state(null).status, 'pending');
  assert.equal(state(null).fetchStatus, 'idle');
  assert.equal(latest.isLoading, false);
  assert.equal(latest.isError, false);
  assert.equal(latest.hasSubscription, false);
  assert.deepEqual(reads, []);
});

test('an authenticated read error remains blocked by isError, not by an endless loading flag', async () => {
  respond = async () => ({ data: null, error: new Error('fixture: subscription unavailable') });
  await render(userA);
  await settle();
  assert.equal(state().status, 'error');
  assert.deepEqual(reads, [userA.id]);
  assert.equal(latest.isLoading, false);
  assert.equal(latest.isError, true);
  assert.equal(blocked(), true);
});

for (const [label, cached, expectedPlan] of [['confirmed free', null, 'free'], ['active paid', paid, 'pro']]) {
  test('offline ' + label + ' cache for this account remains usable without a new read', async () => {
    client.setQueryData(['subscription', userA.id], cached);
    onlineManager.setOnline(false);
    await render(userA);
    assert.equal(state().status, 'success');
    assert.equal(latest.isLoading, false);
    assert.equal(latest.isError, false);
    assert.equal(latest.planId, expectedPlan);
    assert.equal(latest.hasSubscription, expectedPlan !== 'free');
    assert.deepEqual(reads, []);
  });
}

test('changing accounts offline blocks the uncached account without reusing another account subscription', async () => {
  client.setQueryData(['subscription', userA.id], paid);
  onlineManager.setOnline(false);
  await render(userA);
  assert.equal(latest.planId, 'pro');
  assert.equal(blocked(), false);
  await render(userB);
  assert.equal(state(userB).data, undefined);
  assert.equal(state(userB).fetchStatus, 'paused');
  assert.equal(latest.planId, 'free');
  assert.equal(latest.hasSubscription, false);
  assert.equal(blocked(), true);
  await render(userA);
  assert.equal(latest.planId, 'pro');
  assert.equal(blocked(), false);
  await render(null);
  assert.equal(latest.isLoading, false);
  assert.equal(latest.hasSubscription, false);
  assert.deepEqual(reads, []);
});

test('a completed empty read confirms the free plan and releases the loading guard', async () => {
  let finish;
  respond = () => new Promise((resolve) => { finish = resolve; });
  await render(userA);
  assert.equal(latest.isLoading, true);
  assert.equal(state().fetchStatus, 'fetching');
  await act(async () => { finish({ data: null, error: null }); });
  await settle();
  assert.equal(state().status, 'success');
  assert.equal(latest.isLoading, false);
  assert.equal(latest.isError, false);
  assert.equal(latest.planId, 'free');
  assert.deepEqual(reads, [userA.id]);
});

test('an error refreshing cached paid data keeps the error guard even while the plan is retained', async () => {
  client.setQueryData(['subscription', userA.id], paid);
  await render(userA);
  respond = async () => ({ data: null, error: new Error('fixture: refresh rejected') });
  await act(async () => { await client.refetchQueries({ queryKey: ['subscription', userA.id], exact: true }); });
  await settle();
  assert.equal(latest.planId, 'pro');
  assert.equal(latest.isLoading, false);
  assert.equal(latest.isError, true);
  assert.equal(blocked(), true);
});
