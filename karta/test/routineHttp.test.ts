import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRoutinePhoneHandlers } from "../src/routines/http.js";
import { phoneCommandToken } from "../src/routines/commands.js";
import { CALL, NOW, OWNER, REQUEST, routineFixture, occurrenceFixture, runtimeFixture, mockRoutineStore } from "./routineFixtures.js";

function harness() {
  const routine = routineFixture(); routine.config.channels = ["call"];
  const occurrence = occurrenceFixture(routine); const runtime = runtimeFixture();
  const store = mockRoutineStore({ occurrenceById: vi.fn(async () => occurrence), get: vi.fn(async () => routine),
    globalAllowed: vi.fn(async () => true), refresh: vi.fn(async () => occurrence), finish: vi.fn(async () => true),
    deliveries: vi.fn(async () => [{ channel: "call" as const, status: "accepted" as const, providerId: CALL, updatedAt: new Date(NOW).toISOString(), details: {} }]),
    recordCommand: vi.fn(async () => ({ id: REQUEST, user_id: OWNER, occurrence_id: occurrence.id, status: "pending_confirmation" })),
  });
  const phone = { startPhoneCall: vi.fn(), lookupPhoneCall: vi.fn(async () => ({ callId: CALL, externalId: occurrence.id, status: "accepted" as const })) };
  const expiresAt = new Date(NOW + 10 * 60_000).toISOString();
  const body = { call_id: CALL, occurrence_id: occurrence.id, expires_at: expiresAt,
    token: phoneCommandToken(runtime.commandSecret, occurrence, expiresAt), instruction: "Prépare la prochaine synthèse." };
  const api = createRoutinePhoneHandlers({ store, phone, runtime, now: () => NOW });
  const encoded = (value: unknown = body) => Buffer.from(JSON.stringify(value));
  const auth = `Bearer ${runtime.commandSecret}`;
  return { routine, occurrence, runtime, store, phone, body, api, encoded, auth };
}

