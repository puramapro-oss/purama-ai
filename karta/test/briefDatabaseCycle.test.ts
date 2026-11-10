import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { AgentDefinition } from "../src/engine/types.js";

type Row = Record<string, unknown>;
type DatabaseReply = { data: Row | null; error: { message: string; code?: string } | null };
type InferenceInput = { context: { items: Array<{ brief: string }> } };

const h = vi.hoisted(() => ({
  db: null as PGlite | null,
  simulation: false,
  mock: false,
  loseClaimAck: 0,
  loseArmAck: 0,
  loseFinishAck: 0,
  runIds: [] as string[],
  rpcNames: [] as string[],
  receivedBriefs: [] as string[],
  updateAttempts: 0,
  updatedRows: 0,
  decide: vi.fn(),
  execute: vi.fn(),
}));

// A small adapter for the exact Supabase operations used by the real logger.
// Predicates, row locking, transactions, JSON, unique constraints, RPC bodies,
// and the closing trigger are evaluated by PostgreSQL, not by this adapter.
function runQuery(table: string) {
  if (table !== "karta_runs") throw new Error("Unexpected table in database cycle test");
  let inserted: Row | undefined;
  let patch: Row | undefined;
  let single = false;
  const filters: Array<{ key: string; value: unknown; isNull: boolean }> = [];
  const identifier = (value: string) => {
    if (!/^[a-z_]+$/.test(value)) throw new Error("Invalid test column");
    return '"' + value + '"';
  };
  const execute = async (): Promise<DatabaseReply> => {
    const parameters: unknown[] = [];
    const bind = (value: unknown) => {
      parameters.push(value !== null && typeof value === "object" ? JSON.stringify(value) : value);
      return "$" + parameters.length;
    };
    const where = () => filters.map(filter => filter.isNull
      ? identifier(filter.key) + " IS NULL"
      : identifier(filter.key) + " = " + bind(filter.value)).join(" AND ");
    try {
      let sql: string;
      if (inserted) {
        const entries = Object.entries(inserted);
        sql = "INSERT INTO purama_ai.karta_runs (" + entries.map(([key]) => identifier(key)).join(",")
          + ") VALUES (" + entries.map(([, value]) => bind(value)).join(",") + ") RETURNING *";
      } else if (patch) {
        h.updateAttempts++;
        const assignments = Object.entries(patch).map(([key, value]) => identifier(key) + " = " + bind(value));
        sql = "UPDATE purama_ai.karta_runs SET " + assignments.join(",") + " WHERE " + where() + " RETURNING *";
      } else {
        sql = "SELECT * FROM purama_ai.karta_runs WHERE " + where();
      }
      const result = await h.db!.query<Row>(sql, parameters);
      if (inserted && result.rows[0]) h.runIds.push(String(result.rows[0].id));
      if (patch) {
        h.updatedRows += result.rows.length;
        if (h.loseFinishAck > 0) {
          h.loseFinishAck--;
          return { data: null, error: { message: "Write committed; transport acknowledgement lost" } };
        }
      }
      return single && result.rows.length !== 1
        ? { data: null, error: { message: "Expected exactly one row", code: "PGRST116" } }
        : { data: result.rows[0] ?? null, error: null };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      return { data: null, error: { message: "Test PostgreSQL operation rejected", ...(code ? { code } : {}) } };
    }
  };
  const q = {
    insert(value: Row) { inserted = value; return q; },
    update(value: Row) { patch = value; return q; },
    select() { return q; },
    eq(key: string, value: unknown) { filters.push({ key, value, isNull: false }); return q; },
    is(key: string, value: unknown) {
      if (value !== null) throw new Error("Only IS NULL is supported");
      filters.push({ key, value, isNull: true }); return q;
    },
    single() { single = true; return execute(); },
    then: ((resolve, reject) => execute().then(resolve, reject)) as PromiseLike<DatabaseReply>["then"],
  };
  return q;
}

