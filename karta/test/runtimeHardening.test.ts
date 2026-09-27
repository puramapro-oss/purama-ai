import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const uid = "00000000-0000-4000-8000-000000000101";
let db: PGlite;

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
  `);
  for (const file of ["001_karta_core.sql", "007_runtime_hardening.sql"]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("TRUNCATE auth.users CASCADE; TRUNCATE purama_ai.karta_daily_counters;");
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [uid]);
  await db.query("INSERT INTO purama_ai.karta_agent_state(user_id,agent_type) VALUES($1,'email')", [uid]);
});

describe("runtime hardening SQL", () => {
  it("ne dépasse jamais la limite du compteur, même avec deux réservations concurrentes à la frontière", async () => {
    await db.query(
      "INSERT INTO purama_ai.karta_daily_counters(user_id,counter_key,counter_day,count) VALUES($1,'gmail_send',DATE '2026-09-27',399)",
      [uid]
    );
    const reserve = () => db.query(
      "SELECT purama_ai.karta_reserve_daily_counter($1,'gmail_send',DATE '2026-09-27',400) AS count",
      [uid]
    );
    const results = await Promise.all([reserve(), reserve()]);
    const granted = results.map(r => (r.rows[0] as { count?: number | null } | undefined)?.count).filter(v => v !== null);
    expect(granted).toEqual([400]);
    const row = await db.query(
      "SELECT count FROM purama_ai.karta_daily_counters WHERE user_id=$1 AND counter_key='gmail_send'",
      [uid]
    );
    expect((row.rows[0] as { count?: number } | undefined)?.count).toBe(400);
  });

  it("empêche un vieux run de remplacer l'état d'un run plus récent", async () => {
    await db.query(
      "SELECT purama_ai.karta_record_run_outcome($1,'email','success','2026-09-27T12:00:00Z')",
      [uid]
    );
    const old = await db.query(
      "SELECT purama_ai.karta_record_run_outcome($1,'email','error','2026-09-27T11:00:00Z') AS updated",
      [uid]
    );
    expect((old.rows[0] as { updated?: boolean } | undefined)?.updated).toBe(false);
    const state = await db.query(
      "SELECT last_run_status,last_run_at FROM purama_ai.karta_agent_state WHERE user_id=$1 AND agent_type='email'",
      [uid]
    );
    expect((state.rows[0] as { last_run_status?: string; last_run_at?: string } | undefined)?.last_run_status).toBe("success");
    const typed = state.rows[0] as { last_run_status?: string; last_run_at?: string } | undefined;
    expect(new Date(typed?.last_run_at as string).toISOString()).toBe("2026-09-27T12:00:00.000Z");
  });

  it("n'expose pas la réservation de quota au rôle client", async () => {
    await db.exec("GRANT USAGE ON SCHEMA purama_ai TO authenticated; SET ROLE authenticated");
    try {
      await expect(
        db.query("SELECT purama_ai.karta_reserve_daily_counter($1,'gmail_send',DATE '2026-09-27',400)", [uid])
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE");
    }
  });
});
