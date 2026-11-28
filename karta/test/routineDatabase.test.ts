import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { normalizeRoutineInput, type RoutineInput } from "../src/routines/contracts.js";

const OWNER = "84000000-0000-4000-8000-000000000001";
const OTHER = "84000000-0000-4000-8000-000000000002";
const input = (patch: Partial<RoutineInput> = {}) => normalizeRoutineInput({ name: "Bilan", instruction: "État vérifié des projets",
  enabled: true, schedule: { kind: "daily", time: "08:30", timezone: "UTC" }, channels: ["in_app", "call", "email"],
  deliveryMode: "parallel", agentTypes: ["legal"], length: "standard", quietHours: null, pausedUntil: null,
  onlyIfNew: true, maxCallMinutes: 2, monthlyCallMinutes: 60, ...patch });
type Row = { id: string; user_id: string; revision: number; config: RoutineInput };
type Occurrence = { id: string; routine_id: string; revision: number; scheduled_at: string; report: unknown; status: string };
type Delivery = { id: string; status: string; provider_id: string | null; details: Record<string, unknown> };
type Begin = { started: boolean; reason?: string; delivery: Delivery | null };
let db: PGlite;
let migration: string;
async function scalar<T = unknown>(sql: string, args: unknown[] = []): Promise<T> {
  return (await db.query<{ value: T }>(sql, args)).rows[0].value;
}
const save = (config = input(), owner = OWNER, id: string = randomUUID(), revision = 0) => scalar<Row>(
  "SELECT purama_ai.iao_save_routine($1,$2,$3,$4::jsonb) AS value", [owner, id, revision, JSON.stringify(config)]);
const begin = (id: string, channel = "call", owner = OWNER) => scalar<Begin>(
  "SELECT purama_ai.iao_begin_routine_delivery($1,$2,$3) AS value", [owner, id, channel]);
const finish = (id: string, status: string, provider: string | null, details = {}, owner = OWNER, channel = "call") => scalar<{ updated: boolean; reason?: string; delivery: Delivery | null }>(
  "SELECT purama_ai.iao_finish_routine_delivery($1,$2,$3,$4,$5,$6::jsonb) AS value", [owner, id, channel, status, provider, JSON.stringify(details)]);
async function claim(routine: Row, slot: string = randomUUID(), report = { verified: ["fixture"] }, scheduled = new Date(Date.now() - 1_000).toISOString()) {
  return scalar<{ claimed: boolean; reason?: string; occurrence: Occurrence | null }>(
    "SELECT purama_ai.iao_claim_routine_occurrence($1,$2,$3,$4,$5,$6,$7::jsonb) AS value",
    [routine.user_id, routine.id, routine.revision, slot, scheduled, new Date(Date.parse(scheduled) + 3_600_000).toISOString(), JSON.stringify(report)]);
}
const message = (id: string, text = "Bilan vérifié", owner = OWNER) => scalar(
  "SELECT purama_ai.iao_record_routine_message($1,$2,'Bilan IAO',$3,'/notifications') AS value", [owner, id, text]);
const command = (id: string, text = "Continue ce projet", owner = OWNER) => scalar<{ id: string; status: string }>(
  "SELECT purama_ai.iao_record_routine_command($1,$2,'request-1234',$3) AS value", [owner, id, text]);
const refresh = (id: string, skip = false, owner = OWNER) => scalar<Occurrence | null>(
  "SELECT purama_ai.iao_refresh_routine_occurrence($1,$2,$3) AS value", [owner, id, skip]);
