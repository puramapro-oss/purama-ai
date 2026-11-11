/**
 * Real BullMQ/Redis + native PostgreSQL qualification of the approval relay.
 * The SQL transport replaces PostgREST, not the SQL functions or database.
 * Consumers below are inert fixtures. No business provider is called.
 */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repo = process.env.NATIVE_REPO;
const output = process.env.NATIVE_OUTPUT;
const pgBin = process.env.NATIVE_PG_BIN;
const pgData = process.env.NATIVE_PG_DATA;
const pgSocket = process.env.NATIVE_PG_SOCKET;
const redisBinary = process.env.NATIVE_REDIS_SERVER;
for (const value of [repo, output, pgBin, pgData, pgSocket, redisBinary]) assert.ok(value);
const require = createRequire(path.join(repo, "karta/package.json"));
const { Queue, Worker } = require("bullmq");
const { Redis } = require("ioredis");
const owner = "00000000-0000-4000-8000-000000000701";
const parent = "00000000-0000-4000-8000-000000000702";
const action = "00000000-0000-4000-8000-000000000703";
const childRun = "00000000-0000-4000-8000-000000000704";
const privateSentinel = "INERT_NATIVE_PRIVATE_SENTINEL";
const concurrencyTag = "native-outbox-" + randomUUID();
const redisRoot = await mkdtemp(path.join(tmpdir(), "karta-native-redis-"));
const redisSocket = path.join(redisRoot, "redis.sock");
const redisConfig = path.join(redisRoot, "redis.conf");
const report = {
  scope: "Native PostgreSQL18 + real Redis/BullMQ relay protocol; inert consumers; no PostgREST/provider/deployment qualification",
  startedAt: new Date().toISOString(),
  checks: [], rpcCalls: [], redisStarts: [], unexpectedHttpCalls: 0,
  fixtureAdjustments: "Only next_attempt_at is advanced between attempts to avoid ten-second backoff; production functions and identity rules are unchanged",
  cleanup: {}, success: false,
};
let redisProcess;
let sharedQueue;
let sharedRedis;
let drainApprovalOutboxOnce;
let resolveCycleDelivery;
let transportErrors = 0;
const ownedQueues = new Set();
const ownedWorkers = new Set();
let currentCheck = "bootstrap";
globalThis.fetch = () => {
  report.unexpectedHttpCalls += 1;
  throw new Error("Unexpected HTTP call in the native fixture");
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const sqlArgv = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", pgSocket, "-p", "55497", "-U", "fixture", "postgres"];

async function sql(statement, { signal, timeout = 4000 } = {}) {
  const { stdout } = await exec(path.join(pgBin, "psql"), [...sqlArgv, "-c", statement], {
    signal, timeout, maxBuffer: 65536, encoding: "utf8",
  });
  return stdout.trim();
}

async function jsonSql(statement, options) {
  const text = await sql(statement, options);
  const line = text.split("\n").find((entry) => entry.startsWith("{"));
  assert.ok(line, "Native query returned no JSON object");
  return JSON.parse(line);
}

async function rpc(name, params, signal, holdClaim = false) {
  const started = performance.now();
  let expression;
  if (name === "karta_claim_approval_outbox") {
    assert.equal(params.p_limit, 5);
    expression = "SELECT json_build_object('backendPid',pg_backend_pid(),'data',coalesce(json_agg(v),'[]'::json)) FROM purama_ai.karta_claim_approval_outbox(5) v";
  } else if (name === "karta_prepare_approval_outbox") {
    const args = [params.p_id, params.p_lease, params.p_execution_key, params.p_fingerprint, params.p_legacy_prefix].map(literal);
    expression = "SELECT json_build_object('backendPid',pg_backend_pid(),'data',purama_ai.karta_prepare_approval_outbox(" + args.join(",") + "))";
  } else if (name === "karta_finish_approval_outbox") {
    const args = [params.p_id, params.p_lease, params.p_result].map(literal);
    expression = "SELECT json_build_object('backendPid',pg_backend_pid(),'data',purama_ai.karta_finish_approval_outbox(" + args.join(",") + "))";
  } else {
    throw new Error("Unexpected RPC name: " + name);
  }
  const heldClaim = holdClaim && name === "karta_claim_approval_outbox";
  const transaction = "BEGIN; SET LOCAL ROLE service_role; SET LOCAL statement_timeout='1800ms'; "
    + (heldClaim ? "SET LOCAL application_name=" + literal(concurrencyTag) + ";" : "") + expression + ";"
    + (heldClaim ? "SELECT pg_sleep(0.6);" : "") + "COMMIT;";
  try {
    const result = await jsonSql(transaction, { signal, timeout: 2400 });
    report.rpcCalls.push({ check: currentCheck, name, backendPid: result.backendPid,
      elapsedMs: Math.round(performance.now() - started), returnedRows: Array.isArray(result.data) ? result.data.length : undefined });
    return { data: result.data, error: null };
  } catch (error) {
    report.rpcCalls.push({ check: currentCheck, name, elapsedMs: Math.round(performance.now() - started), error: error.name });
    return { data: null, error: { message: "Native SQL transport unavailable" } };
  }
}

await writeFile(redisConfig, [
  "port 0", "protected-mode yes", "unixsocket " + redisSocket, "unixsocketperm 700",
  "daemonize no", "dir " + redisRoot, "logfile " + path.join(redisRoot, "redis.log"),
  "save \"\"", "appendonly yes", "appendfsync always", "maxmemory 64mb", "maxmemory-policy noeviction", "databases 1",
].join("\n") + "\n", { mode: 0o600 });

async function startRedis() {
  assert.ok(!redisProcess || redisProcess.exitCode !== null || redisProcess.signalCode !== null);
  redisProcess = spawn(redisBinary, [redisConfig], { stdio: "ignore" });
  const pid = redisProcess.pid;
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    assert.equal(redisProcess.exitCode, null, "Owned Redis process exited during startup");
    try {
      const client = new Redis({ path: redisSocket, lazyConnect: true, retryStrategy: null, connectTimeout: 200 });
      client.on("error", () => {});
      try {
        await client.connect();
        assert.equal(await client.ping(), "PONG");
        const [portKey, portValue] = await client.config("GET", "port");
        assert.deepEqual([portKey, portValue], ["port", "0"]);
        const info = await client.info("server");
        report.redisStarts.push({ pid, version: info.match(/redis_version:([^\r\n]+)/)?.[1], port: 0,
          socketMode: (await stat(redisSocket)).mode & 0o777, at: new Date().toISOString() });
        assert.equal((await stat(redisSocket)).mode & 0o777, 0o700);
        return;
      } finally { client.disconnect(); }
    } catch { await sleep(30); }
  }
  throw new Error("Owned Redis did not become ready within five seconds");
}

