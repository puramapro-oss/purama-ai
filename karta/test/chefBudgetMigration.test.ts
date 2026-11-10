import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { CHEF_ADMISSION_MIGRATIONS } from "./migration-fixtures.js";
import { PGlite } from "@electric-sql/pglite";

describe("CHEF budget migration of existing claims", () => {
  it("refuses an unreserved historical capped claim rather than assuming a missing receipt is zero", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
        CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      `);
      const files = CHEF_ADMISSION_MIGRATIONS;
      for (const file of files) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
      await db.exec(`
        INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-000000000851');
        INSERT INTO purama_ai.chef_missions(id,user_id,brief_id,brief_hash,goal,repo,state,cost_budget_micros)
          VALUES('00000000-0000-4000-8000-000000000852','00000000-0000-4000-8000-000000000851','missing-history',repeat('a',64),'Review','repo','active',100);
        INSERT INTO purama_ai.chef_tasks(id,mission_id,task_key,title,instructions,state,brief_hash,access_mode,verification_profiles,estimated_cost_micros)
          VALUES('00000000-0000-4000-8000-000000000853','00000000-0000-4000-8000-000000000852','old','Old','Review','ready',repeat('a',64),'read',ARRAY['review'],70);
        SELECT purama_ai.chef_heartbeat_worker('old-worker','codex','test','idle','session-old-worker',1,NULL,'repo',NULL,NULL,'{}');
        SELECT id FROM purama_ai.chef_claim_next_task('00000000-0000-4000-8000-000000000852','old-worker','session-old-worker','codex',300);
        SELECT purama_ai.chef_transition_task('00000000-0000-4000-8000-000000000853','old-worker',1,'running');
        SELECT purama_ai.chef_transition_task('00000000-0000-4000-8000-000000000853','old-worker',1,'blocked_external','provider receipt missing');
      `);
      const migration = await readFile(new URL("../migrations/024_chef_claim_budget_reconciliation.sql", import.meta.url), "utf8");
      await expect(db.exec(migration)).rejects.toThrow(/historical capped claims require explicit budget reconciliation/);
      await db.exec("ROLLBACK");
      expect((await db.query("SELECT to_regclass('purama_ai.chef_budget_reservations') AS reservation_table")).rows[0])
        .toEqual({ reservation_table: null });
      expect((await db.query("SELECT cost_used_micros FROM purama_ai.chef_missions")).rows[0]).toEqual({ cost_used_micros: 0 });
      expect((await db.query("SELECT state FROM purama_ai.chef_tasks")).rows[0]).toEqual({ state: "blocked_external" });
    } finally { await db.close(); }
  }, 30_000);

  it("preserves charged historical totals, treats old synthetic zero costs as unknown and is replayable", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
        CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      `);
      const files = CHEF_ADMISSION_MIGRATIONS;
      for (const file of files) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
      const user = "00000000-0000-4000-8000-000000000831";
      const mission = "00000000-0000-4000-8000-000000000832";
      await db.query("INSERT INTO auth.users(id) VALUES($1)", [user]);
      await db.query(`INSERT INTO purama_ai.chef_missions(id,user_id,brief_id,brief_hash,goal,repo,state,max_parallel,token_budget,cost_budget_micros)
        VALUES($1,$2,'legacy-budget',$3,'Review','repo','active',4,100,100)`, [mission, user, "a".repeat(64)]);
      const claims: Array<{ id: string; worker: string; tokens: number; cost: number }> = [];
      for (const [worker, tokens, cost] of [["legacy-zero", 10, 0], ["legacy-known", 15, 7]] as const) {
        await db.query(`INSERT INTO purama_ai.chef_tasks(mission_id,task_key,title,instructions,state,brief_hash,access_mode,verification_profiles,estimated_tokens,estimated_cost_micros)
          VALUES($1,$2,$2,'Review','ready',$3,'read',ARRAY['review'],40,40)`, [mission, worker, "a".repeat(64)]);
        await db.query("SELECT purama_ai.chef_heartbeat_worker($1,'codex','test','idle',$2,1,NULL,'repo',NULL,NULL,'{}')", [worker, `session-${worker}`]);
        const c = (await db.query<{ id: string }>("SELECT id FROM purama_ai.chef_claim_next_task($1,$2,$3,'codex',300)", [mission, worker, `session-${worker}`])).rows[0];
        claims.push({ id: c.id, worker, tokens, cost });
        await db.query("SELECT purama_ai.chef_record_usage($1,$2,$3,$4,'codex','test',$5,0,0,$6)",
          [`chef-usage|${c.id}|1|1|test|${tokens}|0`, mission, c.id, worker, tokens, cost]);
      }
      const migration = await readFile(new URL("../migrations/024_chef_claim_budget_reconciliation.sql", import.meta.url), "utf8");
      await db.exec(migration);
      expect((await db.query("SELECT worker_id,actual_input_tokens,actual_cost_micros FROM purama_ai.chef_budget_reservations ORDER BY worker_id")).rows)
        .toEqual([
          { worker_id: "legacy-known", actual_input_tokens: 15, actual_cost_micros: 7 },
          { worker_id: "legacy-zero", actual_input_tokens: 10, actual_cost_micros: null },
        ]);
      const c = claims[0];
      expect((await db.query<{ ok: boolean }>("SELECT purama_ai.chef_record_claim_usage($4,$1,$2,$3,'codex','test',10,0,0,5,1,1) AS ok",
        [mission, c.id, c.worker, `chef-usage|${c.id}|1|1|late-final`])).rows[0].ok).toBe(true);
      await db.exec(migration);
      expect((await db.query("SELECT tokens_used,cost_used_micros FROM purama_ai.chef_missions WHERE id=$1", [mission])).rows[0])
        .toEqual({ tokens_used: 25, cost_used_micros: 12 });
      expect((await db.query("SELECT actual_cost_micros FROM purama_ai.chef_budget_reservations WHERE task_id=$1", [c.id])).rows[0])
        .toEqual({ actual_cost_micros: 5 });
      expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_budget_reservations")).rows[0]).toEqual({ n: 2 });
    } finally { await db.close(); }
  }, 30_000);

  it("rejects mixed historical known and ambiguous cost receipts without changing charged totals", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
        CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      `);
      const files = CHEF_ADMISSION_MIGRATIONS;
      for (const file of files) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
      await db.exec(`
        INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-000000000841');
        INSERT INTO purama_ai.chef_missions(id,user_id,brief_id,brief_hash,goal,repo,state,max_parallel,token_budget,cost_budget_micros)
          VALUES('00000000-0000-4000-8000-000000000842','00000000-0000-4000-8000-000000000841','mixed-legacy',repeat('a',64),'Review','repo','active',4,100,100);
        INSERT INTO purama_ai.chef_tasks(id,mission_id,task_key,title,instructions,state,brief_hash,access_mode,verification_profiles,estimated_tokens,estimated_cost_micros)
          VALUES('00000000-0000-4000-8000-000000000843','00000000-0000-4000-8000-000000000842','mixed','Mixed','Review','ready',repeat('a',64),'read',ARRAY['review'],40,40);
        SELECT purama_ai.chef_heartbeat_worker('mixed-worker','codex','test','idle','session-mixed-worker',1,NULL,'repo',NULL,NULL,'{}');
        SELECT id FROM purama_ai.chef_claim_next_task('00000000-0000-4000-8000-000000000842','mixed-worker','session-mixed-worker','codex',300);
        SELECT purama_ai.chef_record_usage('chef-usage|00000000-0000-4000-8000-000000000843|1|1|test-known|10|0','00000000-0000-4000-8000-000000000842','00000000-0000-4000-8000-000000000843','mixed-worker','codex','test-known',10,0,0,7);
        SELECT purama_ai.chef_record_usage('chef-usage|00000000-0000-4000-8000-000000000843|1|1|test-unknown|0|0','00000000-0000-4000-8000-000000000842','00000000-0000-4000-8000-000000000843','mixed-worker','codex','test-unknown',0,0,0,0);
      `);
      const migration = await readFile(new URL("../migrations/024_chef_claim_budget_reconciliation.sql", import.meta.url), "utf8");
      await expect(db.exec(migration)).rejects.toThrow(/multiple historical receipts/);
      await db.exec("ROLLBACK");
      expect((await db.query("SELECT to_regclass('purama_ai.chef_budget_reservations') AS reservation_table")).rows[0])
        .toEqual({ reservation_table: null });
      expect((await db.query("SELECT tokens_used,cost_used_micros FROM purama_ai.chef_missions WHERE id='00000000-0000-4000-8000-000000000842'")).rows[0])
        .toEqual({ tokens_used: 10, cost_used_micros: 7 });
      expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_usage_events")).rows[0]).toEqual({ n: 2 });
    } finally { await db.close(); }
  }, 30_000);
});
