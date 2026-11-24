import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Browser-default detection only. No query retry count or retry delay is replaced.
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const { QueryClient, QueryObserver, isServer } = await import('@tanstack/query-core');
const { createClient } = await import('@supabase/supabase-js');
assert.equal(isServer, false);
assert.equal(require('@supabase/supabase-js/package.json').version, '2.119.2');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected external transport'); };
const outcomes = [];
try {
  for (const explicitDbRetry of [undefined, false]) {
    const calls = [], started = performance.now();
    const db = { schema: 'purama_ai', ...(explicitDbRetry === undefined ? {} : { retry: explicitDbRetry }) };
    const sdk = createClient('https://sdk-retry-review.invalid', 'synthetic-key-not-a-secret', {
      db, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push({ method: request.method, retry: Number(request.headers.get('X-Retry-Count') ?? '0'), atMs: Math.round(performance.now() - started) });
        return new Response(JSON.stringify({ code: 'fixture_unavailable', message: 'synthetic persistent outage' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      } },
    });
    const client = new QueryClient();
    let queryCalls = 0;
    const observer = new QueryObserver(client, { queryKey: ['actual-defaults', String(explicitDbRetry)], queryFn: async () => {
      queryCalls++;
      const result = await sdk.from('subscriptions').select('plan_type').eq('user_id', 'fixture-owner').maybeSingle();
      if (result.error) throw result.error;
      return result.data;
    } });
    let finalState;
    try {
      finalState = await new Promise(resolve => observer.subscribe(state => { if (state.status === 'error' && state.fetchStatus === 'idle') resolve(state); }));
    } finally { observer.destroy(); client.clear(); }
    const elapsedMs = Math.round(performance.now() - started);
    const expected = explicitDbRetry === false ? [0,0,0,0] : [0,1,2,3,0,1,2,3,0,1,2,3,0,1,2,3];
    assert.equal(queryCalls, 4); assert.deepEqual(calls.map(call => call.retry), expected);
    assert(calls.every(call => call.method === 'GET')); assert.equal(finalState.status, 'error');
    const result = { dbRetry: explicitDbRetry === undefined ? 'SDK default true' : false, queryCalls, httpCalls: calls.length, elapsedMs, finalStatus: finalState.status, calls };
    outcomes.push(result); console.log(JSON.stringify({ phase: 'completed', ...result }));
  }
} finally { globalThis.fetch = originalFetch; delete globalThis.window; }
const proof = { status: 'PASS', sdk: require('@supabase/supabase-js/package.json').version, queryCore: require('@tanstack/query-core/package.json').version, node: process.version, timing: 'real timers; no Retry-After; genuine SDK and QueryObserver; browser-default detection marker only', transport: 'synthetic HTTP; no external network', outcomes };
await writeFile('/tmp/iao-independent-web-retry-review-20261124.json', JSON.stringify(proof, null, 2)+'\n');
console.log('Proof /tmp/iao-independent-web-retry-review-20261124.json');