async function rpc(name: string, params: Record<string, unknown>) {
  h.rpcNames.push(name);
  if (!["karta_claim_pending_brief", "karta_peek_pending_brief", "karta_arm_pending_brief"].includes(name)) {
    throw new Error("Unexpected RPC in database cycle test");
  }
  const arm = name === "karta_arm_pending_brief";
  const values = [params.p_user_id, params.p_agent_type, params.p_run_id];
  if (!arm) values.push(params.p_key);
  const sql = arm
    ? "SELECT purama_ai.karta_arm_pending_brief($1::uuid,$2::text,$3::uuid) AS armed"
    : "SELECT * FROM purama_ai." + name + "($1::uuid,$2::text,$3::uuid,$4::text)";
  try {
    const result = await h.db!.query<Row>(sql, values);
    if (name === "karta_claim_pending_brief" && h.loseClaimAck > 0) {
      h.loseClaimAck--;
      return { data: null, error: { message: "Claim committed; response lost" } };
    }
    if (arm && h.loseArmAck > 0) {
      h.loseArmAck--;
      return { data: null, error: { message: "Arm committed; response lost" } };
    }
    return { data: arm ? result.rows[0]?.armed : result.rows, error: null };
  } catch {
    return { data: null, error: { message: "Test RPC rejected" } };
  }
}

vi.mock("../src/db/supabase.js", () => ({
  supabase: { from: (table: string) => runQuery(table), rpc },
}));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async () => ({
    userId: "00000000-0000-4000-8000-000000000071", agentType: "newsletter-genie",
    isEnabled: true, killSwitch: false, autonomyLevel: 3, simulationMode: h.simulation,
  }),
  recordRunOutcome: async () => undefined,
}));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: async () => { throw new Error("Unexpected approval"); } }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => undefined }));
// The SQL/engine are real; queue transport is outside this local database proof.
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));

// The logger and brief client are deliberately NOT mocked.
const { runAgentCycle } = await import("../src/engine/loop.js");
const { newsletterGenieAgent } = await import("../src/agents/actionAgents.js");
const user = "00000000-0000-4000-8000-000000000071";
const SECRET = "DATABASE_CYCLE_PRIVATE_BRIEF_9143";
const agent: AgentDefinition = {
  ...newsletterGenieAgent,
  tools: [{
    name: "checked_action", description: "Isolated test action", sensitive: false,
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    execute: h.execute,
  }],
};
const cycle = (key?: string) => runAgentCycle(user, agent, { type: "manual", source: "database-cycle-test" }, key);
async function rows(table: "karta_runs" | "karta_brief_claims" | "karta_agent_memory"): Promise<Row[]> {
  return (await h.db!.query<Row>("SELECT * FROM purama_ai." + table)).rows;
}
async function claimFor(runId: string): Promise<Row | undefined> {
  return (await h.db!.query<Row>("SELECT * FROM purama_ai.karta_brief_claims WHERE run_id = $1", [runId])).rows[0];
}
async function submit(brief = SECRET): Promise<void> {
  await h.db!.query(
    "INSERT INTO purama_ai.karta_agent_memory(user_id,agent_type,memory_key,memory_value) VALUES ($1,'newsletter-genie','pending_brief',$2::jsonb)",
    [user, JSON.stringify(brief)],
  );
}
async function expectNoJournalPayload(): Promise<void> {
  expect(JSON.stringify(await rows("karta_runs"))).not.toContain(SECRET);
}

