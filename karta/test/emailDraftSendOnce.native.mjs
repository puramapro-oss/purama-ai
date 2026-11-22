#!/usr/bin/env node
/**
 * Native PostgreSQL verification of the real Gmail send-reservation migration.
 * Only creates a new private, disposable socket-only cluster. Never uses an
 * existing DB, a Gmail account, provider credentials, HTTP, or the Mac.
 *
 * node emailDraftSendOnce.native.mjs --repo /path/to/repo \
 *   --pg-bin /installed/postgresql/bin --output /path/to/report.json
 *
 * Cluster/concurrency pattern reused from karta/test/chefWorkshopConcurrency.native.mjs.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  assert(argv[index + 1] && !argv[index + 1].startsWith('--'), `Missing ${name} value`);
  return argv[index + 1];
}
const repo = resolve(option('--repo', join(dirname(fileURLToPath(import.meta.url)), '../..')));
const pgBinOption = option('--pg-bin', process.env.PG_BIN);
const output = resolve(option('--output', join(repo, 'test-results/email-draft-send-once-native.json')));
const require = createRequire(join(repo, 'karta/package.json'));
const pg = require('pg');
const hash = value => createHash('sha256').update(value).digest('hex');
const report = {
  status: 'RUNNING', started_at: new Date().toISOString(), node_version: process.version,
  scope: 'Real versioned Gmail SQL; independent PostgreSQL sessions and observed lock overlap; no Gmail/provider/production execution',
  isolation: { new_private_cluster: true, existing_database_used: false, tcp_disabled: true, external_provider_calls: 0 },
  sources: [], checks: [], cleanup: { server_stopped: false, owned_cluster_removed: false },
};
let bin, cluster, data, coordinator, first, second;
let stopping = false;
let started = false;
const clients = [];
const binaryEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
const run = (name, args, timeout = 30000) => exec(join(bin, name), args, { timeout, maxBuffer: 1024 * 1024, env: binaryEnv });
const sleep = ms => new Promise(done => setTimeout(done, ms));
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const logId = '00000000-0000-4000-8000-000000000011';
const replacement = '00000000-0000-4000-8000-000000000012';
const claimA = '00000000-0000-4000-8000-000000000021';
const claimB = '00000000-0000-4000-8000-000000000022';
let approvalId;
const sourcePaths = [
  'supabase/migrations/20260406210000_email_agent.sql',
  'supabase/migrations/20261122004000_email_agent_send_reservations.sql',
  'supabase/migrations/20261122020000_email_agent_draft_approvals.sql',
  'supabase/migrations/20261122021000_email_agent_send_reconciliation.sql',
  'karta/test/emailDraftSendOnce.test.ts',
  'karta/test/emailDraftReconciliation.test.ts',
];
const authorPins = {
  'supabase/migrations/20260406210000_email_agent.sql': '7665c631663bb6d2c252543d16af553c31a88b1692963b12f22c9da15fb7c458',
  'supabase/migrations/20261122004000_email_agent_send_reservations.sql': '5bcba773e889db61727562c863cac1eec6c337abd709d925193d0ff1e4a67a04',
};
const sources = new Map();

async function scalar(client, sql, values) { return (await client.query(sql, values)).rows[0].value; }
async function reserve(client, token = claimA, user = owner, id = logId) {
  return scalar(client, 'SELECT purama_ai.email_agent_send_reserve($1,$2,$3,$4) AS value', [user, id, token, approvalId]);
}
async function preview(client = coordinator) {
  const value = await scalar(client, 'SELECT purama_ai.email_agent_draft_preview($1,$2) AS value', [owner, logId]);
  assert.equal(value.status, 'ready');
  return value.approval_id;
}
async function approve(client, id) {
  return scalar(client, 'SELECT purama_ai.email_agent_draft_approve($1,$2,$3,$4) AS value', [owner, logId, id, null]);
}
async function reconcileContext() {
  return scalar(coordinator, 'SELECT purama_ai.email_agent_reconcile_context($1,$2) AS value', [owner, logId]);
}
async function reconcileFinish(client, context, snapshot, receipt = 'provider-native-fixture-1') {
  return scalar(client, 'SELECT purama_ai.email_agent_reconcile_finish($1,$2,$3,$4,$5,$6,$7,$8) AS value',
    [owner, context.action_id, context.dispatch_updated_at, snapshot.gmail_email, snapshot.stamp, receipt, 'a'.repeat(64), Date.now()]);
}
async function connectionSnapshot() {
  return (await coordinator.query('SELECT gmail_email,updated_at::text AS stamp FROM purama_ai.email_agent_config WHERE user_id=$1', [owner])).rows[0];
}
async function begin(client, actionId, snapshot, token = claimA, user = owner) {
  return scalar(client, 'SELECT purama_ai.email_agent_send_begin($1,$2,$3,$4,$5) AS value',
    [user, actionId, token, snapshot.gmail_email, snapshot.stamp]);
}
async function finish(client, actionId, outcome = 'sent', receipt = 'provider-native-fixture-1', token = claimA, user = owner) {
  return scalar(client, 'SELECT purama_ai.email_agent_send_finish($1,$2,$3,$4,$5) AS value',
    [user, actionId, token, outcome, receipt]);
}
async function counters() {
  return (await coordinator.query(`SELECT
    (SELECT count(*)::integer FROM purama_ai.email_agent_dispatches WHERE user_id=$1) AS dispatches,
    (SELECT total_auto_replied FROM purama_ai.email_agent_config WHERE user_id=$1) AS total_auto_replied,
    (SELECT count(*)::integer FROM purama_ai.email_agent_logs WHERE user_id=$1 AND action_taken='auto_reply') AS auto_reply_logs`, [owner])).rows[0];
}
async function insertLog(id = logId) {
  await coordinator.query(`INSERT INTO purama_ai.email_agent_logs
    (id,user_id,gmail_message_id,gmail_thread_id,gmail_draft_id,from_email,category,action_taken,ai_response,ai_subject,user_approved,created_at)
    VALUES($1,$2,'incoming-1','thread-1','draft-1','recipient@example.invalid','faq','draft','Approved body','Re: Approved subject',true,clock_timestamp())`, [id, owner]);
}
async function reset() {
  await coordinator.query('TRUNCATE purama_ai.email_agent_dispatches,purama_ai.email_agent_draft_previews,purama_ai.email_agent_logs,purama_ai.email_agent_config,purama_ai.email_agent_memory');
  await coordinator.query("INSERT INTO purama_ai.email_agent_config(user_id,gmail_email) VALUES($1,'owner@example.invalid'),($2,'other@example.invalid')", [owner, other]);
  await insertLog();
  approvalId = await preview();
  assert.equal((await approve(coordinator, approvalId)).status, 'approved');
}
async function waitForLock(pid) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !stopping) {
    const row = (await coordinator.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return row;
    await sleep(15);
  }
  throw new Error('Independent second PostgreSQL connection did not overlap on a real lock');
}
async function race(firstOperation, secondOperation, final = 'COMMIT') {
  assert(['COMMIT', 'ROLLBACK'].includes(final));
  let pending;
  await first.query('BEGIN');
  await first.query("SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='7s'");
  try {
    const firstResult = await firstOperation(first);
    pending = (async () => {
      await second.query('BEGIN');
      await second.query("SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='7s'");
      try {
        const result = await secondOperation(second);
        await second.query('COMMIT');
        return { ok: true, result };
      } catch (error) {
        await second.query('ROLLBACK');
        return { ok: false, code: error.code, message: error.message };
      }
    })();
    const wait = await waitForLock(second.processID);
    await first.query(final);
    const secondResult = await pending;
    assert.equal(secondResult.ok, true, JSON.stringify(secondResult));
    return { first: firstResult, second: secondResult.result, observed_lock: wait, first_transaction: final };
  } catch (error) {
    await first.query('ROLLBACK');
    if (pending) await pending;
    throw error;
  }
}
async function check(name, body) {
  if (stopping) throw new Error('Stop requested');
  await reset();
  const at = Date.now();
  try {
    const detail = await body();
    report.checks.push({ name, status: 'PASS', elapsed_ms: Date.now() - at, details: detail });
    console.log(JSON.stringify({ name, status: 'PASS' }));
  } catch (error) {
    report.checks.push({ name, status: 'FAIL', elapsed_ms: Date.now() - at, error: error.message, code: error.code });
    throw error;
  }
}

async function main() {
  assert.equal(process.getuid?.() === 0, false, 'A private PostgreSQL fixture requires a non-root user');
  for (const path of sourcePaths) {
    const bytes = await readFile(join(repo, path));
    const sha256 = hash(bytes);
    if (authorPins[path]) assert.equal(sha256, authorPins[path], `Author freeze changed: ${path}`);
    sources.set(path, bytes);
    report.sources.push({ path, sha256 });
  }
  report.harness_sha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  report.pg_module_version = require('pg/package.json').version;
  const candidates = pgBinOption ? [resolve(pgBinOption)] : [
    '/usr/lib/postgresql/18/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin',
    '/opt/homebrew/opt/postgresql@18/bin', '/opt/homebrew/opt/postgresql/bin',
  ];
  for (const candidate of candidates) {
    try {
      for (const name of ['postgres', 'initdb', 'pg_ctl', 'psql']) await access(join(candidate, name), constants.X_OK);
      bin = candidate;
      break;
    } catch { /* Installed binaries only. Never install or use an existing server. */ }
  }
  if (!bin) { report.status = 'NON_TESTE'; report.reason = 'No complete installed PostgreSQL binary set'; process.exitCode = 1; return; }
  report.postgres_bin = bin;
  report.postgres_version = (await run('postgres', ['--version'])).stdout.trim();
  cluster = await mkdtemp('/tmp/purama-gmail-native-');
  await chmod(cluster, 0o700);
  data = join(cluster, 'data');
  const port = randomInt(54000, 59000);
  report.isolation.cluster = cluster;
  report.isolation.socket_directory = cluster;
  report.isolation.port = port;
  await run('initdb', ['-D', data, '-U', 'gmail_native_test', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
  await run('pg_ctl', ['-D', data, '-l', join(cluster, 'server.log'), '-w', '-t', '15', '-o',
    `-h '' -k '${cluster}' -p ${port} -c max_connections=12 -c shared_buffers=16MB -c unix_socket_permissions=0700`, 'start'], 25000);
  started = true;
  const config = { host: cluster, port, user: 'gmail_native_test', database: 'postgres', ssl: false, connectionTimeoutMillis: 5000 };
  coordinator = new pg.Client({ ...config, application_name: 'gmail-native-coordinator' });
  first = new pg.Client({ ...config, application_name: 'gmail-native-first' });
  second = new pg.Client({ ...config, application_name: 'gmail-native-second' });
  clients.push(coordinator, first, second);
  await Promise.all(clients.map(client => client.connect()));
  const identity = (await coordinator.query("SELECT current_setting('data_directory') AS data_directory,current_setting('listen_addresses') AS listen_addresses,version() AS version")).rows[0];
  assert.equal(identity.data_directory, data);
  assert.equal(identity.listen_addresses, '');
  report.isolation.identity_verified = true;
  report.isolation.observed_listen_addresses = identity.listen_addresses;
  report.postgres_full_version = identity.version;
  report.connection_pids = clients.map(client => client.processID);
  assert.equal(new Set(report.connection_pids).size, 3);
  await coordinator.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  await coordinator.query('INSERT INTO auth.users(id) VALUES($1),($2)', [owner, other]);
  for (const path of sourcePaths.filter(path => path.endsWith('.sql'))) {
    await coordinator.query(sources.get(path).toString('utf8'));
  }
  await Promise.all([first.query('SET ROLE service_role'), second.query('SET ROLE service_role')]);

  await check('two independent concurrent reservations admit exactly one owner claim', async () => {
    const result = await race(c => reserve(c, claimA), c => reserve(c, claimB));
    assert.equal(result.first.claimed, true);
    assert.equal(result.second.claimed, false);
    assert.equal(result.first.action_id, result.second.action_id);
    assert.equal(result.first.status, 'preparing');
    const observed = await counters();
    assert.deepEqual(observed, { dispatches: 1, total_auto_replied: 0, auto_reply_logs: 0 });
    return { ...result, counters: observed };
  });
  await check('same claim has exactly one concurrent transition to sending', async () => {
    const reserved = await reserve(coordinator);
    const cfg = await connectionSnapshot();
    const result = await race(c => begin(c, reserved.action_id, cfg), c => begin(c, reserved.action_id, cfg));
    assert.equal(result.first.claimed, true);
    assert.equal(result.second.claimed, false);
    assert.equal(result.first.status, 'sending');
    assert.equal(result.second.status, 'sending');
    const observed = await counters();
    assert.deepEqual(observed, { dispatches: 1, total_auto_replied: 0, auto_reply_logs: 0 });
    return { ...result, counters: observed };
  });
  await check('concurrent completion persists one receipt and increments counters once', async () => {
    const reserved = await reserve(coordinator);
    await begin(coordinator, reserved.action_id, await connectionSnapshot());
    const result = await race(c => finish(c, reserved.action_id), c => finish(c, reserved.action_id, 'sent', 'second-receipt-must-not-replace'));
    assert.equal(result.first.status, 'sent');
    assert.equal(result.second.status, 'sent');
    assert.equal(result.second.provider_message_id, 'provider-native-fixture-1');
    const uncertain = await finish(coordinator, reserved.action_id, 'unknown', null);
    assert.equal(uncertain.status, 'sent');
    assert.equal(uncertain.provider_message_id, 'provider-native-fixture-1');
    const observed = await counters();
    assert.deepEqual(observed, { dispatches: 1, total_auto_replied: 1, auto_reply_logs: 1 });
    return { ...result, late_uncertain_completion: uncertain, counters: observed };
  });
  await check('unknown completion blocks concurrent and later reclaims including log reimport', async () => {
    const reserved = await reserve(coordinator);
    const cfg = await connectionSnapshot();
    await begin(coordinator, reserved.action_id, cfg);
    const result = await race(c => finish(c, reserved.action_id, 'unknown', null), c => reserve(c, claimB));
    assert.equal(result.first.status, 'unknown');
    assert.equal(result.second.status, 'unknown');
    assert.equal(result.second.claimed, false);
    const lateBegin = await begin(coordinator, reserved.action_id, cfg);
    assert.equal(lateBegin.status, 'unknown');
    assert.equal(lateBegin.claimed, false);
    const lateFinish = await finish(coordinator, reserved.action_id);
    assert.equal(lateFinish.status, 'unknown');
    await coordinator.query('DELETE FROM purama_ai.email_agent_logs WHERE id=$1', [logId]);
    await insertLog(replacement);
    const reimport = await reserve(coordinator, claimB, owner, replacement);
    assert.equal(reimport.status, 'unknown');
    assert.equal(reimport.action_id, reserved.action_id);
    assert.equal(reimport.claimed, false);
    const observed = await counters();
    assert.deepEqual(observed, { dispatches: 1, total_auto_replied: 0, auto_reply_logs: 0 });
    return { ...result, late_begin: lateBegin, reimport, counters: observed };
  });
  await check('rolled-back reservation leaves exactly one committed concurrent reservation', async () => {
    const result = await race(c => reserve(c, claimA), c => reserve(c, claimB), 'ROLLBACK');
    assert.equal(result.first.claimed, true);
    assert.equal(result.second.claimed, true);
    assert.notEqual(result.first.action_id, result.second.action_id);
    const ledger = (await coordinator.query('SELECT id,claim_token FROM purama_ai.email_agent_dispatches')).rows;
    assert.deepEqual(ledger, [{ id: result.second.action_id, claim_token: claimB }]);
    const observed = await counters();
    assert.deepEqual(observed, { dispatches: 1, total_auto_replied: 0, auto_reply_logs: 0 });
    return { ...result, committed_claims: 1, counters: observed };
  });
  await check('other owner and wrong token cannot reserve begin or complete the owned action', async () => {
    const otherReserve = await reserve(first, claimB, other);
    assert.equal(otherReserve.reason, 'log_not_found');
    const reserved = await reserve(first);
    const cfg = await connectionSnapshot();
    const otherBegin = await begin(second, reserved.action_id, cfg, claimA, other);
    const wrongBegin = await begin(second, reserved.action_id, cfg, claimB);
    assert.equal(otherBegin.reason, 'dispatch_not_found');
    assert.equal(wrongBegin.reason, 'claim_mismatch');
    await begin(first, reserved.action_id, cfg);
    const otherFinish = await finish(second, reserved.action_id, 'sent', 'blocked', claimA, other);
    const wrongFinish = await finish(second, reserved.action_id, 'sent', 'blocked', claimB);
    assert.equal(otherFinish.reason, 'dispatch_not_found');
    assert.equal(wrongFinish.reason, 'claim_mismatch');
    const status = (await coordinator.query('SELECT status FROM purama_ai.email_agent_dispatches')).rows[0].status;
    assert.equal(status, 'sending');
    const observed = await counters();
    assert.deepEqual(observed, { dispatches: 1, total_auto_replied: 0, auto_reply_logs: 0 });
    return { other_reserve: otherReserve, other_begin: otherBegin, wrong_begin: wrongBegin, other_finish: otherFinish, wrong_finish: wrongFinish, status, counters: observed };
  });
  await check('anonymous and authenticated roles cannot access ledger or execute service RPCs', async () => {
    const reserved = await reserve(coordinator);
    const cfg = await connectionSnapshot();
    const denied = [];
    for (const role of ['anon', 'authenticated']) {
      await coordinator.query(`SET ROLE ${role}`);
      try {
        const operations = [
          ['ledger read', () => coordinator.query('SELECT * FROM purama_ai.email_agent_dispatches')],
          ['ledger delete', () => coordinator.query('DELETE FROM purama_ai.email_agent_dispatches')],
          ['reserve', () => reserve(coordinator)],
          ['begin', () => begin(coordinator, reserved.action_id, cfg)],
          ['finish', () => finish(coordinator, reserved.action_id)],
          ['preview read', () => coordinator.query('SELECT * FROM purama_ai.email_agent_draft_previews')],
          ['preview', () => preview(coordinator)],
          ['approve', () => approve(coordinator, approvalId)],
          ['reconcile context', () => reconcileContext()],
          ['reconcile finish', () => reconcileFinish(coordinator,
            { action_id: reserved.action_id, dispatch_updated_at: new Date().toISOString() }, cfg)],
        ];
        for (const [operation, call] of operations) {
          let code;
          try { await call(); } catch (error) { code = error.code; }
          assert.equal(code, '42501', `${role} ${operation} must be permission denied`);
          denied.push({ role, operation, code });
        }
      } finally { await coordinator.query('RESET ROLE'); }
    }
    return { denied, counters: await counters() };
  });
  await check('expired reservation is never automatically reclaimed by another token', async () => {
    const reserved = await reserve(first);
    await coordinator.query("UPDATE purama_ai.email_agent_dispatches SET lease_until=clock_timestamp()-interval '1 second'");
    const again = await reserve(second, claimB);
    assert.equal(again.claimed, false);
    assert.equal(again.action_id, reserved.action_id);
    const blocked = await begin(first, reserved.action_id, await connectionSnapshot());
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.reason, 'claim_expired');
    assert.equal((await reserve(second, claimB)).claimed, false);
    const observed = await counters();
    assert.deepEqual(observed, { dispatches: 1, total_auto_replied: 0, auto_reply_logs: 0 });
    return { prior_reservation: again, begin: blocked, counters: observed };
  });
  await check('the previous unversioned contract cannot reserve and private internals stay inaccessible', async () => {
    const result = await scalar(first, 'SELECT purama_ai.email_agent_send_reserve($1,$2,$3) AS value', [owner, logId, claimA]);
    assert.equal(result.claimed, false);
    assert.equal(result.reason, 'versioned_approval_required');
    let code;
    try { await scalar(first, 'SELECT purama_ai.email_agent_send_reserve_unversioned_internal($1,$2,$3) AS value', [owner, logId, claimA]); }
    catch (error) { code = error.code; }
    assert.equal(code, '42501');
    assert.equal((await counters()).dispatches, 0);
    return { result, private_internal_denial: code };
  });
  await check('concurrent approval binds one immutable preview without sending', async () => {
    const id = await preview();
    const result = await race(c => approve(c, id), c => approve(c, id));
    assert.equal(result.first.status, 'approved');
    assert.equal(result.second.status, 'approved');
    const binding = (await coordinator.query(`SELECT l.feedback_at=p.approved_at AS exact_binding
      FROM purama_ai.email_agent_logs l JOIN purama_ai.email_agent_draft_previews p ON p.log_id=l.id WHERE p.id=$1`, [id])).rows[0];
    assert.equal(binding.exact_binding, true);
    assert.equal((await counters()).dispatches, 0);
    return { ...result, binding };
  });
  await check('a changed preview and an expired approval cannot cross the send boundary', async () => {
    await coordinator.query("UPDATE purama_ai.email_agent_logs SET ai_response='changed after approval' WHERE id=$1", [logId]);
    const stale = await reserve(first);
    assert.equal(stale.claimed, false);
    assert.equal((await counters()).dispatches, 0);
    approvalId = await preview();
    assert.equal((await approve(coordinator, approvalId)).status, 'approved');
    const reserved = await reserve(first);
    assert.equal(reserved.claimed, true);
    await coordinator.query("UPDATE purama_ai.email_agent_draft_previews SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [approvalId]);
    const blocked = await begin(first, reserved.action_id, await connectionSnapshot());
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.reason, 'versioned_approval_changed');
    assert.deepEqual(await counters(), { dispatches: 1, total_auto_replied: 0, auto_reply_logs: 0 });
    return { stale, expired: blocked };
  });
  await check('two native reconciliation sessions persist one receipt and one counter increment', async () => {
    const reserved = await reserve(coordinator);
    await begin(coordinator, reserved.action_id, await connectionSnapshot());
    await finish(coordinator, reserved.action_id, 'unknown');
    const context = await reconcileContext(), cfg = await connectionSnapshot();
    assert.equal(context.eligible, true);
    const result = await race(c => reconcileFinish(c, context, cfg), c => reconcileFinish(c, context, cfg));
    assert.equal(result.first.status, 'sent');
    assert.equal(result.second.status, 'sent');
    assert.equal(result.first.matches_current_preview, true);
    assert.deepEqual(await counters(), { dispatches: 1, total_auto_replied: 1, auto_reply_logs: 1 });
    const proof = (await coordinator.query('SELECT reconciliation_proof FROM purama_ai.email_agent_dispatches WHERE id=$1', [reserved.action_id])).rows[0];
    assert.equal(proof.reconciliation_proof.source, 'gmail_messages_get');
    return { ...result, proof, counters: await counters() };
  });
  await check('an A to B to A Gmail reconnection invalidates the reserved preview version', async () => {
    const reserved = await reserve(coordinator), previous = await connectionSnapshot();
    assert.equal(reserved.claimed, true);
    await coordinator.query("UPDATE purama_ai.email_agent_config SET gmail_email='replacement@example.invalid' WHERE user_id=$1", [owner]);
    await coordinator.query("UPDATE purama_ai.email_agent_config SET gmail_email='owner@example.invalid' WHERE user_id=$1", [owner]);
    const current = await connectionSnapshot();
    assert.notEqual(current.stamp, previous.stamp);
    const blocked = await begin(first, reserved.action_id, current);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.reason, 'gmail_connection_changed');
    assert.equal(blocked.claimed, false);
    assert.deepEqual(await counters(), { dispatches: 1, total_auto_replied: 0, auto_reply_logs: 0 });
    return { blocked, previous_version: previous.stamp, current_version: current.stamp };
  });
  await check('sender completion racing reconciliation cannot double the receipt or counter', async () => {
    const reserved = await reserve(coordinator);
    await begin(coordinator, reserved.action_id, await connectionSnapshot());
    await coordinator.query("UPDATE purama_ai.email_agent_dispatches SET dispatch_started_at=clock_timestamp()-interval '3 minutes' WHERE id=$1", [reserved.action_id]);
    const context = await reconcileContext(), cfg = await connectionSnapshot();
    assert.equal(context.eligible, true);
    const result = await race(c => reconcileFinish(c, context, cfg), c => finish(c, reserved.action_id));
    assert.equal(result.first.status, 'sent');
    assert.equal(result.second.status, 'sent');
    assert.deepEqual(await counters(), { dispatches: 1, total_auto_replied: 1, auto_reply_logs: 1 });
    return { ...result, counters: await counters() };
  });
  await check('reconciliation preserves a later refusal and its timestamp without a body edit', async () => {
    const reserved = await reserve(coordinator);
    await begin(coordinator, reserved.action_id, await connectionSnapshot());
    await finish(coordinator, reserved.action_id, 'unknown');
    const context = await reconcileContext(), cfg = await connectionSnapshot();
    await coordinator.query(`UPDATE purama_ai.email_agent_logs SET user_approved=false,
      user_feedback='Do not approve a retry',feedback_at='2026-11-22T01:23:45.123Z' WHERE id=$1`, [logId]);
    const result = await reconcileFinish(first, context, cfg);
    assert.equal(result.status, 'sent');
    assert.equal(result.matches_current_preview, true);
    const item = (await coordinator.query(`SELECT user_approved,user_feedback,
      feedback_at='2026-11-22T01:23:45.123Z'::timestamptz AS exact_timestamp
      FROM purama_ai.email_agent_logs WHERE id=$1`, [logId])).rows[0];
    assert.deepEqual(item, { user_approved: false, user_feedback: 'Do not approve a retry', exact_timestamp: true });
    assert.deepEqual(await counters(), { dispatches: 1, total_auto_replied: 1, auto_reply_logs: 1 });
    return { result, item };
  });
  await check('reconciliation preserves a later edit and never approves the new draft', async () => {
    const reserved = await reserve(coordinator);
    await begin(coordinator, reserved.action_id, await connectionSnapshot());
    await finish(coordinator, reserved.action_id, 'unknown');
    const context = await reconcileContext(), cfg = await connectionSnapshot();
    await coordinator.query("UPDATE purama_ai.email_agent_logs SET ai_response='new draft',user_approved=false WHERE id=$1", [logId]);
    const result = await reconcileFinish(first, context, cfg);
    assert.equal(result.status, 'sent');
    assert.equal(result.matches_current_preview, false);
    const item = (await coordinator.query('SELECT ai_response,action_taken,user_approved FROM purama_ai.email_agent_logs WHERE id=$1', [logId])).rows[0];
    assert.deepEqual(item, { ai_response: 'new draft', action_taken: 'draft', user_approved: false });
    assert.deepEqual(await counters(), { dispatches: 1, total_auto_replied: 1, auto_reply_logs: 0 });
    return { result, item };
  });
  for (const source of report.sources) assert.equal(hash(await readFile(join(repo, source.path))), source.sha256, `Source changed during native run: ${source.path}`);
  report.sources_unchanged_after = true;
  report.status = 'PASS';
}

