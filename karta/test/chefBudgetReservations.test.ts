import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { hashChefBrief, normalizeChefBrief, type ChefBrief, type ChefBriefTask } from "../src/chef/brief.js";

const userId = "00000000-0000-4000-8000-000000000801";
let db: PGlite;
let sequence = 0;

interface Claim {
  id: string;
  mission_id: string;
  attempt: number;
  fencing_token: number;
  lease_owner: string;
  task_key: string;
}
interface Metrics { input?: number | null; output?: number | null; cached?: number | null; cost?: number | null }

function task(key: string, extra: Partial<ChefBriefTask> = {}): ChefBriefTask {
  return {
    key, title: key, instructions: `Review ${key}`, accessMode: "read", provider: "codex",
    requirementKeys: ["R1"], verificationProfiles: ["review"], ...extra,
  };
}
function brief(tasks: ChefBriefTask[]): ChefBrief {
  return {
    briefId: `budget-${++sequence}`, version: 1, goal: "Review", repo: "budget-repo",
    requirements: [{ key: "R1", description: "Reviewed", critical: false }], tasks,
  };
}
async function create(tasks: ChefBriefTask[], limits: { tokens?: number; cost?: number } = {}) {
  const value = normalizeChefBrief(brief(tasks));
  const result = await db.query<{ id: string }>(
    "SELECT purama_ai.chef_create_mission($1,$2::jsonb,$3,4,$4,$5) AS id",
    [userId, JSON.stringify(value), hashChefBrief(value), limits.tokens ?? null, limits.cost ?? null]
  );
  return result.rows[0].id;
}
async function heartbeat(worker: string) {
  await db.query(
    "SELECT purama_ai.chef_heartbeat_worker($1,'codex','test','idle',$2,1,NULL,'budget-repo',NULL,NULL,'{}')",
    [worker, `session-${worker}-0001`]
  );
}
async function claim(mission: string, worker: string): Promise<Claim | undefined> {
  return (await db.query<Claim>(
    "SELECT * FROM purama_ai.chef_claim_next_task($1,$2,$3,'codex',300)",
    [mission, worker, `session-${worker}-0001`]
  )).rows[0];
}
async function settle(value: Claim, key: string, metrics: Metrics = {}, override: Partial<Claim> = {}) {
  const c = { ...value, ...override };
  const result = await db.query<{ ready: boolean }>(
    "SELECT purama_ai.chef_record_claim_usage($1,$2,$3,$4,'codex','test',$5,$6,$7,$8,$9,$10) AS ready",
    [key, c.mission_id, c.id, c.lease_owner, metrics.input ?? null, metrics.output ?? null,
      metrics.cached ?? null, metrics.cost ?? null, c.attempt, c.fencing_token]
  );
  return result.rows[0].ready;
}
async function totals(mission: string) {
  return (await db.query<{ tokens_used: number; cost_used_micros: number; state: string }>(
    "SELECT tokens_used,cost_used_micros,state FROM purama_ai.chef_missions WHERE id=$1", [mission]
  )).rows[0];
}
async function transition(c: Claim, target: string) {
  return (await db.query<{ ok: boolean }>(
    "SELECT purama_ai.chef_transition_task($1,$2,$3,$4,NULL,NULL) AS ok",
    [c.id, c.lease_owner, c.fencing_token, target]
  )).rows[0].ok;
}
async function prepareEvidence(c: Claim) {
  expect(await transition(c, "running")).toBe(true);
  expect(await transition(c, "verifying")).toBe(true);
  await db.query(
    "INSERT INTO purama_ai.chef_evidence(task_id,kind,payload,attempt,fencing_token,worker_id) VALUES($1,'review','{\"ok\":true}',$2,$3,$4)",
    [c.id, c.attempt, c.fencing_token, c.lease_owner]
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE SCHEMA purama_ai;
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA purama_ai TO service_role;
  `);
  const files = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter(file => /^0(0[89]|1[0-7]|2[1-4])_/.test(file)).sort();
  for (const file of files) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE purama_ai.chef_process_quarantines,purama_ai.chef_workers,purama_ai.chef_missions,auth.users CASCADE;");
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [userId]);
});

describe("CHEF attempt-bound admission budgets", () => {
  it("persists optional estimates and preserves the difference between absent and zero", async () => {
    const mission = await create([
      task("unknown"), task("zero", { estimatedTokens: 0, estimatedCostMicros: 0 }),
      task("known", { estimatedTokens: 60, estimatedCostMicros: 70 }),
    ]);
    expect((await db.query("SELECT task_key,estimated_tokens,estimated_cost_micros FROM purama_ai.chef_tasks WHERE mission_id=$1 ORDER BY task_key", [mission])).rows)
      .toEqual([
        { task_key: "known", estimated_tokens: 60, estimated_cost_micros: 70 },
        { task_key: "unknown", estimated_tokens: null, estimated_cost_micros: null },
        { task_key: "zero", estimated_tokens: 0, estimated_cost_micros: 0 },
      ]);
  });

  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "60"])(
    "rejects an invalid estimate in the canonical TypeScript brief: %s", invalid => {
      for (const key of ["estimatedTokens", "estimatedCostMicros"] as const) {
        const value = brief([task("A", { [key]: invalid } as Partial<ChefBriefTask>)]);
        expect(() => normalizeChefBrief(value)).toThrow(/estimated/);
      }
    }
  );

  it.each([-1, 0.1, 9007199254740992, null, "60"])("rejects an invalid estimate through direct SQL ingestion: %s", async invalid => {
    const value = brief([task("A")]);
    Object.assign(value.tasks[0], { estimatedCostMicros: invalid });
    await expect(db.query("SELECT purama_ai.chef_create_mission($1,$2::jsonb,$3,4,NULL,100)",
      [userId, JSON.stringify(value), "a".repeat(64)])).rejects.toThrow(/estimate/);
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_missions")).rows[0]).toEqual({ n: 0 });
  });

  it.each([{ tokens: 0 }, { cost: 0 }, { tokens: 100, cost: 100 }])(
    "refuses unknown estimates for capped dimensions: %j", async limits => {
      await expect(create([task("A")], limits)).rejects.toThrow(/requires estimated/);
      expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_budget_reservations")).rows[0]).toEqual({ n: 0 });
    }
  );

  it("allows an explicitly known zero envelope at a zero cap", async () => {
    const mission = await create([task("A", { estimatedTokens: 0, estimatedCostMicros: 0 })], { tokens: 0, cost: 0 });
    await heartbeat("zero-worker");
    const c = (await claim(mission, "zero-worker"))!;
    expect(c).toBeDefined();
    expect(await settle(c, "zero-receipt", { input: 0, output: 0, cached: 0, cost: 0 })).toBe(true);
    await prepareEvidence(c);
    expect(await transition(c, "verified_done")).toBe(true);
  });

  it("requires estimates only for the limited dimensions and keeps other unknowns explicit", async () => {
    const mission = await create([task("A", { estimatedCostMicros: 0 })], { cost: 0 });
    await heartbeat("cost-worker");
    const c = (await claim(mission, "cost-worker"))!;
    expect(c).toBeDefined();
    expect(await settle(c, "cost-only-receipt", { cost: 0 })).toBe(true);
    expect((await db.query("SELECT actual_input_tokens,actual_cost_micros FROM purama_ai.chef_budget_reservations WHERE task_id=$1", [c.id])).rows[0])
      .toEqual({ actual_input_tokens: null, actual_cost_micros: 0 });
  });

  it("does not admit 60 + 60 under a shared cap of 100, then reuses the genuinely released remainder", async () => {
    const mission = await create([
      task("A", { priority: 2, estimatedTokens: 60, estimatedCostMicros: 60 }),
      task("B", { priority: 1, estimatedTokens: 60, estimatedCostMicros: 60 }),
    ], { tokens: 100, cost: 100 });
    await heartbeat("one"); await heartbeat("two");
    const first = (await claim(mission, "one"))!;
    expect(first).toBeDefined();
    expect(await claim(mission, "two")).toBeUndefined();
    expect((await totals(mission)).state).toBe("active");
    expect(await settle(first, "first-final-receipt", { input: 20, output: 0, cost: 20 })).toBe(true);
    expect(await claim(mission, "two")).toMatchObject({ task_key: "B" });
    expect(await totals(mission)).toMatchObject({ tokens_used: 20, cost_used_micros: 20 });
  });

  it("settles each dimension once, including retries with another event key", async () => {
    const mission = await create([task("A", { estimatedTokens: 60, estimatedCostMicros: 60 })], { tokens: 100, cost: 100 });
    await heartbeat("receipt-worker");
    const c = (await claim(mission, "receipt-worker"))!;
    const values = { input: 15, output: 5, cached: 2, cost: 30 };
    expect(await settle(c, "receipt-stable-key", values)).toBe(true);
    expect(await settle(c, "receipt-stable-key", values)).toBe(true);
    expect(await settle(c, "receipt-another-key", values)).toBe(true);
    expect(await totals(mission)).toMatchObject({ tokens_used: 20, cost_used_micros: 30 });
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_usage_events")).rows[0]).toEqual({ n: 2 });
    await expect(settle(c, "receipt-conflicting", { ...values, cost: 31 })).rejects.toThrow(/Conflicting final usage/);
    await expect(settle(c, "receipt-stable-key", { ...values, cached: null })).rejects.toThrow(/event key reused/);
    expect(await totals(mission)).toMatchObject({ tokens_used: 20, cost_used_micros: 30 });
  });

  it("holds an unknown cost after a partial receipt and a blocked attempt, then accepts a cost-only reconciliation", async () => {
    const mission = await create([
      task("A", { priority: 2, estimatedTokens: 60, estimatedCostMicros: 60 }),
      task("B", { priority: 1, estimatedTokens: 10, estimatedCostMicros: 10 }),
    ], { tokens: 100, cost: 100 });
    await heartbeat("partial"); await heartbeat("unrelated");
    const c = (await claim(mission, "partial"))!;
    expect(await settle(c, "tokens-only-receipt", { input: 20, output: 10 })).toBe(false);
    expect(await transition(c, "blocked_external")).toBe(true);
    expect(await claim(mission, "unrelated")).toBeUndefined();
    expect((await db.query("SELECT cost_micros FROM purama_ai.chef_usage_events WHERE event_key='tokens-only-receipt'")).rows[0])
      .toEqual({ cost_micros: null });
    expect(await settle(c, "later-cost-receipt", { cost: 15 })).toBe(true);
    expect(await totals(mission)).toMatchObject({ tokens_used: 30, cost_used_micros: 15 });
    expect(await claim(mission, "unrelated")).toMatchObject({ task_key: "B" });
  });

  it("keeps a crashed claim reserved and never clears process quarantine with a late receipt", async () => {
    const mission = await create([task("A", { estimatedTokens: 60, estimatedCostMicros: 60 })], { tokens: 100, cost: 100 });
    await heartbeat("old-worker"); await heartbeat("new-worker");
    const old = (await claim(mission, "old-worker"))!;
    await db.query("UPDATE purama_ai.chef_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [old.id]);
    await db.query("SELECT purama_ai.chef_requeue_expired_tasks($1)", [mission]);
    expect(await claim(mission, "new-worker")).toBeUndefined();
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_budget_reservations")).rows[0]).toEqual({ n: 1 });
    await expect(settle(old, "wrong-claim-receipt", { input: 1, output: 1, cost: 2 }, { fencing_token: old.fencing_token + 1 }))
      .rejects.toThrow(/claim does not match/);
    expect(await settle(old, "late-old-receipt", { input: 10, output: 0, cost: 10 })).toBe(true);
    // A final provider receipt proves consumption, never process death.
    // PR27's durable quarantine remains authoritative after reconciliation.
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_process_quarantines")).rows[0]).toEqual({ n: 1 });
    await db.query("SELECT purama_ai.chef_unblock_task($1,'receipt restored')", [old.id]);
    await expect(claim(mission, "new-worker")).rejects.toThrow(/quarantine/);
    expect(await settle(old, "late-old-receipt", { input: 10, output: 0, cost: 10 })).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_budget_reservations")).rows[0]).toEqual({ n: 1 });
    expect(await totals(mission)).toMatchObject({ tokens_used: 10, cost_used_micros: 10 });
  });

  it("does not release the reservation through manual unblock/decrement of the attempt", async () => {
    const mission = await create([task("A", { estimatedTokens: 30, estimatedCostMicros: 30 })], { tokens: 100, cost: 100 });
    await heartbeat("blocked-worker"); await heartbeat("resume-worker");
    const c = (await claim(mission, "blocked-worker"))!;
    expect(await transition(c, "blocked_external")).toBe(true);
    await db.query("SELECT purama_ai.chef_unblock_task($1,'dependency restored')", [c.id]);
    expect(await claim(mission, "resume-worker")).toBeUndefined();
    expect(await settle(c, "restored-receipt", { input: 0, output: 0, cost: 0 })).toBe(true);
    const next = (await claim(mission, "resume-worker"))!;
    expect(next.attempt).toBe(c.attempt);
    expect(next.fencing_token).toBeGreaterThan(c.fencing_token);
    await expect(settle(next, "wrong-worker-receipt", { input: 1, output: 1, cost: 2 }, { lease_owner: c.lease_owner }))
      .rejects.toThrow(/claim does not match/);
    expect(await settle(c, "restored-receipt", { input: 0, output: 0, cost: 0 })).toBe(true);
    expect((await db.query("SELECT actual_cost_micros FROM purama_ai.chef_budget_reservations WHERE task_id=$1 AND fencing_token=$2", [next.id, next.fencing_token])).rows[0])
      .toEqual({ actual_cost_micros: null });
  });

  it("enforces accounting in SQL completion independently of the application", async () => {
    const mission = await create([task("A", { estimatedTokens: 30, estimatedCostMicros: 30 })], { tokens: 100, cost: 100 });
    await heartbeat("completion-worker");
    const c = (await claim(mission, "completion-worker"))!;
    await prepareEvidence(c);
    await expect(transition(c, "verified_done")).rejects.toThrow(/usage is unknown/);
    await expect(db.query("UPDATE purama_ai.chef_tasks SET state='verified_done' WHERE id=$1", [c.id])).rejects.toThrow(/usage is unknown/);
    expect(await settle(c, "completion-receipt", { input: 10, output: 5, cost: 15 })).toBe(true);
    expect(await transition(c, "verified_done")).toBe(true);
  });

  it("preserves unlimited missions without misreporting their unobserved usage as zero", async () => {
    const mission = await create([task("A")]);
    await heartbeat("unlimited-worker");
    const c = (await claim(mission, "unlimited-worker"))!;
    expect(await settle(c, "unlimited-unknown-receipt")).toBe(true);
    expect((await db.query("SELECT input_tokens,output_tokens,cost_micros FROM purama_ai.chef_usage_events")).rows[0])
      .toEqual({ input_tokens: null, output_tokens: null, cost_micros: null });
    await prepareEvidence(c);
    expect(await transition(c, "verified_done")).toBe(true);
  });

  it("pauses further admission when the actual bill exceeds the reserved envelope and cap", async () => {
    const mission = await create([
      task("A", { priority: 2, estimatedTokens: 60, estimatedCostMicros: 60 }),
      task("B", { priority: 1, estimatedTokens: 1, estimatedCostMicros: 1 }),
    ], { tokens: 100, cost: 100 });
    await heartbeat("overrun-worker"); await heartbeat("waiting-worker");
    const c = (await claim(mission, "overrun-worker"))!;
    expect(await settle(c, "actual-overrun-receipt", { input: 110, output: 0, cost: 110 })).toBe(true);
    expect(await totals(mission)).toMatchObject({ tokens_used: 110, cost_used_micros: 110, state: "paused" });
    expect(await claim(mission, "waiting-worker")).toBeUndefined();
  });

  it("prevents the old unbound usage RPC bypassing new reservations", async () => {
    for (const limits of [{ cost: 100 }, {}]) {
      const mission = await create([task("A", { estimatedCostMicros: 60 })], limits);
      const worker = `legacy-${sequence}`;
      await heartbeat(worker);
      const c = (await claim(mission, worker))!;
      await expect(db.query("SELECT purama_ai.chef_record_usage('legacy-usage-receipt',$1,$2,$3,'codex','test',0,0,0,0)",
        [mission, c.id, worker])).rejects.toThrow(/Claim-bound/);
    }
  });

  it("keeps server-only settlement usable by service_role and inaccessible to authenticated/anon", async () => {
    const mission = await create([task("A", { estimatedTokens: 10, estimatedCostMicros: 10 })], { tokens: 100, cost: 100 });
    await heartbeat("role-worker");
    const c = (await claim(mission, "role-worker"))!;
    for (const role of ["authenticated", "anon"]) {
      await db.exec(`GRANT USAGE ON SCHEMA purama_ai TO ${role}; SET ROLE ${role};`);
      try {
        await expect(settle(c, `forbidden-${role}`, { input: 0, output: 0, cost: 0 })).rejects.toThrow(/permission denied/);
        await expect(db.query("SELECT * FROM purama_ai.chef_budget_reservations")).rejects.toThrow(/permission denied/);
      } finally { await db.exec("RESET ROLE"); }
    }
    await db.exec("SET ROLE service_role");
    try {
      expect(await settle(c, "server-role-receipt", { input: 1, output: 2, cost: 3 })).toBe(true);
      await expect(db.query("UPDATE purama_ai.chef_budget_reservations SET reserved_cost_micros=0 WHERE task_id=$1", [c.id]))
        .rejects.toThrow(/permission denied/);
      await expect(db.query("UPDATE purama_ai.chef_budget_reservations SET actual_cost_micros=0 WHERE task_id=$1", [c.id]))
        .rejects.toThrow(/cannot be rewritten/);
      await expect(db.query("DELETE FROM purama_ai.chef_budget_reservations WHERE task_id=$1", [c.id])).rejects.toThrow(/permission denied/);
    } finally { await db.exec("RESET ROLE"); }
  });
});