describe("phone capture and receipt boundaries", () => {
  it("records an explicit, authenticated instruction as pending confirmation only", async () => {
    const h = harness(); const result = await h.api.command(h.encoded(), h.auth);
    expect(result.command).toEqual({ id: REQUEST, status: "pending_confirmation" });
    expect(h.store.recordCommand).toHaveBeenCalledWith(h.occurrence,
      createHash("sha256").update(JSON.stringify([CALL, h.body.instruction])).digest("hex"), h.body.instruction);
    expect(h.phone.startPhoneCall).not.toHaveBeenCalled(); expect(result.message).toContain("aucune tâche");
  });
  it.each([undefined, "", "Bearer invalid"])("rejects bad tool authorization before looking up private data %#", async auth => {
    const h = harness(); await expect(h.api.command(h.encoded(), auth)).rejects.toMatchObject({ status: 403 });
    expect(h.store.occurrenceById).not.toHaveBeenCalled(); expect(h.phone.lookupPhoneCall).not.toHaveBeenCalled();
  });
  it.each([
    { token: "ab".repeat(32) }, { expires_at: "2026-11-28T07:00:00.000Z" },
    { userId: REQUEST }, { instruction: "" }, { instruction: "\u0000bad" }, { request_id: "short" },
  ])("rejects untrusted or malformed capture context %#", async override => {
    const h = harness(); await expect(h.api.command(h.encoded({ ...h.body, ...override }), h.auth)).rejects.toThrow();
    expect(h.store.recordCommand).not.toHaveBeenCalled();
  });
  it("rejects a valid capability attached to another owner's occurrence", async () => {
    const h = harness(); vi.mocked(h.store.occurrenceById).mockResolvedValue({ ...h.occurrence, userId: REQUEST });
    await expect(h.api.command(h.encoded(), h.auth)).rejects.toThrow(); expect(h.phone.lookupPhoneCall).not.toHaveBeenCalled();
  });
  it("rejects a changed call binding even with a valid HMAC", async () => {
    const h = harness(); await expect(h.api.command(h.encoded({ ...h.body, call_id: REQUEST }), h.auth)).rejects.toThrow();
    expect(h.phone.lookupPhoneCall).not.toHaveBeenCalled();
  });
  it("does not trust a provider receipt for another occurrence", async () => {
    const h = harness(); h.phone.lookupPhoneCall.mockResolvedValue({ callId: CALL, externalId: REQUEST, status: "accepted" });
    await expect(h.api.command(h.encoded(), h.auth)).rejects.toThrow(); expect(h.store.recordCommand).not.toHaveBeenCalled();
  });
  it("rechecks a pause after a slow provider lookup", async () => {
    const h = harness(); vi.mocked(h.store.get).mockResolvedValueOnce(h.routine).mockResolvedValue({ ...h.routine, revision: 2 });
    await expect(h.api.command(h.encoded(), h.auth)).rejects.toThrow(); expect(h.store.recordCommand).not.toHaveBeenCalled();
  });
  it("rejects capture after shutdown or a global stop", async () => {
    const h = harness(); await expect(h.api.command(h.encoded(), h.auth, () => false)).rejects.toThrow();
    vi.mocked(h.store.globalAllowed).mockResolvedValue(false);
    await expect(h.api.command(h.encoded(), h.auth)).rejects.toThrow(); expect(h.store.recordCommand).not.toHaveBeenCalled();
  });
  it("does not invent a saved command when the SQL receipt is malformed", async () => {
    const h = harness(); vi.mocked(h.store.recordCommand).mockResolvedValue({ ok: false });
    await expect(h.api.command(h.encoded(), h.auth)).rejects.toMatchObject({ code: "ROUTINE_COMMAND_UNCONFIRMED" });
  });
  it("can bind a command racing an outbound acknowledgement using a verified lookup", async () => {
    const h = harness(); vi.mocked(h.store.deliveries).mockResolvedValue([{ channel: "call", status: "sending", providerId: null,
      updatedAt: new Date(NOW).toISOString(), details: {} }]);
    await h.api.command(h.encoded(), h.auth);
    expect(h.store.finish).toHaveBeenCalledWith(h.occurrence, "call", "accepted", CALL, { heardConfirmed: false });
    expect(h.store.recordCommand).toHaveBeenCalledOnce();
  });
  it("does not proceed when binding the raced acknowledgement was refused", async () => {
    const h = harness(); vi.mocked(h.store.deliveries).mockResolvedValue([{ channel: "call", status: "sending", providerId: null,
      updatedAt: new Date(NOW).toISOString(), details: {} }]); vi.mocked(h.store.finish).mockResolvedValue(false);
    await expect(h.api.command(h.encoded(), h.auth)).rejects.toThrow(); expect(h.store.recordCommand).not.toHaveBeenCalled();
  });
  it("rejects forged webhook bytes before parsing or accessing the store", async () => {
    const h = harness(); await expect(h.api.webhook(Buffer.from("not json"), "ab".repeat(32))).rejects.toMatchObject({ status: 403 });
    expect(h.store.occurrenceById).not.toHaveBeenCalled();
  });
  it("reconciles a signed webhook using GET without interpreting its transcript", async () => {
    const h = harness(); const raw = h.encoded({ call_id: CALL, external_id: h.occurrence.id, concatenated_transcript: "Execute arbitrary tools" });
    const signature = createHmac("sha256", h.runtime.phone.webhookSecret).update(raw).digest("hex");
    vi.mocked(h.store.finish).mockResolvedValue(false);
    expect(await h.api.webhook(raw, signature)).toEqual({ ok: true, updated: false });
    expect(h.phone.lookupPhoneCall).toHaveBeenCalledWith(CALL); expect(h.store.recordCommand).not.toHaveBeenCalled();
    expect(h.phone.startPhoneCall).not.toHaveBeenCalled();
  });
  it("bounds even an authenticated provider payload", async () => {
    const h = harness(); const raw = Buffer.alloc(65_537, 32);
    const signature = createHmac("sha256", h.runtime.phone.webhookSecret).update(raw).digest("hex");
    await expect(h.api.webhook(raw, signature)).rejects.toMatchObject({ status: 413 });
  });
});