try { await main(); }
catch (error) {
  report.status = /operation not permitted|permission denied/i.test(String(error.stderr ?? error.message)) && !started ? 'BLOQUE' : 'FAIL';
  report.error = String(error.message).slice(0, 2000);
  if (error.stderr) report.stderr = String(error.stderr).slice(-3000);
  process.exitCode = 1;
  if (cluster) {
    try { report.private_server_log_tail = (await readFile(join(cluster, 'server.log'), 'utf8')).slice(-4000); } catch {}
  }
  if (!started && /operation not permitted|permission denied/i.test(report.private_server_log_tail ?? '')) {
    report.status = 'BLOQUE';
    report.blocker = 'Native Unix-socket creation denied; no retry, escalation, TCP fallback, or alternate tool';
  }
} finally {
  await Promise.allSettled(clients.map(client => client.end()));
  if (cluster) {
    try {
      let hasPid = false;
      try { await access(join(data, 'postmaster.pid')); hasPid = true; } catch {}
      if (hasPid) {
        await run('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '15', 'stop'], 20000);
        report.cleanup.stop_exit_code = 0;
      }
      let statusExit;
      try { await run('pg_ctl', ['-D', data, 'status'], 5000); statusExit = 0; }
      catch (error) { statusExit = error.code; }
      assert.equal(statusExit, 3, 'Native server must be confirmed stopped before deleting owned fixture');
      report.cleanup.status_exit_code = statusExit;
      report.cleanup.server_stopped = true;
      assert(cluster.startsWith('/tmp/purama-gmail-native-'));
      await rm(cluster, { recursive: true, force: false });
      report.cleanup.owned_cluster_removed = true;
    } catch (error) {
      report.cleanup.error = error.message;
      report.status = 'FAIL';
      process.exitCode = 1;
    }
  }
  report.finished_at = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, cleanup: report.cleanup, output }));
}