async function stopRedis(signal = "SIGTERM") {
  if (!redisProcess || redisProcess.exitCode !== null || redisProcess.signalCode !== null) return;
  const stopped = once(redisProcess, "exit");
  assert.ok(redisProcess.kill(signal), "Could not signal owned Redis");
  await Promise.race([stopped, sleep(3500).then(() => { throw new Error("Owned Redis did not stop"); })]);
}

async function createQueue(name) {
  const connection = new Redis({ path: redisSocket, lazyConnect: true, enableOfflineQueue: false,
    maxRetriesPerRequest: 1, commandTimeout: 600, connectTimeout: 600, retryStrategy: () => 50 });
  connection.on("error", () => { transportErrors += 1; });
  const record = { queue: null, connection, name };
  ownedQueues.add(record);
  await connection.connect();
  const queue = new Queue("native-outbox-" + name, { connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: false, removeOnFail: false } });
  record.queue = queue;
  queue.on("error", () => { transportErrors += 1; });
  await queue.waitUntilReady();
  return record;
}

async function closeQueue(record) {
  try { await record.queue?.close(); } finally { record.connection.disconnect(); ownedQueues.delete(record); }
}

async function waitForConnection(connection) {
  const deadline = performance.now() + 3000;
  while (connection.status !== "ready" && performance.now() < deadline) await sleep(25);
  assert.equal(connection.status, "ready", "Owned Redis connection did not reconnect");
  assert.equal(await connection.ping(), "PONG");
}

async function seed() {
  const tools = JSON.stringify([{ tool: "inert", pendingActionId: action, success: false, outcome: "pending" }]);
  await sql("TRUNCATE auth.users CASCADE; INSERT INTO auth.users(id) VALUES(" + literal(owner) + ");"
    + "INSERT INTO purama_ai.karta_global_state(id,kill_switch) VALUES('global',false) ON CONFLICT(id) DO UPDATE SET kill_switch=false;"
    + "INSERT INTO purama_ai.karta_agent_state(user_id,agent_type,simulation_mode) VALUES(" + literal(owner) + ",'legal',false);"
    + "INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode,status,duration_ms,tools_used) VALUES("
    + [parent, owner, "legal", "manual", "live", "awaiting_approval"].map(literal).join(",") + ",1," + literal(tools) + ");"
    + "INSERT INTO purama_ai.karta_pending_actions(id,user_id,run_id,agent_type,tool_name,tool_params) VALUES("
    + [action, owner, parent, "legal", "inert", JSON.stringify({ private: privateSentinel })].map(literal).join(",") + ");"
    + "SET ROLE service_role; SELECT purama_ai.karta_claim_pending_action_bounded(" + literal(action) + ",'approve');"
    + "SELECT purama_ai.karta_finalize_pending_action(" + literal(action) + ",'executed','INERT_RESULT');");
  return jsonSql("SELECT json_build_object('action',row_to_json(a),'parent',row_to_json(r)) FROM purama_ai.karta_pending_actions a JOIN purama_ai.karta_runs r ON r.id=a.run_id");
}

