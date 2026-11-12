import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { projectPrivateToolResult, type PrivateToolResultPayload } from "../src/engine/private-tool-results.js";
import { simulateQuantumCircuit } from "../src/quantum/simulator.js";
import { parsePrivateToolResult } from "../src/knowledge/private-result-view.js";

// Real migration in a PostgreSQL PGlite backend, with the existing parent DDL.
// This does not substitute for native PostgreSQL multi-session locking tests.
const owner = "00000000-0000-4000-8000-000000000411";
const otherOwner = "00000000-0000-4000-8000-000000000412";
const agent = "00000000-0000-4000-8000-000000000413";
const otherAgent = "00000000-0000-4000-8000-000000000414";
const agentType = `custom:${agent}`;
const sentinel = "PRIVATE_RESULT_SQL_SENTINEL";
const stamp = "2026-11-12T12:00:00.000Z";
let db: PGlite;
const payload = () => projectPrivateToolResult("quantum_simulate", {
  ...simulateQuantumCircuit({ qubits: 2, gates: [{ gate: "H", target: 0 }, { gate: "CX", control: 0, target: 1 }], shots: 10, seed: 1 }), karta_execution_mode: "live",
})!;
const knowledgePayload = (doi = "10.1234/example") => projectPrivateToolResult("knowledge_search", {
  ok: false, status: "partial", evidence: { schema_version: 1, retrieval_id: randomUUID(), scope: "selected_public_sources", content_kind: "metadata_only",
    verification_status: "unverified", source_text_trust: "untrusted_data", page_read_by_karta: false, full_text_retrieved: false,
    requested_language: "fr", selected_sources: ["crossref", "wikidata"], sources: [
      { source: "crossref", status: "ok", result_count: 1, duplicate_results_removed: 0, retrieved_at: stamp },
      { source: "wikidata", status: "timeout", result_count: 0, duplicate_results_removed: 0, retrieved_at: null },
    ] }, results: [{ source: "crossref", native_id: doi, canonical_id: `doi:${doi.toLowerCase()}`, url: `https://doi.org/${doi.toLowerCase().split('/').map(encodeURIComponent).join('/')}`,
    title: sentinel, text: "Metadata only", language: "fr", provider_published_date: null, retrieved_at: stamp,
    metadata_license: null, content_license: null, provider_ranks: [1] }],
})!;
async function role(name: "service_role" | "authenticated" | "anon", userId = owner) {
  await db.exec(`SET ROLE ${name}`);
  await db.query("SELECT set_config('test.user_id',$1,false)", [userId]);
}
async function run(options: { userId?: string; type?: string; mode?: string; status?: string; duration?: number | null; mock?: boolean } = {}) {
  const id = randomUUID();
  await db.query("INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode,status,duration_ms,claude_mock) VALUES($1,$2,$3,'manual',$4,$5,$6,$7)",
    [id, options.userId ?? owner, options.type ?? agentType, options.mode ?? "live", options.status ?? "running", options.duration ?? null, options.mock ?? false]);
  return id;
}
async function pending(runId: string, options: { status?: string; tool?: string; userId?: string; type?: string } = {}) {
  const id = randomUUID();
  await db.query("INSERT INTO purama_ai.karta_pending_actions(id,user_id,agent_type,run_id,tool_name,tool_params,status) VALUES($1,$2,$3,$4,$5,'{}',$6)",
    [id, options.userId ?? owner, options.type ?? agentType, runId, options.tool ?? "quantum_simulate", options.status ?? "executing"]);
  return id;
}
async function store(runId: string, options: { operation?: string; userId?: string; type?: string; data?: unknown; tool?: string } = {}) {
  const data = options.data ?? payload();
  const result = await db.query<{ id: string }>("SELECT purama_ai.karta_store_tool_result($1,$2,$3,$4,$5,$6::jsonb) AS id",
    [options.userId ?? owner, options.type ?? agentType, runId, options.operation ?? `${runId}:0`, options.tool ?? "quantum_simulate", JSON.stringify(data)]);
  return result.rows[0].id;
}
async function finish(runId: string, status = "success") {
  await db.query("UPDATE purama_ai.karta_runs SET status=$2,duration_ms=1,finished_at=now() WHERE id=$1", [runId, status]);
}
const rows = () => db.query<{ id: string; user_id: string; creator_agent_id: string; payload: PrivateToolResultPayload }>("SELECT * FROM purama_ai.karta_tool_results");
const remove = (id: string) => db.query<{ id: string }>("DELETE FROM purama_ai.karta_tool_results WHERE id=$1 RETURNING id", [id]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.user_id',true),'')::uuid $$;
    CREATE SCHEMA purama_ai;
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA purama_ai,auth TO anon,authenticated,service_role;
    CREATE TABLE purama_ai.creator_agents (
      id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
      is_active boolean DEFAULT true, karta_enabled boolean DEFAULT true, tools_enabled text[] DEFAULT '{}'
    );
    ALTER TABLE purama_ai.creator_agents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owner_read ON purama_ai.creator_agents FOR SELECT TO authenticated USING(user_id = auth.uid());
  `);
  for (const file of ["001_karta_core.sql", "005_karta_pending_actions.sql"]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  await db.exec("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA purama_ai TO service_role; GRANT SELECT ON ALL TABLES IN SCHEMA purama_ai TO authenticated;");
  const migration = await readFile(new URL("../migrations/028_private_tool_results.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(migration); // Safe reapplication retains the same policy/grant surface.
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, otherOwner]);
  await db.query("INSERT INTO purama_ai.creator_agents(id,user_id,tools_enabled) VALUES($1,$2,ARRAY['knowledge_search','quantum_simulate']),($3,$4,ARRAY['knowledge_search','quantum_simulate'])", [agent, owner, otherAgent, otherOwner]);
  await role("service_role");
});

describe("private result migration — actual PostgreSQL SQL", () => {
  it("derives ownership and stores a private local simulation without modifying traces", async () => {
    const runId = await run(); const id = await store(runId);
    expect((await rows()).rows).toEqual([expect.objectContaining({ id, user_id: owner, creator_agent_id: agent, payload: payload() })]);
    expect((await db.query("SELECT tools_used,result_summary FROM purama_ai.karta_runs WHERE id=$1", [runId])).rows).toEqual([{ tools_used: [], result_summary: null }]);
  });

  it("preserves partial metadata and citations without upgrading its success status", async () => {
    const runId = await run(); const data = knowledgePayload();
    await store(runId, { data, tool: "knowledge_search" });
    expect((await rows()).rows[0].payload).toEqual(data);
    expect(data.status).toBe("partial"); expect(data.summary).toContain(sentinel);
  });

  it("passes a partial Unicode DOI result from the real projector through SQL into the UI/Edge DTO", async () => {
    const runId = await run(); const data = knowledgePayload("10.1234/" + "文".repeat(500));
    expect(data.sources[0].url.length).toBeGreaterThan(2048);
    const id = await store(runId, { data, tool: "knowledge_search" });
    const row = (await db.query("SELECT id,run_id,creator_agent_id,user_id,tool_name,payload,created_at::text AS created_at FROM purama_ai.karta_tool_results WHERE id=$1", [id])).rows[0];
    const display = parsePrivateToolResult(row, owner, agent);
    expect(display).toMatchObject({ id, payload: { status: "partial", summary: data.summary, sources: data.sources } });
    expect(display!.payload).not.toHaveProperty("details");
    await expect(store(runId, { operation: `${runId}:1`, data: { ...data, status: "complete" }, tool: "knowledge_search" })).rejects.toThrow("Private result unavailable");
  });

  it("reconciles reordered JSONB after closure and never overwrites a divergent result", async () => {
    const runId = await run(); const data = payload(); const id = await store(runId, { data });
    await finish(runId);
    const reordered = Object.fromEntries(Object.entries(data).reverse());
    expect(await store(runId, { data: reordered })).toBe(id);
    await expect(store(runId, { data: { ...data, summary: sentinel } })).rejects.toThrow("Private result unavailable");
    expect((await rows()).rows[0].payload).toEqual(data);
    await expect(store(runId, { operation: `${runId}:1` })).rejects.toThrow("Private result unavailable");
  });

  it.each(["wrong_owner", "wrong_agent", "missing_run", "run_owner", "run_agent", "simulation", "mock", "closed", "closed_running", "operation", "other_run_operation", "disabled", "tool_disabled"])(
    "rejects inconsistent or inactive provenance: %s", async failure => {
      const runId = await run({
        userId: failure === "run_owner" ? otherOwner : owner,
        type: failure === "run_agent" ? `custom:${otherAgent}` : agentType,
        mode: failure === "simulation" ? "simulation" : "live", mock: failure === "mock",
        status: failure === "closed" ? "success" : "running", duration: failure === "closed_running" ? 0 : null,
      });
      if (failure === "disabled") await db.query("UPDATE purama_ai.creator_agents SET karta_enabled=false WHERE id=$1", [agent]);
      if (failure === "tool_disabled") await db.query("UPDATE purama_ai.creator_agents SET tools_enabled=ARRAY['knowledge_search'] WHERE id=$1", [agent]);
      await expect(store(failure === "missing_run" ? randomUUID() : runId, {
        userId: failure === "wrong_owner" ? otherOwner : owner,
        type: failure === "wrong_agent" ? `custom:${otherAgent}` : agentType,
        operation: failure === "operation" ? "not-an-operation" : failure === "other_run_operation" ? `${randomUUID()}:0` : `${runId}:0`,
      })).rejects.toThrow("Private result unavailable");
      expect((await rows()).rows).toHaveLength(0);
    },
  );

  it("stores an executing approved action under its already-closed parent and reconciles after finalization", async () => {
    const runId = await run({ status: "awaiting_approval", duration: 0 }); const operation = await pending(runId);
    const id = await store(runId, { operation });
    await db.query("UPDATE purama_ai.karta_pending_actions SET status='executed' WHERE id=$1", [operation]);
    expect(await store(runId, { operation })).toBe(id);
    expect((await rows()).rows).toHaveLength(1);
  });

  it.each(["pending", "executed", "failed", "rejected", "wrong_run", "wrong_tool", "wrong_owner", "wrong_agent"])(
    "refuses an unexecuting or mismatched approval: %s", async failure => {
      const runId = await run({ status: "awaiting_approval", duration: 0 });
      const operation = await pending(failure === "wrong_run" ? await run() : runId, {
        status: failure.startsWith("wrong_") ? "executing" : failure,
        tool: failure === "wrong_tool" ? "knowledge_search" : "quantum_simulate",
        userId: failure === "wrong_owner" ? otherOwner : owner,
        type: failure === "wrong_agent" ? `custom:${otherAgent}` : agentType,
      });
      await expect(store(runId, { operation })).rejects.toThrow("Private result unavailable");
    },
  );

  it("allows only the current owner to read and delete a finished result", async () => {
    const runId = await run(); const id = await store(runId); await finish(runId);
    await role("authenticated", otherOwner); expect((await rows()).rows).toHaveLength(0); expect((await remove(id)).rows).toHaveLength(0);
    await role("authenticated", owner); expect((await rows()).rows).toHaveLength(1); expect((await remove(id)).rows).toEqual([{ id }]);
    await role("service_role"); await expect(store(runId)).rejects.toThrow("Private result unavailable");
  });

  it("refuses deletion while direct execution can reconcile, and prevents recreation even if a closed run becomes running", async () => {
    const runId = await run(); const id = await store(runId);
    await role("authenticated"); expect((await remove(id)).rows).toHaveLength(0);
    await role("service_role"); expect(await store(runId)).toBe(id); await finish(runId);
    await role("authenticated"); expect((await remove(id)).rows).toEqual([{ id }]);
    await role("service_role"); await db.query("UPDATE purama_ai.karta_runs SET status='running' WHERE id=$1", [runId]);
    await expect(store(runId)).rejects.toThrow("Private result unavailable");
  });

  it("refuses deletion during an approved action, then allows permanent deletion when it finishes", async () => {
    const runId = await run({ status: "awaiting_approval", duration: 0 }); const operation = await pending(runId); const id = await store(runId, { operation });
    await role("authenticated"); expect((await remove(id)).rows).toHaveLength(0);
    await role("service_role"); await db.query("UPDATE purama_ai.karta_pending_actions SET status='executed' WHERE id=$1", [operation]);
    await role("authenticated"); expect((await remove(id)).rows).toEqual([{ id }]);
    await role("service_role"); await expect(store(runId, { operation })).rejects.toThrow("Private result unavailable");
  });

  it("revokes old ownership when the agent owner changes and does not give its historical results to the new owner", async () => {
    const runId = await run(); const id = await store(runId); await finish(runId);
    await db.query("UPDATE purama_ai.creator_agents SET user_id=$1 WHERE id=$2", [otherOwner, agent]);
    await role("authenticated", owner); expect((await rows()).rows).toHaveLength(0); expect((await remove(id)).rows).toHaveLength(0);
    await role("authenticated", otherOwner); expect((await rows()).rows).toHaveLength(0);
    await role("service_role"); await expect(store(runId)).rejects.toThrow("Private result unavailable");
  });

  it.each(["authenticated", "anon"] as const)("denies RPC and writes from %s", async client => {
    const runId = await run(); const id = await store(runId);
    await role(client);
    await expect(store(runId)).rejects.toThrow(/permission denied/);
    await expect(db.query("INSERT INTO purama_ai.karta_tool_results(user_id,creator_agent_id,run_id,operation_id,tool_name,payload) VALUES($1,$2,$3,$4,'quantum_simulate',$5::jsonb)", [owner, agent, runId, `${runId}:1`, JSON.stringify(payload())])).rejects.toThrow(/permission denied/);
    await expect(db.query("UPDATE purama_ai.karta_tool_results SET payload=$1::jsonb WHERE id=$2", [JSON.stringify(payload()), id])).rejects.toThrow(/permission denied/);
    if (client === "anon") await expect(rows()).rejects.toThrow(/permission denied/);
  });

  it("requires service writers to use the protected RPC", async () => {
    const runId = await run(); const id = await store(runId);
    await expect(db.query("INSERT INTO purama_ai.karta_tool_results(user_id,creator_agent_id,run_id,operation_id,tool_name,payload) VALUES($1,$2,$3,$4,'quantum_simulate',$5::jsonb)", [owner, agent, runId, `${runId}:1`, JSON.stringify(payload())])).rejects.toThrow(/permission denied/);
    await expect(db.query("UPDATE purama_ai.karta_tool_results SET operation_id=$1 WHERE id=$2", [`${runId}:1`, id])).rejects.toThrow(/permission denied/);
    await expect(remove(id)).rejects.toThrow(/permission denied/);
  });

  it.each(["unknown_tool", "extra_top", "extra_details", "qpu", "oversized", "null", "array", "wrong_name", "bad_probability", "bad_counts", "bad_citation", "extra_citation", "extra_record"])(
    "rejects non-whitelisted or malformed payload: %s", async failure => {
      const runId = await run(); let data: unknown = payload(); let tool = "quantum_simulate";
      if (failure === "unknown_tool") tool = "send_email";
      if (failure === "extra_top") data = { ...payload(), private_params: sentinel };
      if (failure === "extra_details") data = { ...payload(), details: { ...payload().details, private_params: sentinel } };
      if (failure === "qpu") data = { ...payload(), details: { ...payload().details, physical_quantum_hardware: true } };
      if (failure === "oversized") data = { ...payload(), summary: sentinel.repeat(5000) };
      if (failure === "null") data = "null";
      if (failure === "array") data = [];
      if (failure === "wrong_name") data = { ...payload(), tool_name: "knowledge_search" };
      if (failure === "bad_probability") data = { ...payload(), details: { ...payload().details, probabilities: [0.1, 0, 0, 0.5] } };
      if (failure === "bad_counts") data = { ...payload(), details: { ...payload().details, counts: { "00": 1 } } };
      if (["bad_citation", "extra_citation", "extra_record"].includes(failure)) {
        const value = knowledgePayload(); tool = "knowledge_search";
        if (failure === "bad_citation") value.sources[0].url = "https://attacker.invalid/";
        if (failure === "extra_citation") Object.assign(value.sources[0], { params: sentinel });
        if (failure === "extra_record") Object.assign((value.details.records as object[])[0], { params: sentinel });
        data = value;
      }
      await expect(store(runId, { data, tool })).rejects.toThrow("Private result unavailable");
      expect((await rows()).rows).toHaveLength(0);
    },
  );

  it.each(["account", "agent", "run"])("cascades deletion of its %s", async parent => {
    const runId = await run(); await store(runId);
    await db.exec("RESET ROLE");
    if (parent === "account") await db.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    if (parent === "agent") await db.query("DELETE FROM purama_ai.creator_agents WHERE id=$1", [agent]);
    if (parent === "run") await db.query("DELETE FROM purama_ai.karta_runs WHERE id=$1", [runId]);
    expect((await rows()).rows).toHaveLength(0);
  });
});
