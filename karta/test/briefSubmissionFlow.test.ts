import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import type { AgentDefinition, AgentRunResult } from "../src/engine/types.js";
import type { AgentCycleJobData } from "../src/queue/queues.js";

// Real HTTP -> admission RPC -> enqueue/worker -> engine -> SQL receipt -> status.
// Only the transport, model and business effect are inert. This is not a live
// Redis/PostgREST/provider or multi-connection PostgreSQL qualification.
type Row = Record<string, unknown>;
type Job = { id: string; data: AgentCycleJobData; timestamp: number; attemptsMade: number };
type Reply = { data: unknown; error: null | { code?: string; message: string } };
const h = vi.hoisted(() => ({
  db: null as PGlite | null, jobs: new Map<string, Job>(), processor: undefined as ((job: Job) => Promise<AgentRunResult>) | undefined,
  simulation: false, loseSubmit: 0, loseAdd: 0, clock: 1000,
  definition: null as AgentDefinition | null, decide: vi.fn(), effect: vi.fn(),
}));
const user = "00000000-0000-4000-8000-000000000071";
const otherUser = "00000000-0000-4000-8000-000000000072";
const first = "10000000-0000-4000-8000-000000000071";
const second = "10000000-0000-4000-8000-000000000072";
const firstRequest = "20000000-0000-4000-8000-000000000071";
const secondRequest = "20000000-0000-4000-8000-000000000072";
const agentType = "newsletter-genie";
const PRIVATE = "BRIEF_FLOW_PRIVATE_9143";
const identifier = (value: string) => {
  if (!/^[a-z_]+$/.test(value)) throw new Error("Unexpected fixture identifier");
  return `"${value}"`;
};

function from(table: string) {
  if (!["karta_runs", "karta_pending_actions"].includes(table)) throw new Error("Unexpected fixture table");
  let insert: Row | undefined; let update: Row | undefined;
  let shape: "many" | "one" | "maybe" = "many";
  let limit: number | undefined;
  const filters: Array<[string, string, unknown]> = [];
  const execute = async (): Promise<Reply> => {
    const values: unknown[] = [];
    const bind = (value: unknown) => {
      values.push(value && typeof value === "object" ? JSON.stringify(value) : value);
      return `$${values.length}`;
    };
    const where = () => filters.map(([key, op, value]) => op === "IS NULL"
      ? `${identifier(key)} IS NULL` : `${identifier(key)} ${op} ${bind(value)}`).join(" AND ") || "TRUE";
    try {
      let sql: string;
      if (insert) {
        const entries = Object.entries(insert);
        sql = `INSERT INTO purama_ai.${table} (${entries.map(([key]) => identifier(key)).join(",")}) VALUES (${entries.map(([, value]) => bind(value)).join(",")}) RETURNING *`;
      } else if (update) {
        const set = Object.entries(update).map(([key, value]) => `${identifier(key)} = ${bind(value)}`);
        sql = `UPDATE purama_ai.${table} SET ${set.join(",")} WHERE ${where()} RETURNING *`;
      } else sql = `SELECT * FROM purama_ai.${table} WHERE ${where()}${limit ? ` LIMIT ${limit}` : ""}`;
      const result = await h.db!.query<Row>(sql, values);
      if (shape === "many") return { data: result.rows, error: null };
      if (result.rows.length > 1 || (shape === "one" && result.rows.length !== 1)) return { data: null, error: { code: "PGRST116", message: "Unexpected cardinality" } };
      return { data: result.rows[0] ?? null, error: null };
    } catch (error) {
      return { data: null, error: { code: (error as { code?: string }).code, message: "Fixture SQL rejected" } };
    }
  };
  const q = {
    insert(value: Row) { insert = value; return q; }, update(value: Row) { update = value; return q; },
    select() { return q; }, eq(key: string, value: unknown) { filters.push([key, "=", value]); return q; },
    like(key: string, value: unknown) { filters.push([key, "LIKE", value]); return q; },
    is(key: string, value: unknown) { if (value !== null) throw new Error("Unsupported fixture predicate"); filters.push([key, "IS NULL", null]); return q; },
    limit(value: number) { limit = value; return q; },
    single() { shape = "one"; return execute(); }, maybeSingle() { shape = "maybe"; return execute(); },
    then: ((resolve, reject) => execute().then(resolve, reject)) as PromiseLike<Reply>["then"],
  };
  return q;
}

