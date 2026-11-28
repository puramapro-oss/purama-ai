import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), getUserById: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc: db.rpc, from: db.from, auth: { admin: { getUserById: db.getUserById } } } }));
import { routineStore, decodeRoutine, decodeOccurrence } from "../src/routines/store.js";
import { OWNER, REQUEST, occurrenceFixture, routineFixture } from "./routineFixtures.js";
const occurrence = occurrenceFixture(); const routine = routineFixture();
function rpc(data: unknown, error: unknown = null) { db.rpc.mockReturnValue({ abortSignal: vi.fn(async () => ({ data, error })) }); }
function rawRoutine() { return { id: routine.id, user_id: OWNER, revision: 1, config: routine.config,
  created_at: routine.createdAt, updated_at: routine.updatedAt, last_occurrence_at: null }; }
function rawOccurrence() { return { id: occurrence.id, user_id: OWNER, routine_id: routine.id, revision: 1,
  slot: occurrence.slot, scheduled_at: occurrence.scheduledAt, expires_at: occurrence.expiresAt, status: "processing", report: occurrence.report }; }
beforeEach(() => { vi.clearAllMocks(); });
describe("routine database receipt validation", () => {
  it("rejects a null occurrence refusal without claiming a success", async () => {
    rpc({ claimed: false, occurrence: null, reason: "paused" });
    await expect(routineStore.claim(routine, "slot", occurrence.scheduledAt, occurrence.expiresAt, occurrence.report)).rejects.toMatchObject({ status: 409 });
  });
  it("preserves a stable stored receipt on a replay", async () => {
    rpc({ claimed: false, reason: "already_claimed", occurrence: rawOccurrence() });
    expect((await routineStore.claim(routine, "slot", occurrence.scheduledAt, occurrence.expiresAt, occurrence.report)).id).toBe(occurrence.id);
  });
  it("exposes a refused state transition as false", async () => {
    rpc({ updated: false, reason: "occurrence_cancelled" });
    await expect(routineStore.finish(occurrence, "call", "accepted", REQUEST)).resolves.toBe(false);
  });
  it.each([{ ok: false }, {}, { ok: true, notification_id: REQUEST }])("rejects an invalid message receipt %#", async result => {
    rpc(result); await expect(routineStore.recordMessage(occurrence)).rejects.toMatchObject({ code: "ROUTINE_MESSAGE_UNCONFIRMED" });
  });
  it("accepts only a message recorded for the same occurrence", async () => {
    rpc({ ok: true, notification_id: occurrence.id }); await expect(routineStore.recordMessage(occurrence)).resolves.toBeUndefined();
  });
  it("does not claim cancellation for a missing occurrence", async () => {
    rpc({ cancelled: false }); await expect(routineStore.cancel(OWNER, occurrence.id)).rejects.toMatchObject({ status: 404 });
  });
  it("requires the same owner on database records", () => {
    expect(() => decodeRoutine(rawRoutine(), REQUEST)).toThrow(); expect(() => decodeOccurrence(rawOccurrence(), REQUEST)).toThrow();
  });
  it("preserves Postgres instants with fractional microseconds", () => {
    expect(decodeRoutine({ ...rawRoutine(), updated_at: "2026-11-28T08:00:00.123456+00:00" }).updatedAt).toBe("2026-11-28T08:00:00.123Z");
  });
  it("bounds persisted report content and state", () => {
    expect(() => decodeOccurrence({ ...rawOccurrence(), report: { title: "a", body: "x".repeat(5001) } })).toThrow();
    expect(() => decodeOccurrence({ ...rawOccurrence(), status: "delivered-and-read" })).toThrow();
  });
  it("never returns an unverified phone or email", async () => {
    db.getUserById.mockResolvedValue({ data: { user: { id: OWNER, phone: "33600000000", email: "test@example.invalid" } }, error: null });
    expect(await routineStore.destination(OWNER)).toEqual({ phone: null, email: null });
    db.getUserById.mockResolvedValue({ data: { user: { id: OWNER, phone: "33600000000", phone_confirmed_at: routine.createdAt,
      email: "test@example.invalid", email_confirmed_at: routine.createdAt } }, error: null });
    expect(await routineStore.destination(OWNER)).toEqual({ phone: "+33600000000", email: "test@example.invalid" });
  });
  it("rejects an identity response for another owner", async () => {
    db.getUserById.mockResolvedValue({ data: { user: { id: REQUEST, phone: "33600000000", phone_confirmed_at: routine.createdAt } }, error: null });
    await expect(routineStore.destination(OWNER)).rejects.toThrow();
  });
  it("redacts storage errors and does not retry a mutation", async () => {
    rpc(null, { code: "secret-database-error", message: "never expose this" });
    await expect(routineStore.cancel(OWNER, occurrence.id)).rejects.not.toThrow("never expose this"); expect(db.rpc).toHaveBeenCalledOnce();
  });
});
