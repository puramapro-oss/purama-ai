// Actual Edge handler + Supabase SDK + disposable native PostgreSQL.
// Only Auth identities, PostgREST transport and the cryptographic provider result
// are fixtures. SQL functions, RLS, row locks, failures and commits are real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createClient as sdkClient } from '@supabase/supabase-js';

const root = path.resolve(process.env.OTS_VERIFY_CHECKOUT || fileURLToPath(new URL('../..', import.meta.url)));
const output = path.resolve(process.env.OTS_VERIFY_REPORT || '/tmp/purama-ots-verify-result.json');
const runtimePath = process.env.PURAMA_POSTGRES_TEST_RUNTIME;
assert(runtimePath && path.isAbsolute(runtimePath), 'An explicit qualified private PostgreSQL runtime is required');
const { withPrivatePostgres } = await import(pathToFileURL(runtimePath));
const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const FOREIGN = '44444444-4444-4444-8444-444444444444';
const SERVICE = 'fixture-service-never-live';
const OLD_PROOF = Buffer.from('fixture-old-proof').toString('base64');
const NEW_PROOF = Buffer.from('fixture-new-proof').toString('base64');
const HASH = 'ab'.repeat(32);
const HEIGHT = 900001;
const TIMESTAMP = 1793656800;
const BTC = new Date(TIMESTAMP * 1000).toISOString();
const BASE = 'supabase/migrations/20260423110000_docuseal_contracts.sql';
const STAMP = 'supabase/migrations/20261110180000_contract_ots_audit_atomicity.sql';
const VERIFY = 'supabase/migrations/20261110210000_contract_ots_verification_atomicity.sql';
const ENTRY = 'supabase/functions/contracts-ots-verify/index.ts';
const RPC_ARGS = ['p_contract_id', 'p_user_id', 'p_status', 'p_submission_id', 'p_previous_hash',
  'p_previous_proof', 'p_previous_verified_at', 'p_previous_block_height', 'p_previous_btc_timestamp',
  'p_proof', 'p_block_height', 'p_btc_timestamp', 'p_actor_id', 'p_actor_type'];
const report = { started_at: new Date().toISOString(), scope: 'actual Edge + SDK + native SQL; cryptographic confirmation is synthetic',
  source_sha256: {}, harness_sha256: hashFile(fileURLToPath(import.meta.url)),
  runtime_sha256: hashFile(runtimePath), checks: [], external_requests: 0 };