async function rpc(name: string, params: Record<string, unknown>): Promise<Reply> {
  const allowed = ["karta_submit_brief", "karta_get_brief_status", "karta_list_briefs", "karta_claim_pending_brief", "karta_peek_pending_brief", "karta_arm_pending_brief"];
  if (!allowed.includes(name)) throw new Error("Unexpected fixture RPC");
  const types: Record<string, string> = { p_user_id: "uuid", p_agent_type: "text", p_submission_id: "uuid", p_brief: "text", p_run_id: "uuid", p_key: "text", p_expected_brief_id: "uuid" };
  const entries = Object.entries(params);
  const args = entries.map(([key], i) => {
    if (!types[key]) throw new Error("Unexpected fixture RPC argument");
    return `${key} => $${i + 1}::${types[key]}`;
  });
  const arm = name === "karta_arm_pending_brief";
  try {
    const result = await h.db!.query<Row>(arm
      ? `SELECT purama_ai.${name}(${args.join(",")}) AS armed`
      : `SELECT * FROM purama_ai.${name}(${args.join(",")})`, entries.map(([, value]) => value));
    if (name === "karta_submit_brief" && h.loseSubmit > 0) {
      h.loseSubmit--; return { data: null, error: { message: PRIVATE + " acknowledgement lost after commit" } };
    }
    return { data: arm ? result.rows[0]?.armed : result.rows, error: null };
  } catch (error) {
    return { data: null, error: { code: (error as { code?: string }).code, message: PRIVATE + " SQL rejected" } };
  }
}

vi.mock("../src/db/supabase.js", () => ({ supabase: { from, rpc } }));
vi.mock("../src/queue/redis.js", () => ({ redisConnection: {} }));
vi.mock("bullmq", () => ({
  Queue: class {
    async add(_name: string, data: AgentCycleJobData, options: { jobId: string }) {
      const attempted = { id: options.jobId, data: structuredClone(data), timestamp: h.clock++, attemptsMade: 0 };
      if (!h.jobs.has(attempted.id)) h.jobs.set(attempted.id, structuredClone(attempted));
      if (h.loseAdd > 0) { h.loseAdd--; throw new Error(PRIVATE + " queue acknowledgement lost"); }
      return attempted;
    }
    async getJob(id: string) { const job = h.jobs.get(id); return job ? structuredClone(job) : undefined; }
  },
  Worker: class { constructor(_name: string, processor: typeof h.processor) { h.processor = processor; } on() { return this; } },
  UnrecoverableError: class extends Error {},
}));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false, setGlobalKillSwitch: vi.fn() }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async (userId: string, type: string) => ({ userId, agentType: type, isEnabled: true, killSwitch: false, autonomyLevel: 3, simulationMode: h.simulation }),
  recordRunOutcome: async () => undefined,
}));
vi.mock("../src/engine/resolveDefinition.js", () => ({ resolveAgentDefinition: async () => h.definition, CustomAgentAuthorizationError: class extends Error {} }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide }) }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => undefined }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: vi.fn(), resolvePendingAction: vi.fn() }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: { "newsletter-genie": {} } }));
vi.mock("../src/agents/customAgent.js", () => ({ loadCustomAgent: vi.fn() }));

