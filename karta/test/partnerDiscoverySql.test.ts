import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const historical = readFileSync(new URL("../../supabase/migrations/20260406230000_partner_agent.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../supabase/migrations/20261124050000_partner_discovery_evidence.sql", import.meta.url), "utf8");
const user = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
type Row = Record<string, unknown>;
let db: PGlite;
const candidate = (email: string | null = "regie@journal.example", role = "commercial"): Row => ({
  name: "Journal", email, website: "https://journal.example/", type: "media", contact_role: role,
  ai_score: 75, followers_count: null, social_links: {},
  contact_evidence: email ? { source_url: "https://journal.example/contact", observed_at: "2026-11-24T12:00:00Z",
    verification: "observed_in_search_result", email, excerpt: `Contact commercial : ${email}` } : {},
});
async function importRows(rows: Row[], owner = user): Promise<Row> {
  const result = await db.query<{ value: Row }>("SELECT purama_ai.partner_discovery_import($1,$2::jsonb) AS value", [owner, JSON.stringify(rows)]);
  return result.rows[0].value;
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    INSERT INTO auth.users VALUES ('${user}'),('${other}');`);
  await db.exec(historical);
  await db.exec(migration);
});
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE purama_ai.partner_prospects,purama_ai.partner_agent_config CASCADE");
  await db.query("INSERT INTO purama_ai.partner_agent_config(user_id) VALUES ($1),($2)", [user,other]);
});
afterAll(async () => { await db?.close(); });

describe("discovery import — actual SQL migration", () => {
  it("preserves historical prospects and remains idempotent on migration rerun", async () => {
    await db.query("INSERT INTO purama_ai.partner_prospects(user_id,name,email,status) VALUES ($1,'Historical',' REGIE@journal.example ','rejected')", [user]);
    await db.exec(migration);
    expect(await importRows([candidate()])).toMatchObject({ inserted: 0, skipped: 1 });
    expect((await db.query("SELECT name,email,status,contact_role,contact_evidence FROM purama_ai.partner_prospects")).rows)
      .toEqual([{ name: "Historical", email: " REGIE@journal.example ", status: "rejected", contact_role: "unknown", contact_evidence: {} }]);
  });
  it("normalizes new emails and counts only actual inserted rows", async () => {
    const first = candidate(" REGIE@JOURNAL.EXAMPLE ");
    first.contact_evidence = { ...(first.contact_evidence as Row), email: "regie@journal.example", excerpt: "REGIE@JOURNAL.EXAMPLE" };
    expect(await importRows([first,candidate()])).toMatchObject({ inserted: 1, skipped: 1 });
    expect((await db.query("SELECT email,status,found_by_ai FROM purama_ai.partner_prospects")).rows)
      .toEqual([{ email: "regie@journal.example", status: "identified", found_by_ai: true }]);
    expect((await db.query("SELECT total_prospects_found FROM purama_ai.partner_agent_config WHERE user_id=$1",[user])).rows)
      .toEqual([{ total_prospects_found: 1 }]);
  });
  it("isolates owners and keeps distinct services at the same domain", async () => {
    expect(await importRows([candidate(),candidate("redaction@journal.example","editorial")])).toMatchObject({ inserted: 2 });
    expect(await importRows([candidate()],other)).toMatchObject({ inserted: 1 });
    expect((await db.query("SELECT count(*)::integer AS count FROM purama_ai.partner_prospects")).rows[0]).toEqual({ count: 3 });
  });
  it("deduplicates addressless candidates by organization, website and role", async () => {
    expect(await importRows([candidate(null),candidate(null),candidate(null,"editorial")])).toMatchObject({ inserted: 2, skipped: 1 });
  });
  it("forces identified status and rejects an unproven email", async () => {
    expect(await importRows([{ ...candidate(), status: "ready_to_contact", found_by_ai: false }])).toMatchObject({ inserted: 1 });
    expect((await db.query("SELECT status,found_by_ai FROM purama_ai.partner_prospects")).rows[0]).toEqual({ status: "identified", found_by_ai: true });
    await expect(importRows([{ ...candidate("invented@journal.example"), contact_evidence: {} }])).rejects.toThrow("discovery_email_evidence_required");
  });
  it("does not expose the service-only import to an authenticated client", async () => {
    await db.exec("GRANT USAGE ON SCHEMA purama_ai TO authenticated; SET ROLE authenticated");
    await expect(importRows([candidate()])).rejects.toThrow(/permission denied/);
  });
  it("rejects overlarge batches before inserting anything", async () => {
    await expect(importRows(Array.from({ length: 26 }, () => candidate()))).rejects.toThrow("discovery_batch_too_large");
    expect((await db.query("SELECT count(*)::integer AS count FROM purama_ai.partner_prospects")).rows[0]).toEqual({ count: 0 });
  });
  it("repeated queued imports converge to one row without rewriting evidence", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => importRows([candidate()])));
    expect(results.reduce((sum, row) => sum + Number(row.inserted),0)).toBe(1);
    expect((await db.query("SELECT count(*)::integer AS count FROM purama_ai.partner_prospects")).rows[0]).toEqual({ count: 1 });
    // PGlite queues one connection: native multi-session concurrency is a separate gate.
  });
});
