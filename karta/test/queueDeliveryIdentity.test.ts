import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { AgentDefinition, AgentRunResult, AgentState, AgentType } from "../src/engine/types.js";
import type { AgentCycleJobData } from "../src/queue/queues.js";

/**
 * Real enqueue -> worker -> cycle -> logger, with the production SQL migrations
 * executed by PGlite. The transport, model and business effect are inert. This
 * proves the delivery contract, not Redis/Supabase/provider live integration.
 */
type Row = Record<string, unknown>;
type QueryResult = { data: Row | Row[] | null; error: { message: string; code?: string } | null };
type TestJob = { id: string; name: string; timestamp: number; data: AgentCycleJobData; attemptsMade: number };
type Processor = (job: TestJob) => Promise<AgentRunResult>;
const h = vi.hoisted(() => ({
  db: null as PGlite | null,
  jobs: new Map<string, TestJob>(),
  processor: undefined as Processor | undefined,
  clock: 1_000,
  addCount: 0,
  failRead: false,
  failJobRead: false,
  beforeInsert: undefined as (() => Promise<void>) | undefined,
  beforeAdd: undefined as (() => Promise<void>) | undefined,
  execute: vi.fn(), context: vi.fn(), decide: vi.fn(),
}));

function database(): PGlite {
  if (!h.db) throw new Error("Test database not initialized");
  return h.db;
}

// Translate the Supabase chain to real PostgreSQL. Unique claims and predicates
// are evaluated by PostgreSQL; the adapter does not imitate their outcomes.
function query(table: string) {
  if (table !== "karta_runs") throw new Error(`Unexpected table ${table}`);
  let insertion: Row | undefined;
  let patch: Row | undefined;
  let shape: "many" | "one" | "maybe" = "many";
  let limit: number | undefined;
  const filters: Array<{ key: string; value: unknown; operator: "=" | "LIKE" | "IS NULL" }> = [];
  const identifier = (value: string) => {
    if (!/^[a-z_]+$/.test(value)) throw new Error("Invalid test identifier");
    return `"${value}"`;
  };
  const execute = async (): Promise<QueryResult> => {
    const values: unknown[] = [];
    const bind = (value: unknown) => {
      values.push(value && typeof value === "object" ? JSON.stringify(value) : value);
      return `$${values.length}`;
    };
    const where = () => filters.map(filter => filter.operator === "IS NULL"
      ? `${identifier(filter.key)} IS NULL`
      : `${identifier(filter.key)} ${filter.operator} ${bind(filter.value)}`).join(" AND ") || "TRUE";
    try {
      let sql: string;
      if (insertion) {
        await h.beforeInsert?.();
        const entries = Object.entries(insertion);
        sql = `INSERT INTO purama_ai.karta_runs (${entries.map(([key]) => identifier(key)).join(",")}) VALUES (${entries.map(([, value]) => bind(value)).join(",")}) RETURNING *`;
      } else if (patch) {
        const assignments = Object.entries(patch).map(([key, value]) => `${identifier(key)} = ${bind(value)}`);
        sql = `UPDATE purama_ai.karta_runs SET ${assignments.join(",")} WHERE ${where()} RETURNING *`;
      } else {
        if (h.failRead) return { data: null, error: { message: "PRIVATE_DATABASE_PROBE" } };
        sql = `SELECT * FROM purama_ai.karta_runs WHERE ${where()}${limit === undefined ? "" : ` LIMIT ${limit}`}`;
      }
      const result = await database().query<Row>(sql, values);
      if (shape === "many") return { data: result.rows, error: null };
      if (result.rows.length > 1 || (shape === "one" && result.rows.length !== 1)) {
        return { data: null, error: { code: "PGRST116", message: "Unexpected result cardinality" } };
      }
      return { data: result.rows[0] ?? null, error: null };
    } catch (error) {
      return { data: null, error: {
        message: "PostgreSQL rejected the operation",
        code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined,
      } };
    }
  };
  const q = {
    insert(value: Row) { insertion = value; return q; },
    update(value: Row) { patch = value; return q; },
    select() { return q; },
    eq(key: string, value: unknown) { filters.push({ key, value, operator: "=" }); return q; },
    like(key: string, value: string) { filters.push({ key, value, operator: "LIKE" }); return q; },
    is(key: string, value: unknown) {
      if (value !== null) throw new Error("Only IS NULL is used by this fixture");
      filters.push({ key, value, operator: "IS NULL" }); return q;
    },
    limit(value: number) { limit = value; return q; },
    single() { shape = "one"; return execute(); },
    maybeSingle() { shape = "maybe"; return execute(); },
    then: ((resolve, reject) => execute().then(resolve, reject)) as PromiseLike<QueryResult>["then"],
  };
  return q;
}