import { newsletterGenieAgent } from "../src/agents/actionAgents.js";
import { startApiServer } from "../src/api/server.js";
import { startAgentCycleWorker } from "../src/queue/worker.js";
import { runAgentCycle } from "../src/engine/loop.js";
let server: ReturnType<typeof startApiServer>;
let port: number;
beforeAll(async () => {
  h.db = new PGlite();
  await h.db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'; CREATE SCHEMA purama_ai;");
  for (const name of ["001_karta_core.sql", "002_karta_global_kill_switch.sql", "005_karta_pending_actions.sql", "006_execution_claims.sql", "018_karta_brief_claims.sql", "019_karta_approval_parent_guard.sql", "020_execution_fingerprints.sql", "025_brief_submission.sql", "026_pending_action_execution_origin.sql"]) {
    await h.db.exec(await readFile(new URL("../migrations/" + name, import.meta.url), "utf8"));
  }
  startAgentCycleWorker();
  server = startApiServer();
  await new Promise<void>(resolve => server.once("listening", resolve));
  port = (server.address() as { port: number }).port;
}, 30_000);
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await h.db?.close();
});
beforeEach(async () => {
  vi.resetAllMocks(); h.jobs.clear(); h.simulation = false; h.loseSubmit = 0; h.loseAdd = 0;
  await h.db!.exec("TRUNCATE auth.users CASCADE;");
  await h.db!.query("INSERT INTO auth.users(id) VALUES ($1),($2)", [user, otherUser]);
  h.definition = {
    ...newsletterGenieAgent,
    tools: [{ name: "probe", description: "Inert effect", sensitive: false,
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, execute: h.effect }],
  };
  h.decide.mockImplementation(async input => ({ summary: PRIVATE, mock: false, requiresApproval: false,
    toolCalls: [{ tool: "probe", params: { text: input.context.items[0].brief } }] }));
  h.effect.mockResolvedValue({ ok: true, receipt: PRIVATE });
});

function http(path: string, body?: unknown, requestKey = firstRequest, token = "test-only-admin") {
  return new Promise<{ status: number; body: Row }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": requestKey,
    } }, res => { let raw = ""; res.on("data", c => { raw += c; }); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(raw) as Row })); });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const submit = (id = first, brief = PRIVATE, requestId = firstRequest) => http(`/trigger/${agentType}/${user}`, { action: "submit-brief", submissionId: id, brief }, requestId);
const retry = (id = first, requestId = secondRequest) => http(`/trigger/${agentType}/${user}`, { action: "retry-brief", submissionId: id }, requestId);
const status = (id = first, owner = user) => http(`/briefs/${agentType}/${owner}?submissionId=${id}`);
const mission = (response: { body: Row }) => response.body.mission as Row;
const jobs = () => [...h.jobs.values()];
const processJob = (job = jobs()[0]) => h.processor!(job);
const memory = async () => (await h.db!.query<Row>("SELECT * FROM purama_ai.karta_agent_memory")).rows;