beforeAll(async () => {
  h.db = new PGlite();
  await h.db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'; CREATE SCHEMA purama_ai;");
  // KARTA004 extends the existing app table. Apply its actual foundation,
  // including policies and privileges, instead of inventing a table fixture.
  await h.db.exec(await readFile(new URL("../../supabase/migrations/20260407000000_creator_agent.sql", import.meta.url), "utf8"));
  for (const name of [
    "001_karta_core.sql",
    "002_karta_global_kill_switch.sql",
    "003_karta_crm_leads.sql",
    "004_karta_custom_agents.sql",
    "005_karta_pending_actions.sql",
    "006_execution_claims.sql",
    "007_runtime_hardening.sql",
    "008_chef_control_plane.sql",
    "009_chef_hardening.sql",
    "010_chef_reliability.sql",
    "011_chef_runtime_policy.sql",
    "012_chef_mission_ingest.sql",
    "013_chef_independent_review.sql",
    "014_chef_file_ownership.sql",
    "015_chef_mission_file_ownership.sql",
    "016_chef_scoped_evidence.sql",
    "017_chef_evidence_generation.sql",
    "018_karta_brief_claims.sql",
    "019_karta_approval_parent_guard.sql",
    "020_execution_fingerprints.sql",
    "021_pending_action_execution_trigger.sql",
    "022_chef_budget_reservations.sql",
  ]) {
    await h.db.exec(await readFile(new URL("../migrations/" + name, import.meta.url), "utf8"));
  }
}, 30_000);

afterAll(async () => { await h.db?.close(); });
beforeEach(async () => {
  vi.resetAllMocks();
  h.simulation = false; h.mock = false;
  h.loseClaimAck = 0; h.loseArmAck = 0; h.loseFinishAck = 0;
  h.runIds = []; h.rpcNames = []; h.receivedBriefs = [];
  h.updateAttempts = 0; h.updatedRows = 0;
  await h.db!.exec("TRUNCATE auth.users CASCADE;");
  await h.db!.query("INSERT INTO auth.users(id) VALUES ($1)", [user]);
  h.decide.mockImplementation(async (input: InferenceInput) => {
    const brief = input.context.items[0].brief;
    h.receivedBriefs.push(brief);
    return {
      summary: brief, mock: h.mock, requiresApproval: false,
      toolCalls: [{ tool: "checked_action", params: { text: brief } }],
    };
  });
  h.execute.mockResolvedValue({ ok: true, receipt: SECRET });
});

