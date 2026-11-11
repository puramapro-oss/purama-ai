import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Real compatibility adapter + transport + canonical pure mission functions.
// Only session acquisition and the HTTP peer are fixtures. This is not a
// browser, Supabase Auth, deployed edge or PostgreSQL concurrency qualification.
const domain = process.env.ENTRAIDE_DOMAIN_SOURCE || fileURLToPath(new URL('../../../packages/purama-entraide/src/missions.ts', import.meta.url));
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../../src/lib/entraide.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24',
  alias: { '@purama/entraide': domain },
  define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://entraide.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public' }) },
  plugins: [{ name: 'explicit-session-fixture', setup(builder) {
    builder.onResolve({ filter: /^@\/integrations\/supabase\/client$/ }, () => ({ path: 'session', namespace: 'test-fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-fixture' }, () => ({ contents: 'export const supabase = globalThis.__entraideTestSession;' }));
  } }],
});
const code = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`;
const actor = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
let moduleSequence = 0;
async function adapter() {
  globalThis.__entraideTestSession = { auth: { getSession: async () => ({ data: { session: { user: { id: actor }, access_token: 'synthetic-session' } }, error: null }) } };
  try { return await import(`${code}#${++moduleSequence}`); }
  finally { delete globalThis.__entraideTestSession; }
}
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function mission() {
  return { id: randomUUID(), organizer_id: actor, min_participants: 2, max_participants: 3, status: 'prete', revision: 1,
    missions_collectives_participants: [actor, other].map(user_id => ({ user_id, joined_at: '2026-11-10T00:00:00Z' })) };
}

test('compatibility retries preserve the command ID and original revision after a committed response is lost', async t => {
  const client = await adapter(); let current = mission(); let reads = 0; const writes = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'GET') { reads++; return response({ mission: current }); }
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) {
      current = { ...current, status: 'en_cours', revision: 2 };
      return response({ error: 'service_unavailable' }, 503);
    }
    return response({ mission: current, replayed: true });
  });
  const loaded = await client.loadMissionCollective(current.id);
  const desired = { ...loaded, status: 'en_cours' };
  await assert.rejects(client.persistMissionCollective(desired), e => e.status === 503);
  await assert.rejects(client.persistMissionCollective({ ...desired, status: 'annulee' }), /précédente modification/);
  assert.equal(writes.length, 1, 'no competing intention while the previous result is unknown');
  await client.persistMissionCollective(desired);
  assert.equal(reads, 2, 'retry uses its captured command, not a newer GET precondition');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0]);
  assert.match(writes[0].request_id, /^[0-9a-f-]{36}$/);
  assert.equal(writes[0].expected_revision, 1);
});

test('a definitive business refusal releases the pending intent and a later action gets a new identity', async t => {
  const client = await adapter(); const current = mission(); const writes = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'GET') return response({ mission: current });
    writes.push(JSON.parse(options.body));
    return writes.length === 1 ? response({ error: 'revision_conflict' }, 409)
      : response({ mission: { ...current, status: 'annulee', revision: 2 }, replayed: false });
  });
  const loaded = await client.loadMissionCollective(current.id);
  await assert.rejects(client.persistMissionCollective({ ...loaded, status: 'en_cours' }), e => e.status === 409);
  await client.persistMissionCollective({ ...loaded, status: 'annulee' });
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0].request_id, writes[1].request_id);
  assert.equal(writes[1].expected_revision, 1);
});