describe("durable user mission through the combined HTTP/SQL/queue/engine contract", () => {
  it("stores before enqueue, handles a lost SQL acknowledgement, and returns the correlated result without private text", async () => {
    h.loseSubmit = 1;
    const accepted = await submit();
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ accepted: true, dispatch: { state: "queued" } });
    expect(await memory()).toHaveLength(1);
    expect(jobs()).toHaveLength(1);
    expect(JSON.stringify(jobs())).not.toContain(PRIVATE);
    await processJob();
    expect(h.effect).toHaveBeenCalledOnce();
    expect(h.effect.mock.calls[0][0]).toEqual({ text: PRIVATE });
    const result = await status();
    expect(mission(result)).toMatchObject({ submissionId: first, state: "completed", attemptCount: 1, run: { status: "success", mode: "live", mock: false } });
    expect(JSON.stringify(result.body)).not.toContain(PRIVATE);
    const logs = await h.db!.query<Row>("SELECT * FROM purama_ai.karta_runs");
    expect(JSON.stringify(logs.rows)).not.toContain(PRIVATE);
    expect(logs.rows[0].brief_id).toBe(first);
  });

  it("reuses a lost queue acknowledgement, the same request, and a late retry after queue retention ends", async () => {
    h.loseAdd = 1;
    const uncertain = await submit();
    expect(uncertain.body).toMatchObject({ accepted: true, dispatch: { state: "unconfirmed" } });
    expect(await memory()).toHaveLength(1);
    const repeat = await submit();
    expect(repeat.body).toMatchObject({ dispatch: { state: "queued" } });
    expect(jobs()).toHaveLength(1);
    await processJob();
    h.jobs.clear();
    const late = await submit();
    expect(late.body).toMatchObject({ dispatch: { state: "not_requested" }, mission: { state: "completed" } });
    expect(h.effect).toHaveBeenCalledOnce();
    expect(jobs()).toHaveLength(0);
    expect(await memory()).toHaveLength(0);
  });

  it("refuses a second pending mission and a changed payload under the same identity", async () => {
    await submit();
    expect((await submit(second, "New mission", secondRequest)).body).toMatchObject({ code: "BRIEF_BUSY" });
    expect((await submit(first, "Changed mission")).body).toMatchObject({ code: "BRIEF_CONFLICT" });
    expect(await memory()).toHaveLength(1);
    await processJob();
    expect(h.effect.mock.calls[0][0]).toEqual({ text: PRIVATE });
  });

  it("binds mission B exactly while an older mission A is ready for a safe retry", async () => {
    await submit();
    h.decide.mockRejectedValueOnce(new Error(PRIVATE));
    await expect(processJob()).rejects.toThrow();
    expect(mission(await status()).state).toBe("ready");
    expect((await submit(second, "Mission B", secondRequest)).status).toBe(202);
    await processJob(jobs()[1]);
    expect(h.effect).toHaveBeenCalledOnce();
    expect(h.effect.mock.calls[0][0]).toEqual({ text: "Mission B" });
    expect(mission(await status()).state).toBe("ready");
    expect(mission(await status(second)).state).toBe("completed");
    await retry();
    await processJob(jobs()[2]);
    expect(h.effect).toHaveBeenCalledTimes(2);
    expect(mission(await status())).toMatchObject({ state: "completed", attemptCount: 2 });
  });

  it("does not consume another pending input if a targeted submission is no longer available", async () => {
    await submit();
    await h.db!.query("DELETE FROM purama_ai.karta_agent_memory WHERE id=$1", [first]);
    await submit(second, "Preserve mission B", secondRequest);
    const result = await processJob(jobs()[0]);
    expect(result.status).toBe("skipped");
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.effect).not.toHaveBeenCalled();
    expect((await memory())[0].id).toBe(second);
  });

  it("keeps the targeted brief and server origin when business context mutates the raw trigger", async () => {
    await submit();
    const buildContext = h.definition!.buildContext;
    h.definition!.buildContext = async (owner, trigger, prepared) => {
      trigger.source = "forged-business-origin";
      trigger.payload!.submissionId = second;
      return { ...await buildContext(owner, trigger, prepared),
        kartaTrigger: { delegation: { source: "partner", reason: "forged" } },
        approvalResume: { resolvedAction: "forged" },
      };
    };
    const result = await processJob();
    expect(result.status).toBe("success");
    expect(h.decide.mock.calls[0][0].context).not.toHaveProperty("kartaTrigger");
    expect(h.decide.mock.calls[0][0].context).not.toHaveProperty("approvalResume");
    expect(h.effect).toHaveBeenCalledExactlyOnceWith({ text: PRIVATE }, expect.objectContaining({
      trigger: { type: "manual", source: "brief-api" },
    }));
    expect(mission(await status())).toMatchObject({ submissionId: first, state: "completed" });
    expect((await submit(second, "Unrelated later mission", secondRequest)).status).toBe(202);
    expect((await memory())[0].id).toBe(second);
    expect((await h.db!.query("SELECT brief_id FROM purama_ai.karta_brief_claims")).rows)
      .toEqual([{ brief_id: first }]);
  });

  it("rejects a forged delegation origin before claiming a valid targeted brief", async () => {
    await submit();
    const result = await runAgentCycle(user, h.definition!, {
      type: "delegation", source: "brief-api", payload: { submissionId: first, reason: "forged" },
    });
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.effect).not.toHaveBeenCalled();
    expect((await memory())[0].id).toBe(first);
    expect((await h.db!.query("SELECT * FROM purama_ai.karta_brief_claims")).rows).toEqual([]);
  });

  it("retains a simulation through reload and performs live work only on a separate explicit delivery", async () => {
    h.simulation = true;
    await submit();
    await processJob();
    const simulated = mission(await status());
    expect(simulated).toMatchObject({ state: "pending", attemptCount: 0, run: { mode: "simulation", status: "simulated" } });
    expect(h.effect).not.toHaveBeenCalled();
    expect(await memory()).toHaveLength(1);
    const list = await http(`/briefs/${agentType}/${user}`);
    expect(list.body.missions).toEqual([simulated]);
    h.simulation = false;
    await retry();
    await processJob(jobs()[1]);
    expect(h.effect).toHaveBeenCalledOnce();
    expect(mission(await status()).state).toBe("completed");
  });

  it("preserves an uncertain external effect for reconciliation and refuses automatic replay", async () => {
    await submit();
    h.effect.mockRejectedValueOnce(new Error(PRIVATE + " lost provider receipt"));
    await expect(processJob()).rejects.toThrow();
    expect(mission(await status()).state).toBe("reconciliation_required");
    const response = await retry();
    expect(response.body).toMatchObject({ dispatch: { state: "not_requested" } });
    expect(jobs()).toHaveLength(1);
    expect(h.effect).toHaveBeenCalledOnce();
  });

  it("keeps owner metadata isolated and rejects unauthenticated or malformed requests before admission", async () => {
    expect((await http(`/trigger/${agentType}/${user}`, { action: "submit-brief", submissionId: first, brief: PRIVATE }, firstRequest, "wrong")).status).toBe(401);
    expect((await submit(first, " ")).status).toBe(400);
    expect((await http(`/trigger/${agentType}/${user}`, { action: "submit-brief", submissionId: first, brief: PRIVATE, userId: otherUser })).status).toBe(400);
    expect(jobs()).toHaveLength(0);
    await submit();
    expect(mission(await status(first, otherUser))).toBeNull();
    expect((await http(`/briefs/${agentType}/${otherUser}`)).body.missions).toEqual([]);
    expect((await http(`/briefs/${agentType}/${user}?submissionId=${first}&submissionId=${second}`)).status).toBe(400);
  });

  it.each(["executed", "rejected"] as const)("does not use a fresh mission as the continuation of an old %s approval", async resolution => {
    const parentId = "30000000-0000-4000-8000-000000000071";
    const pendingId = "40000000-0000-4000-8000-000000000071";
    await h.db!.query(`INSERT INTO purama_ai.karta_runs
      (id,user_id,agent_type,trigger_type,trigger_source,mode,status,duration_ms,finished_at,claude_mock,tools_used)
      VALUES ($1,$2,$3,'manual','approved-fixture','live','partial',1,now(),false,$4::jsonb)`,
    [parentId, user, agentType, JSON.stringify([
      { tool: "probe", outcome: resolution, success: resolution === "executed", pendingActionId: pendingId },
      { tool: "probe", outcome: "skipped", success: false },
    ])]);
    await h.db!.query(`INSERT INTO purama_ai.karta_pending_actions
      (id,user_id,run_id,agent_type,tool_name,tool_params,status,resolved_at)
      VALUES ($1,$2,$3,$4,'probe',$5::jsonb,$6,now())`,
    [pendingId, user, parentId, agentType, JSON.stringify({ text: "Original approved instruction" }), resolution]);
    await submit(second, "Keep this new unrelated mission", secondRequest);
    const result = await runAgentCycle(user, h.definition!, {
      type: "delegation", source: "approval-resume", payload: { previousRunId: parentId, pendingActionId: pendingId, resolution },
    }, `approval-brief-boundary:${resolution}`);
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(result.errorMessage).toContain("Reprise automatique suspendue");
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.effect).not.toHaveBeenCalled();
    expect((await memory())[0].id).toBe(second);
    expect((await h.db!.query("SELECT * FROM purama_ai.karta_brief_claims")).rows).toHaveLength(0);
  });
});