describe("real brief RPC, agent cycle, immutable logger, and PostgreSQL closing trigger", () => {
  it("retains an inference failure, retries its brief once, and skips after confirmed completion", async () => {
    await submit();
    h.decide.mockRejectedValueOnce(new Error(SECRET));
    const first = await cycle();
    expect(first.status).toBe("error");
    expect(await claimFor(h.runIds[0])).toMatchObject({ state: "ready", payload: SECRET });
    expect((await rows("karta_runs"))[0]).toMatchObject({ status: "error" });
    expect(h.execute).not.toHaveBeenCalled();

    const second = await cycle();
    expect(second.status).toBe("success");
    expect(await claimFor(h.runIds[0])).toMatchObject({ state: "transferred", transferred_to_run_id: h.runIds[1] });
    expect(await claimFor(h.runIds[1])).toMatchObject({ state: "completed", payload: SECRET, previous_run_id: h.runIds[0] });
    const third = await cycle();
    expect(third).toMatchObject({ status: "skipped", toolsUsed: [] });
    expect(h.decide).toHaveBeenCalledTimes(2);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(await rows("karta_agent_memory")).toHaveLength(0);
    expect(await rows("karta_brief_claims")).toHaveLength(2);
    await expectNoJournalPayload();
  });

  it("simulation reads the real pending value without reserving, deleting, or executing it", async () => {
    await submit(); h.simulation = true;
    const result = await cycle();
    expect(result.status).toBe("simulated");
    expect(h.receivedBriefs).toEqual([SECRET]);
    expect(await rows("karta_brief_claims")).toEqual([]);
    expect((await rows("karta_agent_memory"))[0]).toMatchObject({ memory_value: SECRET });
    expect(h.rpcNames).toEqual(["karta_peek_pending_brief"]);
    expect(h.execute).not.toHaveBeenCalled();
    await expectNoJournalPayload();
  });

  it("recovers a lost claim acknowledgement for the same run without a second inference", async () => {
    await submit(); h.loseClaimAck = 1;
    const result = await cycle();
    expect(result.status).toBe("success");
    expect(h.rpcNames.filter(name => name === "karta_claim_pending_brief")).toHaveLength(2);
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledOnce();
    expect(await rows("karta_brief_claims")).toHaveLength(1);
    expect(await claimFor(h.runIds[0])).toMatchObject({ state: "completed", payload: SECRET });
    await expectNoJournalPayload();
  });

  it("keeps an ambiguously acknowledged arm for reconciliation and prevents all effects or next-cycle replay", async () => {
    await submit(); h.loseArmAck = 2;
    const result = await cycle();
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.rpcNames.filter(name => name === "karta_arm_pending_brief")).toHaveLength(2);
    expect(await claimFor(h.runIds[0])).toMatchObject({ state: "reconciliation_required", payload: SECRET });
    expect(h.execute).not.toHaveBeenCalled();
    const next = await cycle();
    expect(next.status).toBe("skipped");
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
    await expectNoJournalPayload();
  });

  it("reconciles a lost finish acknowledgement against the actual journal and trigger outcome without replay", async () => {
    await submit(); h.loseFinishAck = 1;
    const result = await cycle();
    expect(result).toMatchObject({ status: "success", retryable: false });
    expect(h.updateAttempts).toBe(1);
    expect(h.updatedRows).toBe(1);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(await claimFor(h.runIds[0])).toMatchObject({ state: "completed" });
    expect((await rows("karta_runs"))[0]).toMatchObject({ status: "success" });
    await expectNoJournalPayload();
  });

  it("preserves a newer submission during failure, then processes both distinct briefs", async () => {
    await submit();
    const newer = SECRET + "_NEW";
    h.decide.mockImplementationOnce(async () => {
      await submit(newer);
      throw new Error("Model unavailable after the newer user submission");
    });
    expect((await cycle()).status).toBe("error");
    expect((await rows("karta_agent_memory"))[0]).toMatchObject({ memory_value: newer });
    expect(await claimFor(h.runIds[0])).toMatchObject({ state: "ready", payload: SECRET });

    expect((await cycle()).status).toBe("success");
    expect((await rows("karta_agent_memory"))[0]).toMatchObject({ memory_value: newer });
    expect((await cycle()).status).toBe("success");
    expect(h.execute.mock.calls.map(call => call[0].text)).toEqual([SECRET, newer]);
    expect(await rows("karta_agent_memory")).toHaveLength(0);
    expect((await rows("karta_brief_claims")).filter(row => row.state === "completed")).toHaveLength(2);
    await expectNoJournalPayload();
  });

  it("uses the existing durable execution key to return history without reacquiring or rerunning", async () => {
    await submit();
    expect((await cycle("same-delivery")).status).toBe("success");
    const replay = await cycle("same-delivery");
    expect(replay).toMatchObject({ status: "success", retryable: false });
    expect(h.runIds).toHaveLength(1);
    expect(h.rpcNames.filter(name => name === "karta_claim_pending_brief")).toHaveLength(1);
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledOnce();
    expect(await rows("karta_brief_claims")).toHaveLength(1);
    expect(JSON.stringify(replay)).not.toContain(SECRET);
  });

  it("releases a live claim after a mock decision when the real logger changes its mode to simulation", async () => {
    await submit(); h.mock = true;
    const result = await cycle();
    expect(result).toMatchObject({ status: "simulated", mock: true });
    expect((await rows("karta_runs"))[0]).toMatchObject({ status: "simulated", mode: "simulation", claude_mock: true });
    expect(await claimFor(h.runIds[0])).toMatchObject({ state: "ready", payload: SECRET });
    expect(h.rpcNames).toEqual(["karta_claim_pending_brief"]);
    expect(h.execute).not.toHaveBeenCalled();
    await expectNoJournalPayload();
  });
});
