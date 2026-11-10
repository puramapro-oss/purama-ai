import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createCycleDelivery } from "../src/queue/delivery-identity.js";

// Actual PostgreSQL statements, single backend. This does not claim native
// multi-session locking or Redis/provider integration.
const owner = "00000000-0000-4000-8000-000000000701";
const parentId = "00000000-0000-4000-8000-000000000702";
const actionId = "00000000-0000-4000-8000-000000000703";
const privateMarker = "PRIVATE_APPROVAL_OUTBOX_SENTINEL";
let db: PGlite;
let addition: string;
const finalize = (status = "executed") => db.query(
  "SELECT purama_ai.karta_finalize_pending_action($1,$2,$3)", [actionId, status, privateMarker],
);
const outbox = () => db.query<Record<string, unknown>>("SELECT * FROM purama_ai.karta_approval_outbox");
const delivery = () => createCycleDelivery({ userId: owner, agentType: "legal", trigger: {
  type: "delegation", source: "approval-resume", payload: { previousRunId: parentId, pendingActionId: actionId, resolution: "executed" },
} }, `approval-resume|${actionId}|executed`);
const claimIntent = async () => (await db.query<{ lease_token: string }>("SELECT * FROM purama_ai.karta_claim_approval_outbox(5)")).rows;
const prepare = async (lease: string | null, fingerprint = delivery().identity.fingerprint) => (await db.query<{ result: string }>(
  "SELECT purama_ai.karta_prepare_approval_outbox($1,$2,$3,$4,$5) AS result",
  [actionId, lease, delivery().identity.executionKey, fingerprint, delivery().identity.legacyKeyPrefix],
)).rows[0].result;
const finish = async (lease: string | null, result: string) => (await db.query<{ result: boolean }>(
  "SELECT purama_ai.karta_finish_approval_outbox($1,$2,$3) AS result", [actionId, lease, result],
)).rows[0].result;
const resolve = async () => {
  await db.query("SELECT purama_ai.karta_claim_pending_action_bounded($1,'approve')", [actionId]);
  await finalize();
};
const health = async () => (await db.query<{ result: { protocol: number; ready: boolean } }>(
  "SELECT purama_ai.karta_approval_outbox_health() AS result",
)).rows[0].result;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
    CREATE SCHEMA purama_ai;
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA purama_ai,auth TO service_role,authenticated,anon;
  `);
  for (const file of ["001_karta_core.sql", "002_karta_global_kill_switch.sql", "005_karta_pending_actions.sql",
    "006_execution_claims.sql", "019_karta_approval_parent_guard.sql", "020_execution_fingerprints.sql",
    "026_pending_action_execution_origin.sql"]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  addition = await readFile(new URL("../migrations/027_approval_continuation_outbox.sql", import.meta.url), "utf8");
  await db.exec(addition);
  await db.exec("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA purama_ai TO service_role;");
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
  await db.exec("INSERT INTO purama_ai.karta_global_state(id,kill_switch) VALUES('global',false) ON CONFLICT(id) DO UPDATE SET kill_switch=false;");
  await db.query("INSERT INTO purama_ai.karta_agent_state(user_id,agent_type,simulation_mode) VALUES($1,'legal',false)", [owner]);
  await db.query(`INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode,status,duration_ms,tools_used)
    VALUES($1,$2,'legal','manual','live','awaiting_approval',1,$3)`,
  [parentId, owner, JSON.stringify([{ tool: "inert", pendingActionId: actionId, success: false, outcome: "pending" }])]);
  await db.query(`INSERT INTO purama_ai.karta_pending_actions(id,user_id,run_id,agent_type,tool_name,tool_params)
    VALUES($1,$2,$3,'legal','inert',$4)`, [actionId, owner, parentId, JSON.stringify({ secret: privateMarker })]);
});

describe("atomic approval continuation outbox", () => {
  it.each(["executed", "rejected"])("keeps a durable minimal %s intent when the process ends after finalization", async status => {
    await db.query("SELECT * FROM purama_ai.karta_claim_pending_action($1,$2)", [actionId, status === "executed" ? "approve" : "reject"]);
    await finalize(status);
    const rows = (await outbox()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pending_action_id: actionId, user_id: owner, parent_run_id: parentId,
      agent_type: "legal", resolution: status, status: "pending", execution_key: null, execution_fingerprint: null });
    expect(JSON.stringify(rows)).not.toContain(privateMarker);
    // A second finalization cannot recreate/replay the approved action.
    await finalize(status);
    expect((await outbox()).rows).toEqual(rows);
  });

  it("rolls back the intent and action together if parent finalization fails", async () => {
    await db.query("SELECT * FROM purama_ai.karta_claim_pending_action($1,'approve')", [actionId]);
    await db.query("UPDATE purama_ai.karta_runs SET tools_used='[]' WHERE id=$1", [parentId]);
    await expect(finalize()).rejects.toThrow("Action missing from parent journal");
    expect((await db.query<{ status: string }>("SELECT status FROM purama_ai.karta_pending_actions WHERE id=$1", [actionId])).rows[0].status).toBe("executing");
    expect((await outbox()).rows).toEqual([]);
  });

  it.each(["failed", "cancelled"])("does not publish a %s action", async status => {
    await db.query("SELECT * FROM purama_ai.karta_claim_pending_action($1,'approve')", [actionId]);
    await finalize(status);
    expect((await outbox()).rows).toEqual([]);
  });

  it("keeps already resolved history untouched when 027 is applied or replayed", async () => {
    await db.exec("DROP TRIGGER karta_capture_approval_continuation ON purama_ai.karta_pending_actions;");
    try { await resolve(); }
    finally { await db.exec(addition); }
    await finalize();
    expect((await outbox()).rows).toEqual([]);
    expect(await health()).toEqual({ protocol: 1, ready: true });
  });

  it("waits for the parent to close without repeatedly claiming pending human decisions", async () => {
    await resolve();
    await db.query("UPDATE purama_ai.karta_runs SET status='awaiting_approval',finished_at=NULL WHERE id=$1", [parentId]);
    expect(await claimIntent()).toEqual([]);
    expect((await outbox()).rows[0].attempts).toBe(0);
    await db.query("UPDATE purama_ai.karta_runs SET status='success',finished_at=now() WHERE id=$1", [parentId]);
    expect(await claimIntent()).toHaveLength(1);
  });

  it("reserves at most one live lease and ignores expired owners", async () => {
    await resolve();
    const first = (await claimIntent())[0].lease_token;
    expect(await claimIntent()).toEqual([]);
    await db.query("UPDATE purama_ai.karta_approval_outbox SET lease_until=now()-interval '1 second'");
    const second = (await claimIntent())[0].lease_token;
    expect(second).not.toBe(first);
    expect(await prepare(first)).toBe("stale");
    expect(await finish(first, "published")).toBe(false);
    expect(await prepare(second)).toBe("ready");
  });

  it("rejects a missing lease instead of binding an unclaimed intent", async () => {
    await resolve();
    expect(await prepare(null)).toBe("stale");
    expect(await finish(null, "retry")).toBe(false);
    expect((await outbox()).rows[0].execution_key).toBeNull();
  });

  it("retains a published intent until an exact SQL receipt and applies retry backoff", async () => {
    await resolve();
    const lease = (await claimIntent())[0].lease_token;
    expect(await prepare(lease)).toBe("ready");
    expect(await finish(lease, "published")).toBe(true);
    expect((await outbox()).rows[0]).toMatchObject({ status: "pending", received_at: null,
      execution_key: delivery().identity.executionKey, execution_fingerprint: delivery().identity.fingerprint });
    expect((await outbox()).rows[0].published_at).not.toBeNull();
    expect(await claimIntent()).toEqual([]);
    await db.query("UPDATE purama_ai.karta_approval_outbox SET next_attempt_at=now()-interval '1 second'");
    const retryLease = (await claimIntent())[0].lease_token;
    expect(await prepare(retryLease)).toBe("ready");
    expect((await outbox()).rows[0].execution_fingerprint).toBe(delivery().identity.fingerprint);
  });

  it("quarantines a changed fingerprint and preserves the first binding", async () => {
    await resolve();
    const lease = (await claimIntent())[0].lease_token;
    expect(await prepare(lease)).toBe("ready");
    expect(await prepare(lease, "0".repeat(64))).toBe("blocked");
    expect((await outbox()).rows[0]).toMatchObject({ status: "blocked", blocked_code: "identity_conflict",
      execution_fingerprint: delivery().identity.fingerprint });
    expect(await claimIntent()).toEqual([]);
  });

  it("refuses a legacy reservation without inventing its original request fingerprint", async () => {
    await resolve();
    await db.query(`INSERT INTO purama_ai.karta_runs(user_id,agent_type,trigger_type,execution_key,status)
      VALUES($1,'legal','delegation',$2,'success')`, [owner, delivery().identity.legacyKeyPrefix + "1"]);
    expect(await prepare((await claimIntent())[0].lease_token)).toBe("blocked");
  });

  it.each(["running", "error", "cancelled", "awaiting_approval", "success"])("records receipt of a %s run without claiming business success", async status => {
    await resolve();
    const receivedId = "00000000-0000-4000-8000-000000000704";
    await db.query(`INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,execution_key,execution_fingerprint,status)
      VALUES($1,$2,'legal','delegation',$3,$4,$5)`, [receivedId, owner, delivery().identity.executionKey, delivery().identity.fingerprint, status]);
    expect(await prepare((await claimIntent())[0].lease_token)).toBe("received");
    const item = (await outbox()).rows[0];
    expect(item).toMatchObject({ status: "received", received_run_id: receivedId, blocked_code: null, lease_token: null });
    expect(item).not.toHaveProperty("success");
    expect(await claimIntent()).toEqual([]);
  });

  it("refuses a current journal whose fingerprint is missing or changed", async () => {
    await resolve();
    await db.query(`INSERT INTO purama_ai.karta_runs(user_id,agent_type,trigger_type,execution_key,status)
      VALUES($1,'legal','delegation',$2,'success')`, [owner, delivery().identity.executionKey]);
    expect(await prepare((await claimIntent())[0].lease_token)).toBe("blocked");
  });

  it("makes retained terminal deliveries explicit and excludes them from automatic polling", async () => {
    await resolve();
    const lease = (await claimIntent())[0].lease_token;
    await prepare(lease);
    expect(await finish(lease, "retained_terminal")).toBe(true);
    expect((await outbox()).rows[0]).toMatchObject({ status: "blocked", blocked_code: "retained_terminal" });
    expect(await claimIntent()).toEqual([]);
  });

  it("protects the minimal immutable payload after binding", async () => {
    await resolve();
    await prepare((await claimIntent())[0].lease_token);
    await expect(db.exec("UPDATE purama_ai.karta_approval_outbox SET agent_type='compta'")).rejects.toThrow("identity is immutable");
    await expect(db.exec("UPDATE purama_ai.karta_approval_outbox SET execution_fingerprint=repeat('0',64)")).rejects.toThrow("identity is immutable");
  });

  it.each(["anon", "authenticated"])("denies %s access to private delivery metadata and relay RPCs", async role => {
    await resolve();
    await db.exec(`SET ROLE ${role};`);
    try {
      await expect(outbox()).rejects.toThrow(/permission denied/);
      await expect(claimIntent()).rejects.toThrow(/permission denied/);
      await expect(db.query("SELECT purama_ai.karta_claim_pending_action_bounded($1,'approve')", [actionId])).rejects.toThrow(/permission denied/);
      await expect(prepare(null)).rejects.toThrow(/permission denied/);
      await expect(finish(null, "retry")).rejects.toThrow(/permission denied/);
      await expect(health()).rejects.toThrow(/permission denied/);
    } finally { await db.exec("RESET ROLE;"); }
  });

  it("exposes read-only protocol readiness to service_role and detects a missing capture trigger", async () => {
    await db.exec("SET ROLE service_role;");
    try { expect(await health()).toEqual({ protocol: 1, ready: true }); }
    finally { await db.exec("RESET ROLE;"); }
    await db.exec("ALTER TABLE purama_ai.karta_pending_actions DISABLE TRIGGER karta_capture_approval_continuation;");
    try { expect((await health()).ready).toBe(false); }
    finally { await db.exec("ALTER TABLE purama_ai.karta_pending_actions ENABLE TRIGGER karta_capture_approval_continuation;"); }
  });

  it("supports actual service-role finalization and bounded relay RPCs", async () => {
    await db.exec("SET ROLE service_role;");
    try {
      await resolve();
      const lease = (await claimIntent())[0].lease_token;
      expect(await prepare(lease)).toBe("ready");
      expect(await finish(lease, "published")).toBe(true);
      const functions = (await db.query<{ proname: string; proconfig: string[] }>(
        `SELECT proname,proconfig FROM pg_catalog.pg_proc WHERE oid IN (
          'purama_ai.karta_claim_pending_action(uuid,text)'::regprocedure,
          'purama_ai.karta_finalize_pending_action(uuid,text,text)'::regprocedure,
          'purama_ai.karta_claim_approval_outbox(integer)'::regprocedure,
          'purama_ai.karta_prepare_approval_outbox(uuid,uuid,text,text,text)'::regprocedure,
          'purama_ai.karta_finish_approval_outbox(uuid,uuid,text)'::regprocedure,
          'purama_ai.karta_claim_pending_action_bounded(uuid,text)'::regprocedure)`,
      )).rows;
      expect(functions).toHaveLength(6);
      for (const fn of functions) expect(fn.proconfig).toContain("lock_timeout=2s");
    } finally { await db.exec("RESET ROLE;"); }
  });

  it("reports not ready if an existing approval RPC loses its SQL lock timeout", async () => {
    await db.exec("ALTER FUNCTION purama_ai.karta_finalize_pending_action(uuid,text,text) RESET lock_timeout;");
    try { expect((await health()).ready).toBe(false); }
    finally { await db.exec("ALTER FUNCTION purama_ai.karta_finalize_pending_action(uuid,text,text) SET lock_timeout='2s';"); }
  });

  it("rejects replay over an incompatible existing table instead of trusting constraint names", async () => {
    const definition = (await db.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='purama_ai.karta_approval_outbox'::regclass AND conname='karta_approval_outbox_identity'`)).rows[0].definition;
    await db.exec("ALTER TABLE purama_ai.karta_approval_outbox DROP CONSTRAINT karta_approval_outbox_identity;");
    await db.exec("ALTER TABLE purama_ai.karta_approval_outbox ADD CONSTRAINT karta_approval_outbox_identity CHECK (true);");
    try { await expect(db.exec(addition)).rejects.toThrow("unknown approval outbox table contract"); }
    finally {
      await db.exec("ROLLBACK;");
      await db.exec("ALTER TABLE purama_ai.karta_approval_outbox DROP CONSTRAINT karta_approval_outbox_identity;");
      await db.exec("ALTER TABLE purama_ai.karta_approval_outbox ADD CONSTRAINT karta_approval_outbox_identity " + definition);
    }
    expect((await health()).ready).toBe(true);
  });

  it("wraps the unchanged pending row contract in one JSONB array without a relation-backed RPC result", async () => {
    const claimed = (await db.query<{ result: Array<Record<string, unknown>> }>(
      "SELECT purama_ai.karta_claim_pending_action_bounded($1,'approve') AS result", [actionId],
    )).rows[0].result;
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: actionId, status: "executing", tool_params: { secret: privateMarker }, execution_trigger: null });
    expect((await db.query<{ result: unknown[] }>(
      "SELECT purama_ai.karta_claim_pending_action_bounded($1,'approve') AS result", [actionId],
    )).rows[0].result).toEqual([]);
    const shapes = (await db.query<{ original: boolean; relay: boolean; wrapper: boolean }>(`SELECT
      (SELECT proretset AND prorettype='purama_ai.karta_pending_actions'::regtype FROM pg_proc
        WHERE oid='purama_ai.karta_claim_pending_action(uuid,text)'::regprocedure) AS original,
      (SELECT proretset AND prorettype='record'::regtype FROM pg_proc
        WHERE oid='purama_ai.karta_claim_approval_outbox(integer)'::regprocedure) AS relay,
      (SELECT NOT proretset AND prorettype='jsonb'::regtype FROM pg_proc
        WHERE oid='purama_ai.karta_claim_pending_action_bounded(uuid,text)'::regprocedure) AS wrapper`)).rows[0];
    expect(shapes).toEqual({ original: true, relay: true, wrapper: true });
  });
});