vi.mock("../src/db/supabase.js", () => ({ supabase: { from: (table: string) => query(table) } }));
vi.mock("../src/queue/redis.js", () => ({ redisConnection: {} }));
vi.mock("bullmq", () => ({
  Queue: class {
    async add(name: string, data: AgentCycleJobData, options: { jobId: string }): Promise<TestJob> {
      h.addCount++;
      const hook = h.beforeAdd;
      h.beforeAdd = undefined;
      await hook?.();
      const attempted = { id: options.jobId, name, data, timestamp: h.clock, attemptsMade: 0 };
      if (!h.jobs.has(options.jobId)) h.jobs.set(options.jobId, structuredClone(attempted));
      // Match BullMQ Job.create: the returned instance contains attempted data,
      // including when the Lua script retained an existing job with this id.
      return attempted;
    }
    async getJob(id: string): Promise<TestJob | undefined> {
      if (h.failJobRead) throw new Error("PRIVATE_REDIS_PROBE");
      const job = h.jobs.get(id);
      return job ? structuredClone(job) : undefined;
    }
  },
  Worker: class {
    constructor(_name: string, processor: Processor, _options: unknown) { h.processor = processor; }
    on() { return this; }
  },
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message: string) { super(message); this.name = "UnrecoverableError"; }
  },
}));
vi.mock("../src/engine/resolveDefinition.js", () => ({
  CustomAgentAuthorizationError: class CustomAgentAuthorizationError extends Error {},
  resolveAgentDefinition: async (agentType: AgentType): Promise<AgentDefinition> => ({
    type: agentType, systemPrompt: "Inert delivery probe", buildContext: h.context,
    tools: [{ name: "inert_probe", description: "Inert effect", sensitive: false, execute: h.execute,
      inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
  }),
}));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async (userId: string, agentType: AgentType): Promise<AgentState> => ({
    userId, agentType, isEnabled: true, autonomyLevel: 3, killSwitch: false, simulationMode: false,
  }),
  recordRunOutcome: async () => {},
}));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide, isMock: false }) }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => {} }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: async () => { throw new Error("Unexpected approval"); } }));

import { UnrecoverableError } from "bullmq";
import { enqueueAgentCycle } from "../src/queue/queues.js";
import { startAgentCycleWorker } from "../src/queue/worker.js";
import { createCycleDelivery, CycleDeliveryConflictError, getQueuedExecutionKey, resolveCycleDelivery } from "../src/queue/delivery-identity.js";

const owner = "00000000-0000-4000-8000-000000000061";
const otherOwner = "00000000-0000-4000-8000-000000000062";
const requestKey = "business-request-one";
const input = (payload: Record<string, unknown> = { mission: "first" }): AgentCycleJobData => ({
  agentType: "legal", userId: owner, trigger: { type: "manual", source: "delivery-probe", payload },
});
function retained(id: string | undefined): TestJob {
  const job = id ? h.jobs.get(id) : undefined;
  if (!job) throw new Error("Expected retained test job");
  return structuredClone(job);
}
function processJob(job: TestJob): Promise<AgentRunResult> {
  if (!h.processor) throw new Error("Worker not initialized");
  return h.processor(job);
}
function asJob(delivery: ReturnType<typeof createCycleDelivery>): TestJob {
  return { id: delivery.jobId, data: delivery.data, timestamp: h.clock, name: "probe", attemptsMade: 0 };
}
async function journals(): Promise<Row[]> {
  return (await database().query<Row>("SELECT * FROM purama_ai.karta_runs ORDER BY started_at,id")).rows;
}

beforeAll(async () => {
  h.db = new PGlite();
  await database().exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'; CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  for (const name of ["001_karta_core.sql", "002_karta_global_kill_switch.sql", "005_karta_pending_actions.sql", "006_execution_claims.sql", "019_karta_approval_parent_guard.sql", "020_execution_fingerprints.sql"]) {
    await database().exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  startAgentCycleWorker();
});
afterAll(async () => { await h.db?.close(); });
beforeEach(async () => {
  vi.clearAllMocks(); h.jobs.clear(); h.clock = 1_000; h.addCount = 0;
  h.failRead = false; h.failJobRead = false; h.beforeInsert = undefined; h.beforeAdd = undefined;
  h.context.mockResolvedValue({}); h.execute.mockResolvedValue({ ok: true, receipt: "inert-receipt" });
  h.decide.mockResolvedValue({ summary: "One inert effect", requiresApproval: false, mock: false,
    toolCalls: [{ tool: "inert_probe", params: {} }] });
  await database().exec("TRUNCATE auth.users CASCADE");
  await database().query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, otherOwner]);
});