async function originalApprovalIsUnchanged(before) {
  const reclaimed = await sql("SET ROLE service_role; SELECT purama_ai.karta_claim_pending_action_bounded(" + literal(action) + ",'approve')");
  assert.equal(reclaimed, "[]", "Finalized original approval became claimable again");
  const after = await jsonSql("SELECT json_build_object('action',row_to_json(a),'parent',row_to_json(r)) FROM purama_ai.karta_pending_actions a JOIN purama_ai.karta_runs r ON r.id=a.run_id");
  assert.deepEqual(after, before, "Relay changed the original finalized action or parent journal");
}

async function outbox() {
  return jsonSql("SELECT row_to_json(o) FROM purama_ai.karta_approval_outbox o");
}

async function due() {
  await sql("UPDATE purama_ai.karta_approval_outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE status='pending'");
}

async function onlyStoredJob(queue) {
  const jobs = await queue.getJobs(["wait", "active", "delayed", "completed", "failed"], 0, -1);
  assert.equal(jobs.length, 1, "Expected exactly one retained job in the real Redis queue");
  assert.equal(JSON.stringify(jobs[0].data).includes(privateSentinel), false, "Private pending-action data leaked to Redis");
  return jobs[0];
}

async function consume(record, mode) {
  const worker = new Worker(record.queue.name, async (job) => {
    if (mode === "sql-error") {
      const identity = resolveCycleDelivery(job);
      await sql("SET ROLE service_role; INSERT INTO purama_ai.karta_runs"
        + "(id,user_id,agent_type,trigger_type,mode,status,duration_ms,execution_key,execution_fingerprint,finished_at) VALUES("
        + [childRun, owner, "legal", "delegation", "live", "error"].map(literal).join(",")
        + ",1," + literal(identity.executionKey) + "," + literal(identity.fingerprint) + ",now())");
      throw new Error("Inert business failure after durable receipt");
    }
    if (mode === "failed") throw new Error("Inert failure without a SQL receipt");
    return { fixtureOnly: true };
  }, { connection: { path: redisSocket, maxRetriesPerRequest: null }, autorun: false, concurrency: 1 });
  worker.on("error", () => { transportErrors += 1; });
  ownedWorkers.add(worker);
  const event = mode === "completed" ? "completed" : "failed";
  const terminal = once(worker, event);
  const run = worker.run();
  try {
    await Promise.race([terminal, sleep(5000).then(() => { throw new Error("Inert consumer did not reach terminal state"); })]);
  } finally {
    await worker.close();
    await run;
    ownedWorkers.delete(worker);
  }
}

async function check(name, execute) {
  currentCheck = name;
  const started = performance.now();
  try {
    const evidence = await execute();
    report.checks.push({ name, status: "PASS", elapsedMs: Math.round(performance.now() - started), evidence });
  } catch (error) {
    report.checks.push({ name, status: "FAIL", elapsedMs: Math.round(performance.now() - started), error: String(error.stack || error).slice(0,5000) });
    throw error;
  }
}

