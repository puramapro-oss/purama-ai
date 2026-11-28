import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverRoutineChannel, prepareRoutineDelivery, RoutineTransportNotDeliveredError } from "../src/routines/transports.js";
import { verifyPhoneCommandToken } from "../src/routines/commands.js";
import { CALL, NOW, OWNER, routineFixture, occurrenceFixture, runtimeFixture, mockRoutineStore } from "./routineFixtures.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function harness() {
  const routine = routineFixture(), occurrence = occurrenceFixture(routine), runtime = runtimeFixture();
  const store = mockRoutineStore({ destination: vi.fn(async () => ({ phone: "+33600000000", email: "test@example.invalid" })), recordMessage: vi.fn(async () => {}) });
  const phone = { startPhoneCall: vi.fn(async () => ({ callId: CALL, externalId: occurrence.id, status: "accepted" as const })), lookupPhoneCall: vi.fn() };
  return { routine, occurrence, runtime, store, phone };
}
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
describe("routine transport receipts", () => {
  it("prepares only the server-verified phone identity", async () => {
    const h = harness(); expect(await prepareRoutineDelivery("call", h.occurrence, h.runtime, h.store)).toEqual({ phone: "+33600000000", email: "test@example.invalid" });
    expect(h.store.destination).toHaveBeenCalledWith(OWNER);
  });
  it("does not prepare an unverified phone", async () => {
    const h = harness(); vi.mocked(h.store.destination).mockResolvedValue({ phone: null, email: null });
    await expect(prepareRoutineDelivery("call", h.occurrence, h.runtime, h.store)).rejects.toThrow();
  });
  it("fails closed before an unconfigured channel can reserve an attempt", async () => {
    const h = harness(); h.runtime.pushEnabled = false;
    await expect(prepareRoutineDelivery("push", h.occurrence, h.runtime, h.store)).rejects.toThrow();
  });
  it("records in-app content without querying contact identity or a provider", async () => {
    const h = harness();
    expect(await deliverRoutineChannel("in_app", h.occurrence, h.routine, { phone: null, email: null }, h.runtime, h.store, h.phone))
      .toMatchObject({ status: "completed", providerId: h.occurrence.id, details: { readConfirmed: false } });
    expect(h.store.recordMessage).toHaveBeenCalledWith(h.occurrence); expect(h.store.destination).not.toHaveBeenCalled();
  });
  it("never fabricates an in-app success after the store refuses it", async () => {
    const h = harness(); vi.mocked(h.store.recordMessage).mockRejectedValue(new Error("no receipt"));
    await expect(deliverRoutineChannel("in_app", h.occurrence, h.routine, { phone: null, email: null }, h.runtime, h.store, h.phone)).rejects.toThrow();
  });
  it("attaches a short-lived capture capability and keeps accepted distinct from heard", async () => {
    const h = harness(); vi.spyOn(Date, "now").mockReturnValue(NOW);
    const result = await deliverRoutineChannel("call", h.occurrence, h.routine, { phone: "+33600000000", email: null }, h.runtime, h.store, h.phone);
    expect(result).toEqual({ status: "accepted", providerId: CALL, details: { heardConfirmed: false } });
    const input = h.phone.startPhoneCall.mock.calls[0] as unknown as [{ commandContext: { token: string; expiresAt: string }; briefing: string }];
    expect(verifyPhoneCommandToken(h.runtime.commandSecret, h.occurrence, input[0].commandContext.expiresAt, input[0].commandContext.token, NOW)).toBe(true);
    expect(input[0].briefing).toBe(h.occurrence.report.body);
  });
  it("keeps lock-screen push content generic and records only an acceptance", async () => {
    const h = harness(); const fetchMock = vi.fn(async () => response({ ok: true, notification_id: CALL, push_sent: 1, push_failed: 0 })); vi.stubGlobal("fetch", fetchMock);
    const result = await deliverRoutineChannel("push", h.occurrence, h.routine, { phone: null, email: null }, h.runtime, h.store, h.phone);
    expect(result).toMatchObject({ status: "accepted", providerId: CALL, details: { readConfirmed: false } });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]; const sent = JSON.parse(init.body as string);
    expect(sent.user_id).toBe(OWNER); expect(sent.body).not.toContain("Document préparé"); expect(init.redirect).toBe("error");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("recognizes a confirmed no-subscription push result so fallback can continue", async () => {
    const h = harness(); vi.stubGlobal("fetch", vi.fn(async () => response({ ok: true, notification_id: CALL, push_sent: 0, push_failed: 0 })));
    await expect(deliverRoutineChannel("push", h.occurrence, h.routine, { phone: null, email: null }, h.runtime, h.store, h.phone))
      .rejects.toBeInstanceOf(RoutineTransportNotDeliveredError);
  });
  it.each([{ ok: false }, { ok: true, notification_id: CALL }, { ok: true, notification_id: CALL, push_sent: 0, push_failed: 1 }])("keeps a missing or ambiguous push receipt unconfirmed %#", async receipt => {
    const h = harness(); vi.stubGlobal("fetch", vi.fn(async () => response(receipt)));
    await expect(deliverRoutineChannel("push", h.occurrence, h.routine, { phone: null, email: null }, h.runtime, h.store, h.phone))
      .rejects.not.toBeInstanceOf(RoutineTransportNotDeliveredError);
  });
});