describe("durable queue delivery identity", () => {
  it("reuses the same confirmed run after queue retention, and executes a genuinely new mission", async () => {
    const firstId = await enqueueAgentCycle(input(), { dedupeKey: requestKey });
    const firstJob = retained(firstId);
    const first = await processJob(firstJob);
    expect(first.status).toBe("success");
    expect(await processJob(firstJob)).toMatchObject(first);
    expect(h.execute).toHaveBeenCalledOnce();
    h.jobs.clear(); h.clock = 2_000;
    const recreatedId = await enqueueAgentCycle(input(), { dedupeKey: requestKey });
    const recreated = retained(recreatedId);
    expect(recreatedId).toBe(firstId);
    expect(recreated.timestamp).not.toBe(firstJob.timestamp);
    expect(await processJob(recreated)).toMatchObject(first);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(await journals()).toHaveLength(1);
    expect((await journals())[0].execution_key).toBe(getQueuedExecutionKey(firstId));

    const newId = await enqueueAgentCycle(input(), { dedupeKey: "business-request-two" });
    expect(newId).not.toBe(firstId);
    expect((await processJob(retained(newId))).status).toBe("success");
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(await journals()).toHaveLength(2);
  });

  it("keeps separate ordinary missions even with the same input and timestamp", async () => {
    const firstId = await enqueueAgentCycle(input());
    const secondId = await enqueueAgentCycle(input());
    expect(secondId).not.toBe(firstId);
    await processJob(retained(firstId)); await processJob(retained(secondId));
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(await journals()).toHaveLength(2);
  });

  it("scopes the business key to both user and agent", async () => {
    const requests = [input(), { ...input(), userId: otherOwner }, { ...input(), agentType: "email" as const }];
    const ids = await Promise.all(requests.map(data => enqueueAgentCycle(data, { dedupeKey: requestKey })));
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) await processJob(retained(id));
    expect(h.execute).toHaveBeenCalledTimes(3);
    expect(await journals()).toHaveLength(3);
  });

  it("compares the stored queue payload instead of the attempted Job returned by add", async () => {
    const id = await enqueueAgentCycle(input(), { dedupeKey: requestKey });
    await expect(enqueueAgentCycle(input({ mission: "different" }), { dedupeKey: requestKey }))
      .rejects.toBeInstanceOf(CycleDeliveryConflictError);
    expect(retained(id).data.trigger.payload).toEqual({ mission: "first" });
    await processJob(retained(id));
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it("rejects conflicting content after the transport has been purged", async () => {
    const id = await enqueueAgentCycle(input(), { dedupeKey: requestKey });
    await processJob(retained(id)); h.jobs.clear();
    await expect(enqueueAgentCycle(input({ mission: "different" }), { dedupeKey: requestKey }))
      .rejects.toBeInstanceOf(CycleDeliveryConflictError);
    expect(h.jobs.size).toBe(0);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(await journals()).toHaveLength(1);
  });

  it("allows only one of two simultaneous producers with conflicting content", async () => {
    const attempts = await Promise.allSettled([
      enqueueAgentCycle(input({ mission: "A" }), { dedupeKey: requestKey }),
      enqueueAgentCycle(input({ mission: "B" }), { dedupeKey: requestKey }),
    ]);
    expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
    const refused = attempts.find(attempt => attempt.status === "rejected");
    expect(refused?.status === "rejected" ? refused.reason : undefined).toBeInstanceOf(CycleDeliveryConflictError);
    expect(h.jobs.size).toBe(1);
    await processJob([...h.jobs.values()][0]);
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it("does not acknowledge a changed request when the previous job completes between preflight and add", async () => {
    const firstId = await enqueueAgentCycle(input(), { dedupeKey: requestKey });
    const firstJob = retained(firstId);
    h.beforeAdd = async () => { await processJob(firstJob); h.jobs.clear(); h.clock = 2_000; };
    await expect(enqueueAgentCycle(input({ mission: "different" }), { dedupeKey: requestKey }))
      .rejects.toBeInstanceOf(CycleDeliveryConflictError);
    await expect(processJob(retained(firstId))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.execute).toHaveBeenCalledOnce(); expect(await journals()).toHaveLength(1);
  });

  it("enforces the fingerprint at the SQL claim even if concurrent worker preflights both passed", async () => {
    const a = createCycleDelivery(input({ mission: "A" }), requestKey);
    const b = createCycleDelivery(input({ mission: "B" }), requestKey);
    expect(a.jobId).toBe(b.jobId);
    let waiting = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.beforeInsert = async () => { waiting++; if (waiting === 2) release(); await gate; };
    const attempts = await Promise.allSettled([processJob(asJob(a)), processJob(asJob(b))]);
    expect(waiting).toBe(2);
    expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
    const refused = attempts.find(attempt => attempt.status === "rejected");
    expect(refused?.status === "rejected" ? refused.reason : undefined).toBeInstanceOf(UnrecoverableError);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(await journals()).toHaveLength(1);
    expect([a.identity.fingerprint, b.identity.fingerprint]).toContain((await journals())[0].execution_fingerprint);
  });

  it("normalizes property order and snapshots nested payloads before any await", async () => {
    const mutable = input({ nested: { b: 2, a: 1 } });
    const pending = enqueueAgentCycle(mutable, { dedupeKey: requestKey });
    (mutable.trigger.payload!.nested as { b: number }).b = 99;
    const firstId = await pending;
    const repeatedId = await enqueueAgentCycle(input({ nested: { a: 1, b: 2 } }), { dedupeKey: requestKey });
    expect(repeatedId).toBe(firstId);
    expect(retained(firstId).data.trigger.payload).toEqual({ nested: { b: 2, a: 1 } });
    await processJob(retained(firstId));
    expect(h.context).toHaveBeenCalledWith(owner, expect.objectContaining({ payload: { nested: { b: 2, a: 1 } } }));
  });

  it("maps an unprocessed legacy deduplicated job to the new durable identity", async () => {
    const legacyId = `karta-${createHash("sha256").update(requestKey).digest("hex")}`;
    const legacy: TestJob = { id: legacyId, data: input(), timestamp: 12, name: "old", attemptsMade: 0 };
    expect((await processJob(legacy)).status).toBe("success");
    const newId = await enqueueAgentCycle(input(), { dedupeKey: requestKey });
    expect(resolveCycleDelivery(legacy).executionKey).toBe(getQueuedExecutionKey(newId));
    expect((await processJob(retained(newId))).status).toBe("success");
    expect(h.execute).toHaveBeenCalledOnce();
    expect(await journals()).toHaveLength(1);
  });

  it.each(["success", "running"])("blocks a legacy %s claim whose payload cannot be proven", async status => {
    const legacyId = `karta-${createHash("sha256").update(requestKey).digest("hex")}`;
    await database().query("INSERT INTO purama_ai.karta_runs(user_id,agent_type,trigger_type,status,execution_key) VALUES($1,'legal','manual',$2,$3)", [owner, status, `queue:${legacyId}:10`]);
    await expect(enqueueAgentCycle(input(), { dedupeKey: requestKey })).rejects.toBeInstanceOf(CycleDeliveryConflictError);
    await expect(processJob({ id: legacyId, data: input(), timestamp: 20, name: "old", attemptsMade: 0 }))
      .rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.addCount).toBe(0); expect(h.execute).not.toHaveBeenCalled();
    expect(await journals()).toHaveLength(1);
  });

  it("preserves the exact identity of an unprocessed legacy ordinary delivery", async () => {
    const old: TestJob = { id: "17", data: input(), timestamp: 1_234, name: "old", attemptsMade: 0 };
    expect((await processJob(old)).status).toBe("success");
    expect((await processJob(old)).status).toBe("success");
    expect(h.execute).toHaveBeenCalledOnce();
    expect((await journals())[0].execution_key).toBe("queue:17:1234");
  });

  it("does not replay an ordinary legacy journal with no content fingerprint", async () => {
    await database().query("INSERT INTO purama_ai.karta_runs(user_id,agent_type,trigger_type,status,execution_key) VALUES($1,'legal','manual','success','queue:17:1234')", [owner]);
    await expect(processJob({ id: "17", data: input(), timestamp: 1_234, name: "old", attemptsMade: 0 }))
      .rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.execute).not.toHaveBeenCalled(); expect(await journals()).toHaveLength(1);
  });

  it("rejects a modified queued payload without echoing its private content", async () => {
    const job = asJob(createCycleDelivery(input(), requestKey));
    job.data.trigger.payload = { secret: "PRIVATE_PAYLOAD_PROBE" };
    const failure = await processJob(job).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnrecoverableError);
    expect(String(failure)).not.toContain("PRIVATE_PAYLOAD_PROBE");
    expect(h.execute).not.toHaveBeenCalled(); expect(await journals()).toHaveLength(0);
  });

  it("does not reinterpret missing v2 metadata as a legacy delivery", async () => {
    const job = asJob(createCycleDelivery(input(), requestKey));
    delete job.data.delivery;
    await expect(processJob(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.execute).not.toHaveBeenCalled(); expect(await journals()).toHaveLength(0);
  });

  it("fails closed with a safe retryable error when legacy/current claims cannot be read", async () => {
    const job = asJob(createCycleDelivery(input(), requestKey)); h.failRead = true;
    const producerFailure = await enqueueAgentCycle(input(), { dedupeKey: requestKey }).catch((error: unknown) => error);
    const workerFailure = await processJob(job).catch((error: unknown) => error);
    for (const failure of [producerFailure, workerFailure]) {
      expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(UnrecoverableError);
      expect(String(failure)).not.toContain("PRIVATE_DATABASE_PROBE");
    }
    expect(h.addCount).toBe(0); expect(h.execute).not.toHaveBeenCalled();
  });

  it("keeps a lost queue acknowledgement uncertain and makes retry use the same claim", async () => {
    h.failJobRead = true;
    const failure = await enqueueAgentCycle(input(), { dedupeKey: requestKey }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain("PRIVATE_REDIS_PROBE");
    const queued = [...h.jobs.values()][0];
    await processJob(queued);
    h.failJobRead = false;
    const id = await enqueueAgentCycle(input(), { dedupeKey: requestKey });
    await processJob(retained(id));
    expect(h.execute).toHaveBeenCalledOnce(); expect(await journals()).toHaveLength(1);
  });
});

describe("execution fingerprint migration constraints", () => {
  it("reapplies migration 020 without losing existing claims or adding a second constraint", async () => {
    const fingerprint = "a".repeat(64);
    await database().query("INSERT INTO purama_ai.karta_runs(user_id,agent_type,trigger_type,execution_key,execution_fingerprint) VALUES($1,'legal','manual','existing-delivery',$2)", [owner, fingerprint]);
    const migration = await readFile(new URL("../migrations/020_execution_fingerprints.sql", import.meta.url), "utf8");
    await database().exec(migration);
    await database().exec(migration);
    expect(await journals()).toMatchObject([{ execution_key: "existing-delivery", execution_fingerprint: fingerprint }]);
    const constraints = await database().query("SELECT conname FROM pg_constraint WHERE conrelid='purama_ai.karta_runs'::regclass AND conname='karta_runs_execution_fingerprint_format'");
    expect(constraints.rows).toHaveLength(1);
  });

  it("accepts a lowercase SHA-256 fingerprint with its execution key and preserves nullable legacy rows", async () => {
    const fingerprint = "0123456789abcdef".repeat(4);
    await database().query("INSERT INTO purama_ai.karta_runs(user_id,agent_type,trigger_type,execution_key,execution_fingerprint) VALUES($1,'legal','manual','new-delivery',$2),($1,'legal','manual','legacy-delivery',NULL),($1,'legal','manual',NULL,NULL)", [owner, fingerprint]);
    const rows = await journals();
    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual(expect.objectContaining({ execution_key: "new-delivery", execution_fingerprint: fingerprint }));
    expect(rows).toContainEqual(expect.objectContaining({ execution_key: "legacy-delivery", execution_fingerprint: null }));
    expect(rows).toContainEqual(expect.objectContaining({ execution_key: null, execution_fingerprint: null }));
  });

  it.each(["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), `${"a".repeat(64)}\n`])(
    "rejects an invalid fingerprint at the SQL boundary: %j", async fingerprint => {
      await expect(database().query("INSERT INTO purama_ai.karta_runs(user_id,agent_type,trigger_type,execution_key,execution_fingerprint) VALUES($1,'legal','manual','invalid-delivery',$2)", [owner, fingerprint]))
        .rejects.toMatchObject({ code: "23514" });
      expect(await journals()).toHaveLength(0);
    }
  );

  it("rejects a non-null fingerprint when no durable execution key accompanies it", async () => {
    await expect(database().query("INSERT INTO purama_ai.karta_runs(user_id,agent_type,trigger_type,execution_fingerprint) VALUES($1,'legal','manual',$2)", [owner, "b".repeat(64)]))
      .rejects.toMatchObject({ code: "23514" });
    expect(await journals()).toHaveLength(0);
  });
});