try {
  await startRedis();
  process.env.REDIS_URL = redisSocket;
  ({ drainApprovalOutboxOnce } = await import(pathToFileURL(path.join(repo, "karta/src/queue/approval-outbox.ts"))));
  ({ resolveCycleDelivery } = await import(pathToFileURL(path.join(repo, "karta/src/queue/delivery-identity.ts"))));
  ({ agentCycleQueue: sharedQueue } = await import(pathToFileURL(path.join(repo, "karta/src/queue/queues.ts"))));
  ({ redisConnection: sharedRedis } = await import(pathToFileURL(path.join(repo, "karta/src/queue/redis.ts"))));
  sharedQueue.on("error", () => { transportErrors += 1; });
  sharedRedis.on("error", () => { transportErrors += 1; });
  await sharedQueue.waitUntilReady();
  report.dependencies = { bullmq: require("bullmq/package.json").version, ioredis: require("ioredis/package.json").version, node: process.version };
  const drain = (queue, options = {}) => drainApprovalOutboxOnce({ queue, rpc, timeoutMs: 800, ...options });

  await check("redis_unavailable_then_recovered_original_approval_not_reclaimable", async () => {
    const original = await seed();
    const q = await createQueue("outage");
    await stopRedis();
    const first = await drain(q.queue);
    assert.deepEqual(first, { claimed: 1, published: 0, received: 0, blocked: 0, retry: 1 });
    const failed = await outbox();
    assert.equal(failed.status, "pending");
    assert.equal(failed.published_at, null);
    await originalApprovalIsUnchanged(original);
    await startRedis();
    await waitForConnection(q.connection);
    await due();
    const recovered = await drain(q.queue);
    assert.equal(recovered.published, 1);
    const job = await onlyStoredJob(q.queue);
    await originalApprovalIsUnchanged(original);
    await closeQueue(q);
    return { first, recovered, jobId: job.id, originalApprovalStillExecuted: true, originalApprovalReclaim: "[]" };
  });

  await check("lost_ack_after_real_redis_commit_recovers_without_duplicate", async () => {
    const original = await seed();
    let q = await createQueue("lost-ack");
    let writes = 0;
    const first = await drain({
      getJob: (id) => q.queue.getJob(id),
      add: async (...args) => { writes += 1; await q.queue.add(...args); throw new Error("Injected lost ACK after Redis commit"); },
    });
    assert.equal(first.retry, 1);
    const retained = await onlyStoredJob(q.queue);
    const identity = resolveCycleDelivery(retained);
    const before = await outbox();
    assert.equal(before.published_at, null);
    assert.equal(before.execution_key, identity.executionKey);
    await closeQueue(q);
    await stopRedis("SIGKILL");
    await startRedis();
    q = await createQueue("lost-ack");
    await due();
    const recovered = await drain(q.queue);
    assert.equal(recovered.published, 1);
    const after = await onlyStoredJob(q.queue);
    assert.equal(after.id, retained.id);
    assert.deepEqual(after.data, retained.data);
    assert.equal(after.timestamp, retained.timestamp);
    await originalApprovalIsUnchanged(original);
    await closeQueue(q);
    return { first, recovered, actualPublishBeforeLostAck: writes, retainedJobId: after.id, retainedTimestamp: after.timestamp, redisCrashRestart: true, jobCount: 1 };
  });

  await check("two_native_sql_leases_publish_one_job", async () => {
    const original = await seed();
    const q = await createQueue("concurrent");
    const startAt = report.rpcCalls.length;
    const pending = Promise.all([1,2].map(() => drain(q.queue, {
      rpc: (name, params, signal) => rpc(name, params, signal, true), timeoutMs: 1800,
    })));
    const observed = [];
    const deadline = performance.now() + 1500;
    while (performance.now() < deadline) {
      const snapshot = await jsonSql("SELECT json_build_object('sleeping',count(*),'pids',coalesce(json_agg(pid),'[]'::json))"
        + " FROM pg_stat_activity WHERE application_name=" + literal(concurrencyTag) + " AND state='active' AND wait_event='PgSleep'");
      snapshot.observedAt = new Date().toISOString();
      observed.push(snapshot);
      if (snapshot.sleeping === 2) break;
      await sleep(15);
    }
    const results = await pending;
    const overlap = observed.find((snapshot) => snapshot.sleeping === 2);
    assert.ok(overlap, "Two claim transactions were not observed overlapping before COMMIT");
    assert.deepEqual(results.map((r) => r.claimed).sort(), [0, 1]);
    assert.equal(results.reduce((sum, r) => sum + r.published, 0), 1);
    const claims = report.rpcCalls.slice(startAt).filter((r) => r.name === "karta_claim_approval_outbox");
    assert.equal(new Set(claims.map((r) => r.backendPid)).size, 2);
    const job = await onlyStoredJob(q.queue);
    const row = await outbox();
    assert.equal(row.attempts, 1);
    await originalApprovalIsUnchanged(original);
    await closeQueue(q);
    assert.deepEqual([...overlap.pids].sort(), claims.map((r) => r.backendPid).sort());
    return { results, claimBackendPids: claims.map((r) => r.backendPid), activeTransactionsObservedBeforeCommit: overlap,
      attempts: row.attempts, jobId: job.id };
  });

  await check("retained_terminal_jobs_without_sql_receipt_remain_blocked", async () => {
    const results = [];
    for (const mode of ["completed", "failed"]) {
      const original = await seed();
      const q = await createQueue("terminal-" + mode);
      assert.equal((await drain(q.queue)).published, 1);
      const job = await onlyStoredJob(q.queue);
      await consume(q, mode);
      assert.equal(await job.getState(), mode);
      await due();
      const blocked = await drain(q.queue);
      assert.equal(blocked.blocked, 1);
      const row = await outbox();
      assert.equal(row.status, "blocked");
      assert.equal(row.blocked_code, "retained_terminal");
      assert.equal(row.received_at, null);
      assert.equal((await onlyStoredJob(q.queue)).id, job.id);
      assert.equal(await job.getState(), mode);
      await originalApprovalIsUnchanged(original);
      await closeQueue(q);
      results.push({ terminalState: mode, result: blocked, blockedCode: row.blocked_code, jobRetained: true });
    }
    return results;
  });

  await check("sql_receipt_for_failed_business_run_is_received_not_success", async () => {
    const original = await seed();
    const q = await createQueue("business-error");
    assert.equal((await drain(q.queue)).published, 1);
    await consume(q, "sql-error");
    const job = await onlyStoredJob(q.queue);
    assert.equal(await job.getState(), "failed");
    await due();
    const result = await drain(q.queue);
    assert.deepEqual(result, { claimed: 1, published: 0, received: 1, blocked: 0, retry: 0 });
    const row = await outbox();
    assert.equal(row.status, "received");
    assert.equal(row.received_run_id, childRun);
    const status = await sql("SELECT status FROM purama_ai.karta_runs WHERE id=" + literal(childRun));
    assert.equal(status, "error");
    await originalApprovalIsUnchanged(original);
    await closeQueue(q);
    return { result, deliveryStatus: row.status, businessStatus: status, queueStatus: "failed", receivedRunId: childRun };
  });

  await check("postgres_and_redis_restart_after_publication_preserve_identity", async () => {
    const original = await seed();
    let q = await createQueue("restart");
    assert.equal((await drain(q.queue)).published, 1);
    const beforeRow = await outbox();
    const beforeJob = await onlyStoredJob(q.queue);
    await closeQueue(q);
    await stopRedis("SIGKILL");
    await exec(path.join(pgBin, "pg_ctl"), ["-D", pgData, "-m", "immediate", "-w", "stop"], { timeout: 10000 });
    await exec(path.join(pgBin, "pg_ctl"), ["-D", pgData, "-l", path.join(path.dirname(pgData), "postgres.log"), "-w", "start"], { timeout: 10000 });
    await startRedis();
    q = await createQueue("restart");
    assert.deepEqual(await outbox(), beforeRow);
    const durableJob = await onlyStoredJob(q.queue);
    assert.equal(durableJob.id, beforeJob.id);
    assert.deepEqual(durableJob.data, beforeJob.data);
    assert.equal(durableJob.timestamp, beforeJob.timestamp);
    await due();
    const result = await drain(q.queue);
    assert.equal(result.published, 1);
    assert.equal((await onlyStoredJob(q.queue)).id, beforeJob.id);
    await originalApprovalIsUnchanged(original);
    await closeQueue(q);
    return { result, postgresImmediateRestart: true, redisCrashRestart: true, sameDurableIntent: true, jobId: durableJob.id, jobCount: 1 };
  });
  assert.equal(report.unexpectedHttpCalls, 0);
} catch (error) {
  report.failure = String(error.stack || error).slice(0,8000);
} finally {
  for (const worker of ownedWorkers) { try { await worker.close(true); } catch {} }
  for (const record of ownedQueues) { try { await closeQueue(record); } catch { record.connection.disconnect(); } }
  try { await sharedQueue?.close(); } catch {}
  sharedRedis?.disconnect();
  try { await stopRedis(); report.cleanup.redisStopped = true; } catch (error) { report.cleanup.redisStopped = false; report.cleanup.error = String(error); }
  try { await writeFile(path.join(output, "redis.log"), await readFile(path.join(redisRoot, "redis.log"))); } catch {}
  report.cleanup.redisFixturePath = redisRoot;
  report.cleanup.redisFixtureRetained = true;
  report.redisTransportErrorsDuringFaults = transportErrors;
  report.finishedAt = new Date().toISOString();
  report.success = report.checks.length === 6 && report.checks.every((r) => r.status === "PASS")
    && report.cleanup.redisStopped && report.unexpectedHttpCalls === 0;
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "native-protocol-results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ success: report.success, checks: report.checks.map(({ name, status }) => ({ name, status })), cleanup: report.cleanup }));
  process.exitCode = report.success ? 0 : 1;
}