const acceptCall = async (id: string) => {
  expect((await begin(id)).started).toBe(true);
  expect((await finish(id, "accepted", `call-${id}`)).updated).toBe(true);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE SCHEMA auth; CREATE SCHEMA purama_ai; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA auth,purama_ai TO service_role,authenticated,anon;
    CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END; $$;
    CREATE PUBLICATION supabase_realtime;`);
  // Execute the original application foundation, then place its existing tables
  // in the dedicated schema used by the application's client and server today.
  await db.exec(await readFile(new URL("../../supabase/migrations/20260122220606_b16f6034-6be4-472b-bc83-57d8767a4721.sql", import.meta.url), "utf8"));
  await db.exec("ALTER TABLE public.notifications SET SCHEMA purama_ai; ALTER TABLE public.notification_preferences SET SCHEMA purama_ai");
  await db.exec(await readFile(new URL("../migrations/002_karta_global_kill_switch.sql", import.meta.url), "utf8"));
  migration = await readFile(new URL("../migrations/040_iao_routines.sql", import.meta.url), "utf8");
  try { await db.exec(migration); }
  catch (error) {
    const detail = error as { position?: number; internalPosition?: number; internalQuery?: string; where?: string };
    const position = Number(detail.position ?? 0);
    console.error("Routine migration rejected", { position, internalPosition: detail.internalPosition,
      context: migration.slice(Math.max(0, position - 180), position + 180), where: detail.where,
      internalQuery: detail.internalQuery?.slice(-500) });
    throw error;
  }
  await db.exec("GRANT SELECT,INSERT,UPDATE,DELETE ON purama_ai.notifications,purama_ai.notification_preferences,purama_ai.karta_global_state TO service_role; GRANT SELECT ON purama_ai.notifications TO authenticated");
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE auth.users CASCADE; TRUNCATE purama_ai.notifications,purama_ai.notification_preferences; INSERT INTO purama_ai.karta_global_state(id,kill_switch) VALUES('global',false) ON CONFLICT(id) DO UPDATE SET kill_switch=false");
  await db.query("INSERT INTO auth.users VALUES($1),($2)", [OWNER, OTHER]);
  await db.exec("SET ROLE service_role");
});

describe("durable routines on PostgreSQL, with no provider or external effects", () => {
  it("replays creation without duplicates, updates optimistically and rejects cross-account identity", async () => {
    const row = await save();
    expect(await save(row.config, OWNER, row.id)).toEqual(row);
    await expect(save(input({ name: "Other" }), OWNER, row.id)).rejects.toMatchObject({ code: "PRT02" });
    await expect(save(row.config, OTHER, row.id, row.revision)).rejects.toMatchObject({ code: "PRT02" });
    expect(await save(input({ name: "Modifié" }), OWNER, row.id, 1)).toMatchObject({ revision: 2 });
    await expect(save(input({ name: "Écrasement tardif" }), OWNER, row.id, 1)).rejects.toMatchObject({ code: "PRT02" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.iao_routines")).toBe(1);
  });
  it("can reapply the migration without replacing persisted routines or commands", async () => {
    const row = await save(); const occurrence = (await claim(row)).occurrence!; await acceptCall(occurrence.id); const cmd = await command(occurrence.id);
    await db.exec("RESET ROLE"); await db.exec(migration); await db.exec("SET ROLE service_role");
    expect(await scalar("SELECT config AS value FROM purama_ai.iao_routines WHERE id=$1", [row.id])).toEqual(row.config);
    expect(await command(occurrence.id)).toEqual(cmd);
  });
  it.each([{ enabled: "true" }, { hidden: true }, { maxCallMinutes: 0 }, { maxCallMinutes: 11 }, { monthlyCallMinutes: 1 },
    { channels: ["sms"] }, { channels: ["call", "call"] }, { agentTypes: ["unknown"] }, { quietHours: { start: "23:00", end: "23:00" } },
    { schedule: { kind: "daily", time: "25:00", timezone: "UTC" } }, { pausedUntil: "2026-02-30T00:00:00Z" }])("rejects malformed JSON at SQL authority too: %j", async patch => {
    const config = { ...input(), ...patch };
    await expect(scalar("SELECT purama_ai.iao_save_routine($1,$2,0,$3::jsonb) AS value", [OWNER, randomUUID(), JSON.stringify(config)]))
      .rejects.toMatchObject({ code: "PRT01" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.iao_routines")).toBe(0);
  });
  it("keeps one occurrence, one frozen report and one delivery per selected channel", async () => {
    const row = await save(); const scheduled = new Date(Date.now() - 1000).toISOString(); const slot = "morning-2026-11-28";
    const first = await claim(row, slot, { verified: ["initial"] }, scheduled);
    expect(first.claimed).toBe(true);
    const repeat = await claim(row, slot, { verified: ["changed-read"] }, scheduled);
    expect(repeat.claimed).toBe(false); expect(repeat.occurrence?.id).toBe(first.occurrence?.id);
    expect(repeat.occurrence?.report).toEqual({ verified: ["initial"] });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.iao_routine_deliveries")).toBe(3);
    expect((await claim(row, slot, undefined, new Date(Date.now() - 2000).toISOString())).reason).toBe("occurrence_conflict");
  });
  it("recovers unattempted channels after a restart while expired sending becomes unknown, never pending", async () => {
    const row = await save(); const scheduled = new Date(Date.now() - 1000).toISOString(); const first = await claim(row, "recovery-slot", undefined, scheduled);
    const id = first.occurrence!.id; expect((await begin(id)).started).toBe(true);
    await db.query("UPDATE purama_ai.iao_routine_occurrences SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    await db.query("UPDATE purama_ai.iao_routine_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE occurrence_id=$1 AND channel='call'", [id]);
    expect((await claim(row, "recovery-slot", undefined, scheduled)).claimed).toBe(true);
    expect(await begin(id)).toMatchObject({ started: false, delivery: { status: "unknown", details: { reservedMinutes: 2 } } });
    expect(await refresh(id)).toMatchObject({ status: "unknown" });
    expect((await begin(id, "in_app")).started).toBe(true);
    expect((await begin(id)).started).toBe(false);
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.iao_routine_occurrences")).toBe(1);
  });
  it("refuses a second manual request even before the first transport starts, while the same key stays recoverable", async () => {
    const row = await save(); const scheduled = new Date(Date.now() - 1000).toISOString();
    const first = await claim(row, "manual:first-request", undefined, scheduled);
    expect(first.claimed).toBe(true);
    expect(await claim(row, "manual:second-request")).toMatchObject({ claimed: false, reason: "active_occurrence" });
    expect((await claim(row, "manual:first-request", undefined, scheduled)).occurrence?.id).toBe(first.occurrence!.id);
    expect(await claim(row, "manual:first-request", undefined, new Date().toISOString()))
      .toMatchObject({ claimed: false, reason: "already_claimed", occurrence: { id: first.occurrence!.id } });
    await begin(first.occurrence!.id); await finish(first.occurrence!.id, "unknown", null);
    expect(await claim(row, "manual:third-request")).toMatchObject({ claimed: false, reason: "active_occurrence" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.iao_routine_occurrences")).toBe(1);
  });
  it("rechecks revisions immediately before delivery", async () => {
    const row = await save(); const id = (await claim(row)).occurrence!.id;
    await save(input({ name: "New instructions" }), OWNER, row.id, row.revision);
    expect(await begin(id)).toMatchObject({ started: false, reason: "stale_revision", delivery: { status: "skipped" } });
  });
  it("stops all active routines for only the requested owner and retires queued old revisions", async () => {
    const row = await save(); const foreign = await save(input(), OTHER); const paused = await save(input({ enabled: false }));
    const id = (await claim(row)).occurrence!.id;
    expect(await scalar("SELECT purama_ai.iao_pause_all_routines($1) AS value", [OWNER])).toEqual({ updatedCount: 1 });
    expect(await scalar("SELECT revision AS value FROM purama_ai.iao_routines WHERE id=$1", [row.id])).toBe(2);
    expect(await scalar("SELECT revision AS value FROM purama_ai.iao_routines WHERE id=$1", [paused.id])).toBe(1);
    expect(await scalar("SELECT config->'enabled' AS value FROM purama_ai.iao_routines WHERE id=$1", [foreign.id])).toBe(true);
    expect((await begin(id)).started).toBe(false);
  });
  it("fails closed when the global stop is active or its authority row is missing", async () => {
    const row = await save(); const id = (await claim(row)).occurrence!.id;
    await db.exec("UPDATE purama_ai.karta_global_state SET kill_switch=true");
    expect(await begin(id)).toMatchObject({ started: false, reason: "global_stop" });
    await db.exec("DELETE FROM purama_ai.karta_global_state");
    expect(await claim(row)).toMatchObject({ claimed: false, reason: "global_stop" });
  });
  it("respects quiet hours and a future pause before claiming", async () => {
    const now = new Date(); const hour = now.getUTCHours();
    const quiet = { start: `${String(hour).padStart(2, "0")}:00`, end: `${String((hour + 2) % 24).padStart(2, "0")}:00` };
    expect(await claim(await save(input({ quietHours: quiet })))).toMatchObject({ claimed: false, reason: "quiet_hours" });
    expect(await claim(await save(input({ pausedUntil: new Date(Date.now() + 86400000).toISOString() })))).toMatchObject({ claimed: false, reason: "paused" });
  });
  it("respects explicit notification refusals and keeps email refusal separate from in-app", async () => {
    const row = await save();
    await db.query("INSERT INTO purama_ai.notification_preferences(user_id,email_enabled,daily_report_enabled) VALUES($1,false,true)", [OWNER]);
    const id = (await claim(row)).occurrence!.id;
    expect(await begin(id, "email")).toMatchObject({ started: false, reason: "email_preference" });
    expect((await begin(id, "in_app")).started).toBe(true);
    await db.query("UPDATE purama_ai.notification_preferences SET daily_report_enabled=false WHERE user_id=$1", [OWNER]);
    expect(await claim(row)).toMatchObject({ claimed: false, reason: "notification_preference" });
  });
  it("uses the existing event preference for an event routine", async () => {
    await db.query("INSERT INTO purama_ai.notification_preferences(user_id,task_completed_enabled) VALUES($1,false)", [OWNER]);
    expect(await claim(await save(input({ schedule: { kind: "event", event: "completed", timezone: "UTC" } }))))
      .toMatchObject({ claimed: false, reason: "notification_preference" });
  });
  it("bounds call reservations across different routines of the same user, including unknown outcomes", async () => {
    const first = (await claim(await save(input({ monthlyCallMinutes: 3 })))).occurrence!.id;
    const second = (await claim(await save(input({ monthlyCallMinutes: 3 })))).occurrence!.id;
    const foreign = (await claim(await save(input({ monthlyCallMinutes: 3 }), OTHER))).occurrence!.id;
    expect((await begin(first)).started).toBe(true);
    await finish(first, "unknown", null, { reason: "timeout", reservedMinutes: 0 });
    expect(await begin(second)).toMatchObject({ started: false, reason: "call_budget_exhausted" });
    expect((await begin(foreign, "call", OTHER)).started).toBe(true);
    expect(await scalar("SELECT details->'reservedMinutes' AS value FROM purama_ai.iao_routine_deliveries WHERE occurrence_id=$1 AND channel='call'", [first])).toBe(2);
  });
  it("binds provider receipts and refuses out-of-order downgrades", async () => {
    const id = (await claim(await save())).occurrence!.id; await begin(id);
    expect((await finish(id, "accepted", "call-1")).updated).toBe(true);
    expect(await finish(id, "completed", "wrong-call")).toMatchObject({ updated: false, reason: "receipt_conflict" });
    expect((await finish(id, "completed", "call-1")).updated).toBe(true);
    expect(await finish(id, "accepted", "call-1")).toMatchObject({ updated: false, delivery: { status: "completed" } });
  });
  it("allows only one unresolved call per account, including cancelled occurrences, until a verified terminal receipt", async () => {
    const firstRow = await save(); const secondRow = await save();
    const first = (await claim(firstRow)).occurrence!.id; await acceptCall(first);
    const second = (await claim(secondRow)).occurrence!.id;
    expect(await begin(second)).toMatchObject({ started: false, reason: "call_in_progress" });
    await scalar("SELECT purama_ai.iao_cancel_routine_occurrence($1,$2) AS value", [OWNER, first]);
    const third = (await claim(secondRow)).occurrence!.id;
    expect(await begin(third)).toMatchObject({ started: false, reason: "call_in_progress" });
    expect(await finish(first, "failed", `call-${first}`)).toMatchObject({ updated: true, delivery: { status: "failed" } });
    expect(await refresh(first)).toMatchObject({ status: "cancelled" });
    expect((await begin((await claim(secondRow)).occurrence!.id)).started).toBe(true);
  });
  it("does not turn an unknown result into failure without a reconciled provider identity", async () => {
    const id = (await claim(await save())).occurrence!.id; await begin(id); await finish(id, "unknown", null);
    expect(await finish(id, "failed", null)).toMatchObject({ updated: false, delivery: { status: "unknown" } });
    expect(await finish(id, "completed", "reconciled-call")).toMatchObject({ updated: true, delivery: { status: "completed" } });
  });
  it("keeps a fallback blocked while unknown and resumes the same occurrence after a determined failure", async () => {
    const id = (await claim(await save(input({ channels: ["call", "in_app"], deliveryMode: "fallback" })))).occurrence!.id;
    await begin(id); await finish(id, "unknown", null);
    expect(await refresh(id)).toMatchObject({ status: "unknown" });
    await finish(id, "failed", "reconciled-call");
    expect(await refresh(id)).toMatchObject({ id, status: "processing" });
    expect((await begin(id, "in_app")).started).toBe(true);
    await message(id);
    expect(await refresh(id)).toMatchObject({ id, status: "completed" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.iao_routine_occurrences")).toBe(1);
    expect((await begin(id)).started).toBe(false);
  });
  it("finishes a successful human fallback call without starting the remaining channels", async () => {
    const id = (await claim(await save(input({ channels: ["call", "in_app", "email"], deliveryMode: "fallback" })))).occurrence!.id;
    await begin(id); await finish(id, "completed", "human-call", { answeredBy: "human" });
    expect(await refresh(id)).toMatchObject({ status: "completed" });
    expect(await begin(id, "in_app")).toMatchObject({ started: false, delivery: { status: "skipped", details: { reason: "fallback_not_needed" } } });
    expect(await refresh(id)).toMatchObject({ status: "completed" });
  });
  it("allows a fallback after voicemail, without pretending the user heard the report", async () => {
    const id = (await claim(await save(input({ channels: ["call", "in_app"], deliveryMode: "fallback" })))).occurrence!.id;
    await begin(id); await finish(id, "completed", "machine-call", { answeredBy: "machine" });
    expect(await refresh(id)).toMatchObject({ status: "processing" });
    expect((await begin(id, "in_app")).started).toBe(true);
  });
  it("skips only pending deliveries when there is no new activity, preserving an unknown effect", async () => {
    const row = await save(); const empty = (await claim(row)).occurrence!.id;
    expect(await refresh(empty, true)).toMatchObject({ status: "skipped" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.iao_routine_deliveries WHERE occurrence_id=$1 AND status='skipped'", [empty])).toBe(3);
    const uncertain = (await claim(row)).occurrence!.id; await begin(uncertain); await finish(uncertain, "unknown", null);
    expect(await refresh(uncertain, true)).toMatchObject({ status: "unknown" });
  });
  it("cancels pending work without claiming that an already started phone call was cancelled", async () => {
    const id = (await claim(await save())).occurrence!.id; await acceptCall(id); const cmd = await command(id);
    expect(await scalar("SELECT purama_ai.iao_cancel_routine_occurrence($1,$2) AS value", [OWNER, id]))
      .toEqual({ cancelled: true, externalCancellationConfirmed: false });
    expect(await begin(id)).toMatchObject({ started: false, delivery: { status: "accepted" } });
    expect(await finish(id, "completed", "late-call")).toMatchObject({ updated: false, reason: "receipt_conflict" });
    expect(await scalar("SELECT status AS value FROM purama_ai.iao_routine_commands WHERE id=$1", [cmd.id])).toBe("cancelled");
    expect(await scalar("SELECT status AS value FROM purama_ai.iao_routine_deliveries WHERE occurrence_id=$1 AND channel='in_app'", [id])).toBe("skipped");
    expect(await refresh(id)).toMatchObject({ status: "cancelled" });
  });
  it("reconciles a cancelled sending call without reviving the occurrence or retrying the provider", async () => {
    const id = (await claim(await save())).occurrence!.id; await begin(id);
    await scalar("SELECT purama_ai.iao_cancel_routine_occurrence($1,$2) AS value", [OWNER, id]);
    expect(await begin(id)).toMatchObject({ started: false, delivery: { status: "unknown" } });
    expect(await finish(id, "accepted", "late-accept")).toMatchObject({ updated: false, reason: "occurrence_cancelled" });
    expect(await finish(id, "failed", "verified-terminal")).toMatchObject({ updated: true, delivery: { status: "failed" } });
    expect(await refresh(id)).toMatchObject({ status: "cancelled" });
    expect((await begin(id)).started).toBe(false);
  });
  it("records one message in the existing centre and one durable receipt in the same transaction", async () => {
    const id = (await claim(await save())).occurrence!.id;
    expect(await message(id)).toMatchObject({ ok: false, reason: "delivery_not_started" });
    await begin(id, "in_app");
    expect(await message(id)).toEqual({ ok: true, notification_id: id });
    expect(await message(id)).toEqual({ ok: true, notification_id: id });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.notifications")).toBe(1);
    expect(await scalar("SELECT status AS value FROM purama_ai.iao_routine_deliveries WHERE occurrence_id=$1 AND channel='in_app'", [id])).toBe("completed");
    await expect(message(id, "Other content")).rejects.toMatchObject({ code: "PRT02" });
    await expect(message(id, undefined, OTHER)).rejects.toMatchObject({ code: "PRT02" });
  });
  it("rechecks stop before the local message insertion too", async () => {
    const id = (await claim(await save())).occurrence!.id; await begin(id, "in_app");
    await db.exec("UPDATE purama_ai.karta_global_state SET kill_switch=true");
    expect(await message(id)).toMatchObject({ ok: false, reason: "global_stop" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.notifications")).toBe(0);
  });
  it("stores a phone instruction as pending confirmation and never executes it in this RPC", async () => {
    const id = (await claim(await save())).occurrence!.id; await acceptCall(id);
    const first = await command(id); expect(first.status).toBe("pending_confirmation"); expect(await command(id)).toEqual(first);
    await expect(command(id, "Change everything")).rejects.toMatchObject({ code: "PRT02" });
    await expect(command(id, undefined, OTHER)).rejects.toMatchObject({ code: "PRT02" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.iao_routine_commands")).toBe(1);
  });
  it("accepts new phone instructions only for the current permitted routine and an accepted provider-bound call", async () => {
    const row = await save(); const id = (await claim(row)).occurrence!.id;
    await expect(command(id)).rejects.toMatchObject({ code: "PRT02" });
    await begin(id);
    await expect(command(id)).rejects.toMatchObject({ code: "PRT02" });
    await finish(id, "accepted", "command-live-call");
    await db.exec("UPDATE purama_ai.karta_global_state SET kill_switch=true");
    await expect(command(id)).rejects.toMatchObject({ code: "PRT02" });
    await db.exec("UPDATE purama_ai.karta_global_state SET kill_switch=false");
    await save(input({ instruction: "Consignes changées" }), OWNER, row.id, row.revision);
    await expect(command(id)).rejects.toMatchObject({ code: "PRT02" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.iao_routine_commands")).toBe(0);
  });
  it("limits instructions per occurrence without counting the replay of an existing request", async () => {
    const id = (await claim(await save())).occurrence!.id; await acceptCall(id);
    const first = await command(id);
    await db.query("SELECT purama_ai.iao_record_routine_command($1,$2,'request-limit-'||n::text,'Instruction '||n::text) FROM generate_series(1,99) n", [OWNER, id]);
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.iao_routine_commands")).toBe(100);
    expect(await command(id)).toEqual(first);
    await expect(scalar("SELECT purama_ai.iao_record_routine_command($1,$2,'request-limit-101','Nouvelle instruction') AS value", [OWNER, id]))
      .rejects.toMatchObject({ code: "PRT01" });
  });
  it("exposes only the authenticated owner's rows and denies all authenticated mutations and RPCs", async () => {
    const row = await save(); const foreign = await save(input(), OTHER); const id = (await claim(row)).occurrence!.id;
    await claim(foreign); await acceptCall(id); await command(id);
    await db.exec("RESET ROLE; SET ROLE authenticated"); await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [OWNER]);
    expect((await db.query("SELECT id FROM purama_ai.iao_routines")).rows).toEqual([{ id: row.id }]);
    for (const table of ["iao_routine_occurrences", "iao_routine_deliveries", "iao_routine_commands"]) {
      const rows = (await db.query<{ user_id: string }>(`SELECT user_id FROM purama_ai.${table}`)).rows;
      expect(rows.length).toBeGreaterThan(0); expect(rows.every(item => item.user_id === OWNER)).toBe(true);
      await expect(db.exec(`UPDATE purama_ai.${table} SET user_id='${OTHER}'`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(save()).rejects.toMatchObject({ code: "42501" });
    await expect(begin(id)).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("DELETE FROM purama_ai.iao_routines WHERE id=$1", [row.id])).rejects.toMatchObject({ code: "42501" });
    await db.exec("RESET ROLE; SET ROLE anon");
    await expect(db.exec("SELECT * FROM purama_ai.iao_routines")).rejects.toMatchObject({ code: "42501" });
    await expect(save()).rejects.toMatchObject({ code: "42501" });
  });
});
