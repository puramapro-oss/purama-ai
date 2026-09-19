import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const h = vi.hoisted(() => ({ db: null as any, execute: vi.fn(), failFinalize: false, stopped: false }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc: async (name: string, p: any) => {
  if (h.failFinalize && name.includes("finalize")) return { data: null, error: { message: "offline" } };
  try {
    const args = name.includes("claim") ? [p.p_id, p.p_decision] : [p.p_id, p.p_status, p.p_summary];
    const sql = "SELECT * FROM purama_ai." + name + "(" + args.map((_: unknown, i: number) => "$" + (i+1)).join(",") + ")";
    return { data: (await h.db.query(sql, args)).rows, error: null };
  } catch { return { data: null, error: { message: "database rejected operation" } }; }
} } }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => h.stopped }));
vi.mock("../src/engine/autonomy.js", () => ({ loadAgentState: async () => ({ simulationMode: false }), isRunnable: () => ({ ok: true }) }));
vi.mock("../src/engine/resolveDefinition.js", () => ({ resolveAgentDefinition: async () => ({ tools: [{ name: "act", execute: h.execute }] }) }));
const { resolvePendingAction } = await import("../src/engine/approval.js");
const uid = "00000000-0000-4000-8000-000000000001";
const rid = "00000000-0000-4000-8000-000000000002";
const aid = "00000000-0000-4000-8000-000000000003";
const bid = "00000000-0000-4000-8000-000000000004";
beforeAll(async () => {
  h.db = new PGlite();
  await h.db.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'; CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  for (const file of ["001_karta_core.sql","002_karta_global_kill_switch.sql","005_karta_pending_actions.sql","006_execution_claims.sql"])
    await h.db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
});
afterAll(async () => { await h.db?.close(); });
beforeEach(async () => {
  vi.clearAllMocks(); h.failFinalize = false; h.stopped = false; h.execute.mockResolvedValue({ ok: true });
  await h.db.exec("TRUNCATE auth.users CASCADE; INSERT INTO purama_ai.karta_global_state(id,kill_switch) VALUES('global',false) ON CONFLICT(id) DO UPDATE SET kill_switch=false;");
  await h.db.query("INSERT INTO auth.users VALUES ($1)", [uid]);
  await h.db.query("INSERT INTO purama_ai.karta_agent_state(user_id,agent_type,simulation_mode) VALUES($1,'compta',false)", [uid]);
  await h.db.query("INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,status,tools_used) VALUES($1,$2,'compta','manual','awaiting_approval',$3)", [rid,uid,JSON.stringify([{tool:"act",success:false,outcome:"pending",pendingActionId:aid}])]);
  await h.db.query("INSERT INTO purama_ai.karta_pending_actions(id,user_id,run_id,agent_type,tool_name,tool_params) VALUES($1,$2,$3,'compta','act','{}')", [aid,uid,rid]);
});
async function state() { return (await h.db.query("SELECT status,tools_used FROM purama_ai.karta_runs WHERE id=$1",[rid])).rows[0]; }
describe("approval with real PostgreSQL SQL in PGlite (single backend)", () => {
  it("executes and atomically patches the parent", async () => { expect((await resolvePendingAction(aid,"approve")).ok).toBe(true); expect((await state()).status).toBe("success"); expect(h.execute).toHaveBeenCalledWith({}, expect.objectContaining({userId:uid,operationId:aid})); });
  it.each([new Error("provider failed"), {ok:false}])("reports provider failure to the caller", async failure => { if(failure instanceof Error) h.execute.mockRejectedValue(failure); else h.execute.mockResolvedValue(failure); expect((await resolvePendingAction(aid,"approve")).ok).toBe(false); expect((await state()).status).toBe("error"); });
  it("rejects without claiming successful execution", async () => { expect((await resolvePendingAction(aid,"reject")).ok).toBe(true); expect(h.execute).not.toHaveBeenCalled(); expect((await state()).status).toBe("skipped"); });
  it("does not repeat a resolved action", async () => { await resolvePendingAction(aid,"approve"); expect((await resolvePendingAction(aid,"approve")).ok).toBe(false); expect(h.execute).toHaveBeenCalledOnce(); });
  it("claims at most once for concurrent callers", async () => { const results = await Promise.all(Array.from({length:8}, () => resolvePendingAction(aid,"approve"))); expect(results.filter(r=>r.ok)).toHaveLength(1); expect(h.execute).toHaveBeenCalledOnce(); });
  it("does not repeat an effect after failed finalization", async () => { h.failFinalize=true; expect((await resolvePendingAction(aid,"approve")).ok).toBe(false); h.failFinalize=false; expect((await resolvePendingAction(aid,"approve")).ok).toBe(false); expect(h.execute).toHaveBeenCalledOnce(); expect((await h.db.query("SELECT status FROM purama_ai.karta_pending_actions")).rows[0].status).toBe("executing"); });
  it("keeps waiting when another approval is outstanding", async () => { await h.db.query("INSERT INTO purama_ai.karta_pending_actions(id,user_id,run_id,agent_type,tool_name,tool_params) VALUES($1,$2,$3,'compta','act','{}')",[bid,uid,rid]); await resolvePendingAction(aid,"approve"); expect((await state()).status).toBe("awaiting_approval"); });
  it("refuses an approval while the cycle is preparing its journal", async () => { await h.db.query("UPDATE purama_ai.karta_runs SET status='running'"); expect((await resolvePendingAction(aid,"approve")).ok).toBe(false); expect(h.execute).not.toHaveBeenCalled(); });
  it("refuses execution when the database global stop is active", async () => { await h.db.exec("UPDATE purama_ai.karta_global_state SET kill_switch=true"); expect((await resolvePendingAction(aid,"approve")).ok).toBe(false); expect(h.execute).not.toHaveBeenCalled(); });
  it("observes revocation after claiming", async () => { h.stopped=true; expect((await resolvePendingAction(aid,"approve")).ok).toBe(false); expect(h.execute).not.toHaveBeenCalled(); });
  it("rolls back finalization if the parent's action entry is absent", async () => { await h.db.exec("UPDATE purama_ai.karta_runs SET tools_used='[]'"); expect((await resolvePendingAction(aid,"approve")).ok).toBe(false); expect((await h.db.query("SELECT status FROM purama_ai.karta_pending_actions")).rows[0].status).toBe("executing"); });
  it("denies RPC access to a client database role", async () => { await h.db.exec("GRANT USAGE ON SCHEMA purama_ai TO authenticated; SET ROLE authenticated"); try { await expect(h.db.query("SELECT * FROM purama_ai.karta_claim_pending_action($1,'approve')",[aid])).rejects.toThrow(/permission denied/); } finally { await h.db.exec("RESET ROLE"); } });
  it("enforces unique durable delivery keys", async () => { await h.db.query("UPDATE purama_ai.karta_runs SET execution_key='delivery'"); await expect(h.db.query("INSERT INTO purama_ai.karta_runs(user_id,agent_type,trigger_type,execution_key) VALUES($1,'compta','manual','delivery')",[uid])).rejects.toThrow(/duplicate key/); });
});