for (const file of [BASE, STAMP, VERIFY, ENTRY, 'tests/contracts-ots/verification-atomicity.mjs']) {
  if (fs.existsSync(path.join(root, file))) report.source_sha256[file] = hashFile(path.join(root, file));
}
function persist() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
function rpcParameters(contract, extra = {}) {
  return { p_contract_id: contract.id, p_user_id: contract.user_id, p_status: contract.status,
    p_submission_id: contract.docuseal_submission_id, p_previous_hash: contract.ots_stamp_hash,
    p_previous_proof: contract.ots_proof, p_previous_verified_at: contract.ots_verified_at,
    p_previous_block_height: contract.ots_block_height, p_previous_btc_timestamp: contract.ots_btc_timestamp,
    p_proof: NEW_PROOF, p_block_height: HEIGHT, p_btc_timestamp: BTC, p_actor_id: OWNER, p_actor_type: 'user', ...extra };
}
let failure;
try {
  await withPrivatePostgres(async ({ pg, connection, signal }) => {
    const pool = new pg.Pool({ ...connection, max: 8 });
    const query = (sql, args) => pool.query(sql, args);
    const snapshot = async () => (await query(`SELECT jsonb_build_object(
      'contract',(SELECT to_jsonb(c) FROM purama_ai.contracts c WHERE id=$1),
      'events',coalesce((SELECT jsonb_agg(e ORDER BY created_at,id) FROM purama_ai.contract_events e),'[]'::jsonb)) AS value`, [ID])).rows[0].value;
    const reset = async () => {
      signal.throwIfAborted();
      await query('DROP TRIGGER IF EXISTS fixture_audit_failure ON purama_ai.contract_events');
      await query('TRUNCATE purama_ai.contracts CASCADE');
      await query(`INSERT INTO purama_ai.contracts(id,user_id,app_slug,template_slug,status,docuseal_submission_id,ots_stamp_hash,ots_proof)
        VALUES($1,$2,'fixture','fixture','signed',17,$3,$4)`, [ID, OWNER, HASH, OLD_PROOF]);
    };
    const auditFailure = () => query(`CREATE OR REPLACE FUNCTION purama_ai.fixture_audit_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-private-audit-failure' USING ERRCODE='P7002'; END $$;
      CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON purama_ai.contract_events
      FOR EACH ROW EXECUTE FUNCTION purama_ai.fixture_audit_failure()`);
    const transaction = async (role, actor, operation) => {
      assert(['anon', 'authenticated', 'service_role'].includes(role));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true)", [role, actor || '']);
        const value = await operation(client);
        await client.query('COMMIT');
        return value;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    const callRpc = (args, role = 'service_role') => transaction(role, null, async client => {
      const values = RPC_ARGS.map(name => args[name]);
      const row = (await client.query(`SELECT purama_ai.persist_contract_ots_verification(${values.map((_, i) => `$${i + 1}`).join(',')}) AS id`, values)).rows[0];
      return row.id;
    });
    async function handler(options = {}) {
      let serve, authCalls = 0, reads = 0;
      const calls = [];
      const state = { afterVerify: options.afterVerify, beforeRpc: options.beforeRpc };
      const fetchFixture = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        assert.equal(url.origin, 'https://db.fixture.invalid', 'No external transport is permitted');
        const headers = new Headers(init.headers);
        const token = headers.get('authorization')?.replace(/^Bearer /, '');
        const actor = token === 'fixture-owner' ? OWNER : token === 'fixture-admin' ? ADMIN : token === 'fixture-foreign' ? FOREIGN : null;
        const role = token === SERVICE ? 'service_role' : 'authenticated';
        const method = init.method || 'GET';
        calls.push({ path: url.pathname, method, role, actor, profile: headers.get('content-profile') || headers.get('accept-profile') });
        if (url.pathname === '/auth/v1/user') {
          authCalls++;
          if (!actor || (options.revoke && authCalls > 1)) return Response.json({ message: 'invalid token' }, { status: 401 });
          return Response.json({ id: actor, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid' });
        }
        assert.equal(headers.get('content-profile') || headers.get('accept-profile'), 'purama_ai');
        if (url.pathname === '/rest/v1/rpc/persist_contract_ots_verification') {
          assert.equal(method, 'POST');
          assert.equal(role, 'service_role', 'Only the existing service boundary may persist verified results');
          if (state.beforeRpc) { const action = state.beforeRpc; state.beforeRpc = null; await action(); }
          if (options.rpcMissing) return Response.json({ code: 'PGRST202', message: 'fixture-private-schema-cache' }, { status: 404 });
          try { return Response.json(await callRpc(JSON.parse(init.body))); }
          catch (error) { return Response.json({ code: error.code, message: error.message }, { status: 500 }); }
        }
        const permitted = new Set(['id', 'user_id', 'status', 'docuseal_submission_id', 'ots_stamp_hash', 'ots_proof',
          'ots_verified_at', 'ots_block_height', 'ots_btc_timestamp']);
        const values = [];
        function parameter(value) { values.push(value); return `$${values.length}`; }
        function filters() {
          return [...url.searchParams].filter(([key]) => key !== 'select').map(([key, value]) => {
            assert(permitted.has(key));
            if (value === 'is.null') return `${key} IS NULL`;
            assert(value.startsWith('eq.'));
            return `${key}=${parameter(value.slice(3))}`;
          }).join(' AND ');
        }
        try {
          const data = await transaction(role, actor, async client => {
            if (url.pathname === '/rest/v1/contracts' && method === 'GET') {
              reads++;
              if (options.readError) throw Object.assign(new Error('fixture-private-read'), { code: 'P7003' });
              return (await client.query(`SELECT to_jsonb(c) AS row FROM purama_ai.contracts c WHERE ${filters()}`, values)).rows.map(row => row.row);
            }
            if (url.pathname === '/rest/v1/contracts' && method === 'PATCH') {
              const patch = JSON.parse(init.body);
              const assignments = Object.entries(patch).map(([key, value]) => { assert(permitted.has(key)); return `${key}=${parameter(value)}`; });
              return (await client.query(`UPDATE purama_ai.contracts SET ${assignments.join(',')} WHERE ${filters()} RETURNING id`, values)).rows;
            }
            if (url.pathname === '/rest/v1/contract_events' && method === 'POST') {
              const event = JSON.parse(init.body);
              await client.query(`INSERT INTO purama_ai.contract_events(contract_id,event_type,payload,actor_id,actor_type) VALUES($1,$2,$3,$4,$5)`,
                [event.contract_id, event.event_type, event.payload, event.actor_id, event.actor_type]);
              return null;
            }
            throw new Error('Unexpected fixture SQL transport');
          });
          return Response.json(data);
        } catch (error) { return Response.json({ code: error.code, message: error.message }, { status: 500 }); }
      };
      const environment = { SUPABASE_URL: 'https://db.fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: 'fixture-anon' };
      const context = vm.createContext({ Request, Response, Headers, URL, Uint8Array, TextEncoder, TextDecoder, AbortController,
        ReadableStream, performance, setTimeout, clearTimeout, atob, btoa, crypto: webcrypto,
        fetch: () => { report.external_requests++; throw new Error('External fetch forbidden'); },
        Deno: { env: { get: key => environment[key] }, serve: fn => { serve = fn; } } });
      const modules = new Map();
      function local(file) {
        if (modules.has(file)) return modules.get(file);
        report.source_sha256[path.relative(root, file)] = hashFile(file);
        const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
        const module = new vm.SourceTextModule(code, { context, identifier: file }); modules.set(file, module); return module;
      }
      const entry = local(path.join(root, ENTRY));
      await entry.link((specifier, parent) => {
        if (specifier === 'npm:@supabase/supabase-js@2.91.0') return new vm.SyntheticModule(['createClient'], function () {
          this.setExport('createClient', (url, key, settings) => sdkClient(url, key, { ...settings,
            global: { ...settings.global, fetch: fetchFixture } }));
        }, { context });
        const file = path.resolve(path.dirname(parent.identifier), specifier);
        assert(specifier.startsWith('.') && file.startsWith(root + path.sep), 'Only repository modules are loaded');
        if (file.endsWith('/_shared/ots-library.ts')) return new vm.SyntheticModule(['ots'], function () {
          this.setExport('ots', { verifyDigest: async () => {
            if (state.afterVerify) await state.afterVerify();
            if (options.providerFailure) throw new Error('fixture-private-provider');
            return { proof: options.proof || NEW_PROOF, bitcoin: options.pending ? undefined : { height: HEIGHT, timestamp: TIMESTAMP } };
          } });
        }, { context });
        return local(file);
      });
      await entry.evaluate();
      return { calls, request: (token = 'fixture-owner', extra = '') => serve(new Request(`https://edge.fixture.invalid/verify?id=${ID}${extra}`, {
        headers: { Authorization: `Bearer ${token}` } })), stats: () => ({ authCalls, reads }) };
    }
    async function check(name, action) {
      await reset();
      try { const observed = await action(); report.checks.push({ name, status: 'PASS', observed }); }
      catch (error) { report.checks.push({ name, status: 'FAIL', error: String(error), observed: await snapshot() }); }
      persist();
    }
    try {
      await query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role NOLOGIN BYPASSRLS;
        CREATE SCHEMA auth; CREATE SCHEMA purama_ai; CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
        CREATE TYPE purama_ai.app_role AS ENUM ('admin','user');
        CREATE FUNCTION purama_ai.has_role(_user_id uuid,_role purama_ai.app_role) RETURNS boolean LANGUAGE sql STABLE
          AS $$ SELECT _user_id='${ADMIN}'::uuid AND _role='admin'::purama_ai.app_role $$;
        GRANT USAGE ON SCHEMA auth,purama_ai TO anon,authenticated,service_role;
        INSERT INTO auth.users(id) VALUES('${OWNER}'),('${ADMIN}'),('${FOREIGN}')`);
      await query(fs.readFileSync(path.join(root, BASE), 'utf8'));
      await query(fs.readFileSync(path.join(root, STAMP), 'utf8'));
      if (fs.existsSync(path.join(root, VERIFY))) await query(fs.readFileSync(path.join(root, VERIFY), 'utf8'));

      await check('audit insertion failure leaves the actual Edge confirmation and proof unchanged', async () => {
        const before = await snapshot(); await auditFailure();
        const h = await handler(); const response = await h.request();
        assert.equal(response.status, 500); assert.equal((await response.text()).includes('fixture-private'), false);
        assert.deepEqual(await snapshot(), before);
        return { response: 500, full_rollback: true, auth: h.stats(), transport: h.calls };
      });
      await check('same height and proof with a different stored Bitcoin timestamp is reconciled', async () => {
        await query(`UPDATE purama_ai.contracts SET ots_verified_at='2026-10-01',ots_block_height=$1,ots_proof=$2,ots_btc_timestamp='2026-10-01' WHERE id=$3`, [HEIGHT, NEW_PROOF, ID]);
        const h = await handler(); assert.equal((await h.request()).status, 200);
        const after = await snapshot(); assert.equal(Date.parse(after.contract.ots_btc_timestamp), Date.parse(BTC));
        assert.equal(after.events.length, 1); return { timestamp_corrected: true, audit_count: 1 };
      });
      for (const [field, value] of Object.entries({ ots_verified_at: null, ots_block_height: HEIGHT + 1, ots_btc_timestamp: '2026-10-01T00:00:00Z' })) {
        await check(`an initially confirmed result still checks concurrent ${field} changes`, async () => {
          await query(`UPDATE purama_ai.contracts SET ots_verified_at='2026-10-01',ots_block_height=$1,ots_proof=$2,ots_btc_timestamp=$3 WHERE id=$4`, [HEIGHT, NEW_PROOF, BTC, ID]);
          let changed;
          const h = await handler({ afterVerify: async () => {
            await query(`UPDATE purama_ai.contracts SET ${field}=$1 WHERE id=$2`, [value, ID]); changed = await snapshot();
          } });
          assert.equal((await h.request()).status, 409); assert.deepEqual(await snapshot(), changed);
          return { response: 409, no_stale_confirmation: true };
        });
      }
      if (process.env.OTS_VERIFY_CAUSAL_ONLY !== '1') {
        for (const [token, actor, kind] of [['fixture-owner', OWNER, 'user'], ['fixture-admin', ADMIN, 'user'], [SERVICE, null, 'system']]) {
          await check(`actual SDK atomic verification preserves actor ${kind}:${actor || 'service'}`, async () => {
            const h = await handler(); const response = await h.request(token); assert.equal(response.status, 200);
            const after = await snapshot(); assert.equal(after.contract.ots_proof, NEW_PROOF); assert.equal(after.contract.ots_block_height, HEIGHT);
            assert.equal(after.events.length, 1); assert.equal(after.events[0].event_type, 'ots_verified');
            assert.equal(after.events[0].actor_id, actor); assert.equal(after.events[0].actor_type, kind);
            assert.equal(h.calls.filter(c => c.path.endsWith('/rpc/persist_contract_ots_verification')).length, 1);
            assert.equal(h.calls.filter(c => ['PATCH', 'POST'].includes(c.method) && !c.path.includes('/rpc/')).length, 0);
            assert.equal((await h.request(token)).status, 200); assert.equal((await snapshot()).events.length, 1);
            return { proof_and_audit: true, audit_count_after_repeat: 1, stats: h.stats(), transport: h.calls };
          });
        }
        for (const [name, options, token, status] of [
          ['foreign row hidden by real RLS', {}, 'fixture-foreign', 404],
          ['unknown JWT', {}, 'fixture-invalid', 401],
          ['revoked JWT after verification', { revoke: true }, 'fixture-owner', 401],
          ['contract read unavailable', { readError: true }, 'fixture-owner', 503],
          ['provider unavailable', { providerFailure: true }, 'fixture-owner', 502],
          ['pending confirmation', { pending: true }, 'fixture-owner', 200],
          ['missing migration fails closed', { rpcMissing: true }, 'fixture-owner', 500],
        ]) await check(name, async () => {
          const before = await snapshot(); const h = await handler(options); const response = await h.request(token);
          assert.equal(response.status, status); assert.equal((await response.text()).includes('fixture-private'), false);
          assert.deepEqual(await snapshot(), before); return { response: status, no_changes: true };
        });
        const fieldChanges = { id: FOREIGN, user_id: FOREIGN, status: 'cancelled', docuseal_submission_id: 18,
          ots_stamp_hash: 'cd'.repeat(32), ots_proof: Buffer.from('changed').toString('base64'),
          ots_verified_at: '2026-10-02T00:00:00Z', ots_block_height: 900002, ots_btc_timestamp: '2026-10-03T00:00:00Z' };
        for (const [field, value] of Object.entries(fieldChanges)) await check(`last-moment compare-and-set rejects changed ${field}`, async () => {
          let changed;
          const h = await handler({ beforeRpc: async () => {
            await query(`UPDATE purama_ai.contracts SET ${field}=$1 WHERE id=$2`, [value, ID]); changed = await snapshot();
          } });
          assert.equal((await h.request()).status, 409); assert.deepEqual(await snapshot(), changed);
          return { response: 409, no_overwrite: true };
        });
        await check('ownership change during cryptographic verification is rejected before service persistence', async () => {
          const h = await handler({ afterVerify: () => query('UPDATE purama_ai.contracts SET user_id=$1 WHERE id=$2', [FOREIGN, ID]) });
          assert.equal((await h.request()).status, 404); assert.equal((await snapshot()).events.length, 0);
          assert.equal(h.calls.some(c => c.path.includes('/rpc/')), false); return { response: 404, no_rpc: true };
        });
        for (const role of ['anon', 'authenticated']) await check(`direct verification RPC denied to ${role}`, async () => {
          const before = await snapshot(); await assert.rejects(callRpc(rpcParameters(before.contract), role), { code: '42501' });
          assert.deepEqual(await snapshot(), before); return { sqlstate: '42501', no_changes: true };
        });
        await check('RPC stays invoker-only with fixed search path and no public execute', async () => {
          const row = (await query(`SELECT p.prosecdef,p.proconfig,
            has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
            has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
            has_function_privilege('service_role',p.oid,'EXECUTE') AS service
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='purama_ai' AND p.proname='persist_contract_ots_verification'`)).rows;
          assert.equal(row.length, 1); assert.equal(row[0].prosecdef, false); assert.deepEqual(row[0].proconfig, ['search_path=""']);
          assert.equal(row[0].anon, false); assert.equal(row[0].authenticated, false); assert.equal(row[0].service, true); return row[0];
        });
        const invalid = [
          { p_actor_type: 'user', p_actor_id: null }, { p_actor_type: 'system', p_actor_id: OWNER }, { p_actor_type: 'service' },
          { p_actor_type: null }, { p_proof: '' }, { p_proof: 'not base64' }, { p_proof: Buffer.alloc(64001).toString('base64') },
          { p_block_height: -1 }, { p_block_height: null }, { p_block_height: '9007199254740992' },
          { p_btc_timestamp: null }, { p_btc_timestamp: 'infinity' }, { p_btc_timestamp: '1970-01-01T00:00:00Z' },
        ];
        for (const [index, extra] of invalid.entries()) await check(`invalid confirmed result is atomic and rejected (${index + 1})`, async () => {
          const before = await snapshot(); await assert.rejects(callRpc(rpcParameters(before.contract, extra)), { code: '22023' });
          assert.deepEqual(await snapshot(), before); return { sqlstate: '22023', no_changes: true };
        });
        await check('64,000-byte proof boundary and nullable submission are preserved', async () => {
          await query('UPDATE purama_ai.contracts SET docuseal_submission_id=NULL WHERE id=$1', [ID]);
          const before = await snapshot(); const proof = Buffer.alloc(64000, 1).toString('base64');
          assert.equal(await callRpc(rpcParameters(before.contract, { p_proof: proof })), ID);
          const after = await snapshot(); assert.equal(after.contract.ots_proof, proof); assert.equal(after.events.length, 1);
          return { decoded_proof_bytes: 64000, nullable_submission: true };
        });
        await check('four concurrent confirmations share one winning state and audit', async () => {
          const before = await snapshot(); const args = rpcParameters(before.contract);
          const holder = await pool.connect(); let writers = Promise.resolve([]), blocked = 0, observationError;
          try {
            await holder.query('BEGIN');
            await holder.query('SELECT id FROM purama_ai.contracts WHERE id=$1 FOR UPDATE', [ID]);
            // Observe every rejection immediately, including if observation or
            // cleanup fails before the held row can be released.
            writers = Promise.allSettled(Array.from({ length: 4 }, () => callRpc(args)));
            const deadline = performance.now() + 2000;
            while (blocked < 4 && performance.now() < deadline) {
              blocked = Number((await query(`SELECT count(*) FROM pg_stat_activity
                WHERE application_name=$1 AND wait_event_type='Lock'
                  AND query LIKE 'SELECT purama_ai.persist_contract_ots_verification(%'`, [connection.application_name])).rows[0].count);
              if (blocked < 4) await new Promise(resolve => setTimeout(resolve, 10));
            }
          } catch (error) { observationError = error; }
          finally {
            let cleanupError;
            try { await holder.query('ROLLBACK'); }
            catch (error) { cleanupError = error; observationError ??= error; }
            holder.release(cleanupError);
          }
          const settled = await writers;
          if (observationError) throw observationError;
          const results = settled.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
          assert.equal(blocked, 4, 'Observe all four native PostgreSQL writers blocked on the held row before releasing it');
          assert.equal(results.filter(x => x === ID).length, 1); assert.equal(results.filter(x => x === null).length, 3);
          assert.equal((await snapshot()).events.length, 1); return { writers: 4, observed_native_lock_waiters: blocked, persisted: 1, conflicts: 3, audit_count: 1 };
        });
        await check('direct repeat with a current snapshot creates no duplicate audit', async () => {
          assert.equal(await callRpc(rpcParameters((await snapshot()).contract)), ID);
          const before = await snapshot(); assert.equal(await callRpc(rpcParameters(before.contract)), ID);
          assert.deepEqual(await snapshot(), before); return { audit_count: 1, no_second_update: true };
        });
      }
    } finally { await pool.end(); }
    return { checks: report.checks.length, failed: report.checks.filter(x => x.status !== 'PASS').length };
  }, { evidencePath: process.env.PURAMA_NATIVE_RUNTIME_REPORT || output.replace(/\.json$/, '.runtime.json') });
} catch (error) { failure = error; report.failure = error.stack; }
report.finished_at = new Date().toISOString();
report.status = failure || report.checks.some(x => x.status !== 'PASS') ? 'FAIL' : 'PASS';
report.passed = report.checks.filter(x => x.status === 'PASS').length;
report.failed = report.checks.filter(x => x.status !== 'PASS').length;
persist();
console.log(JSON.stringify({ status: report.status, passed: report.passed, failed: report.failed, output, failure: failure?.message }));
if (report.status !== 'PASS') process.exitCode = 1;
