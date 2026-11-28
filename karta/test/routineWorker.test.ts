import { describe, expect, it, vi } from "vitest";
import { createRoutineProcessor } from "../src/routines/worker.js";
import { PhoneProviderError } from "../src/routines/phone.js";
import type { deliverRoutineChannel, prepareRoutineDelivery } from "../src/routines/transports.js";
import type { RoutineDelivery } from "../src/routines/store.js";
import { CALL, NOW, REQUEST, routineFixture, occurrenceFixture, runtimeFixture, mockRoutineStore, runFixture } from "./routineFixtures.js";

function harness() {
  const routine = routineFixture(); const occurrence = occurrenceFixture(routine);
  const state: { deliveries: RoutineDelivery[] } = { deliveries: [{ channel: "in_app", status: "pending", providerId: null,
    updatedAt: new Date(NOW).toISOString(), details: {} }] };
  const store = mockRoutineStore({ get: vi.fn(async () => routine), refresh: vi.fn(async () => occurrence),
    deliveries: vi.fn(async () => state.deliveries.map(item => ({ ...item }))), globalAllowed: vi.fn(async () => true), noteCallLookup: vi.fn(async () => {}),
    begin: vi.fn(async (_occ, channel) => {
      const row = state.deliveries.find(item => item.channel === channel)!;
      if (row.status !== "pending") return { started: false, reason: "already_attempted" };
      row.status = "sending"; return { started: true, reason: "started" };
    }),
    finish: vi.fn(async (_occ, channel, status, providerId, details) => {
      Object.assign(state.deliveries.find(item => item.channel === channel)!, { status, providerId, details }); return true;
    }), occurrenceForSlot: vi.fn(async () => null),
    sourceRuns: vi.fn(async () => ({ runs: [runFixture()], truncated: false })), claim: vi.fn(async () => occurrence),
    pending: vi.fn(async () => []), activePage: vi.fn(async () => [routine]),
  });
  const phone = { startPhoneCall: vi.fn(), lookupPhoneCall: vi.fn() };
  const prepare = vi.fn<typeof prepareRoutineDelivery>(async () => ({ phone: "+33600000000", email: "test@example.invalid" }));
  const deliver = vi.fn<typeof deliverRoutineChannel>(async () => ({ status: "completed" as const, providerId: CALL }));
  const runtime = runtimeFixture(); let clock = NOW;
  const processor = createRoutineProcessor({ store, phone, prepare, deliver, runtime, now: () => clock });
  return { routine, occurrence, state, store, phone, prepare, deliver, runtime, processor, setClock: (value: number) => { clock = value; } };
}

describe("durable routine orchestration", () => {
  it("recovers the same manual receipt before rebuilding or dispatching", async () => {
    const h = harness(); vi.mocked(h.store.occurrenceForSlot).mockResolvedValue(h.occurrence);
    h.runtime.enabled = false;
    expect(await h.processor.requestNow(h.routine, REQUEST)).toBe(h.occurrence);
    expect(h.store.claim).not.toHaveBeenCalled(); expect(h.store.sourceRuns).not.toHaveBeenCalled(); expect(h.deliver).not.toHaveBeenCalled();
  });
  it("does not reinterpret an old request under a new revision", async () => {
    const h = harness(); vi.mocked(h.store.occurrenceForSlot).mockResolvedValue({ ...h.occurrence, revision: 2 });
    await expect(h.processor.requestNow(h.routine, REQUEST)).rejects.toMatchObject({ code: "ROUTINE_CONFLICT" });
  });
  it.each(["disabled", "paused", "global stop"])("refuses manual admission during %s", async reason => {
    const h = harness();
    if (reason === "disabled") h.runtime.enabled = false;
    if (reason === "paused") h.routine.config.enabled = false;
    if (reason === "global stop") vi.mocked(h.store.globalAllowed).mockResolvedValue(false);
    await expect(h.processor.requestNow(h.routine, REQUEST)).rejects.toThrow(); expect(h.store.claim).not.toHaveBeenCalled();
  });
  it("persists a manual report but leaves delivery to the scheduler", async () => {
    const h = harness(); await h.processor.requestNow(h.routine, REQUEST);
    expect(h.store.claim).toHaveBeenCalledWith(h.routine, `manual:${REQUEST}`, new Date(NOW).toISOString(),
      new Date(NOW + 1_800_000).toISOString(), expect.objectContaining({ sourceCount: 1 }));
    expect(h.deliver).not.toHaveBeenCalled();
  });
  it("uses the last admitted briefing as the next report boundary", async () => {
    const h = harness(); h.routine.lastOccurrenceAt = new Date(NOW - 90_000).toISOString();
    await h.processor.requestNow(h.routine, REQUEST);
    expect(h.store.sourceRuns).toHaveBeenCalledWith(h.routine, h.routine.lastOccurrenceAt, new Date(NOW).toISOString());
  });
  it("rejects another owner's source before any claim", async () => {
    const h = harness(); vi.mocked(h.store.sourceRuns).mockResolvedValue({ runs: [runFixture(1, { user_id: REQUEST })], truncated: false });
    await expect(h.processor.requestNow(h.routine, REQUEST)).rejects.toThrow(); expect(h.store.claim).not.toHaveBeenCalled();
  });
  it("does not dispatch when a fresh atomic admission is refused", async () => {
    const h = harness(); vi.mocked(h.store.begin).mockResolvedValue({ started: false, reason: "paused" });
    await h.processor.processOccurrence(h.occurrence); expect(h.deliver).not.toHaveBeenCalled();
  });
  it("checks the revision again after admission and before external dispatch", async () => {
    const h = harness(); vi.mocked(h.store.get).mockResolvedValueOnce(h.routine).mockResolvedValue({ ...h.routine, revision: 2 });
    await h.processor.processOccurrence(h.occurrence); expect(h.deliver).not.toHaveBeenCalled();
    expect(h.store.finish).toHaveBeenCalledWith(h.occurrence, "in_app", "skipped", null, expect.objectContaining({ effect: "none" }));
  });
  it("honors shutdown after a slow preparation", async () => {
    const h = harness(); let active = true; h.prepare.mockImplementation(async () => { active = false; return { phone: null, email: null }; });
    await h.processor.processOccurrence(h.occurrence, () => active);
    expect(h.store.begin).not.toHaveBeenCalled(); expect(h.deliver).not.toHaveBeenCalled();
  });
  it("never retries an uncertain phone POST", async () => {
    const h = harness(); h.routine.config.channels = ["call"]; h.state.deliveries[0].channel = "call";
    h.deliver.mockRejectedValue(new Error("lost response"));
    await h.processor.processOccurrence(h.occurrence); await h.processor.processOccurrence(h.occurrence);
    expect(h.deliver).toHaveBeenCalledOnce(); expect(h.state.deliveries[0].status).toBe("unknown");
  });
  it("classifies a proven preflight rejection as failed without an uncertain effect", async () => {
    const h = harness(); h.deliver.mockRejectedValue(new PhoneProviderError("PHONE_INPUT_INVALID", "not_sent"));
    await h.processor.processOccurrence(h.occurrence); expect(h.state.deliveries[0].status).toBe("failed");
  });
  it("keeps an independent channel working when a parallel call is uncertain", async () => {
    const h = harness(); h.routine.config.channels = ["call", "in_app"];
    h.state.deliveries.unshift({ channel: "call", status: "unknown", providerId: null, updatedAt: new Date(NOW).toISOString(), details: {} });
    await h.processor.processOccurrence(h.occurrence); expect(h.deliver).toHaveBeenCalledOnce();
    expect(h.deliver.mock.calls[0][0]).toBe("in_app");
  });
  it("does not advance fallback while the call is unresolved", async () => {
    const h = harness(); h.routine.config.deliveryMode = "fallback"; h.routine.config.channels = ["call", "in_app"];
    h.state.deliveries.unshift({ channel: "call", status: "unknown", providerId: null, updatedAt: new Date(NOW).toISOString(), details: {} });
    await h.processor.processOccurrence(h.occurrence); expect(h.deliver).not.toHaveBeenCalled();
  });
  it("resolves a voicemail using GET and releases the written fallback", async () => {
    const h = harness(); h.routine.config.deliveryMode = "fallback"; h.routine.config.channels = ["call", "in_app"];
    h.state.deliveries.unshift({ channel: "call", status: "accepted", providerId: CALL, updatedAt: new Date(NOW - 90_000).toISOString(), details: {} });
    h.phone.lookupPhoneCall.mockResolvedValue({ callId: CALL, externalId: h.occurrence.id, status: "completed", answeredBy: "voicemail" });
    await h.processor.processOccurrence(h.occurrence); expect(h.phone.lookupPhoneCall).toHaveBeenCalledWith(CALL);
    expect(h.phone.startPhoneCall).not.toHaveBeenCalled(); expect(h.deliver).toHaveBeenCalledOnce();
  });
  it("rejects a reconciliation receipt attached to a different occurrence", async () => {
    const h = harness(); h.phone.lookupPhoneCall.mockResolvedValue({ callId: CALL, externalId: REQUEST, status: "completed" });
    await h.processor.reconcileCall(h.occurrence, { channel: "call", status: "unknown", providerId: CALL, updatedAt: new Date(NOW - 90_000).toISOString(), details: {} });
    expect(h.store.finish).not.toHaveBeenCalled();
  });
  it("still reconciles an already sent call during a global stop without sending another channel", async () => {
    const h = harness(); h.routine.config.channels = ["call", "in_app"];
    h.state.deliveries.unshift({ channel: "call", status: "accepted", providerId: CALL, updatedAt: new Date(NOW - 90_000).toISOString(), details: {} });
    h.phone.lookupPhoneCall.mockResolvedValue({ callId: CALL, externalId: h.occurrence.id, status: "completed", answeredBy: "voicemail" });
    vi.mocked(h.store.globalAllowed).mockResolvedValue(false);
    await h.processor.tick(new Date(NOW));
    await h.processor.processOccurrence(h.occurrence);
    expect(h.phone.lookupPhoneCall).toHaveBeenCalledWith(CALL); expect(h.deliver).not.toHaveBeenCalled();
    expect(h.store.activePage).not.toHaveBeenCalled();
  });
  it("can record a terminal receipt after cancellation without resuming delivery", async () => {
    const h = harness(); h.occurrence.status = "cancelled";
    h.state.deliveries = [{ channel: "call", status: "unknown", providerId: CALL, updatedAt: new Date(NOW - 90_000).toISOString(), details: {} }];
    h.phone.lookupPhoneCall.mockResolvedValue({ callId: CALL, externalId: h.occurrence.id, status: "failed" });
    await h.processor.processOccurrence(h.occurrence);
    expect(h.store.finish).toHaveBeenCalledWith(h.occurrence, "call", "failed", CALL, expect.objectContaining({ reconciled: true }));
    expect(h.deliver).not.toHaveBeenCalled();
  });
  it("detects a completion beyond the three displayed priority items", async () => {
    const h = harness(); h.routine.config.schedule = { kind: "event", event: "completed", timezone: "Europe/Paris" };
    vi.mocked(h.store.sourceRuns).mockResolvedValue({ runs: [1, 2, 3].map(i => runFixture(i, { status: "error" })).concat(runFixture(4)), truncated: false });
    vi.mocked(h.store.refresh).mockResolvedValue({ ...h.occurrence, status: "completed" });
    await h.processor.tick(new Date(NOW));
    expect(h.store.claim).toHaveBeenCalledOnce();
    expect(vi.mocked(h.store.claim).mock.calls[0][4].items).toHaveLength(3);
    expect(vi.mocked(h.store.claim).mock.calls[0][4].items.every(item => item.status === "error")).toBe(true);
  });
  it.each([{ mode: "simulation" }, { claude_mock: true }])("does not report a simulated completion as a real event %#", async override => {
    const h = harness(); h.routine.config.schedule = { kind: "event", event: "completed", timezone: "Europe/Paris" };
    vi.mocked(h.store.sourceRuns).mockResolvedValue({ runs: [runFixture(1, override)], truncated: false });
    await h.processor.tick(new Date(NOW)); expect(h.store.claim).not.toHaveBeenCalled();
  });
  it("uses the same completed minute slot across repeated ten-second ticks", async () => {
    const h = harness(); h.routine.config.schedule = { kind: "event", event: "decision", timezone: "Europe/Paris" };
    vi.mocked(h.store.sourceRuns).mockResolvedValue({ runs: [runFixture(1, { status: "awaiting_approval" })], truncated: false });
    vi.mocked(h.store.refresh).mockResolvedValue({ ...h.occurrence, status: "completed" });
    await h.processor.tick(new Date(NOW)); h.setClock(NOW + 10_000); await h.processor.tick(new Date(NOW + 10_000));
    expect(vi.mocked(h.store.claim).mock.calls.map(call => call[1])).toEqual([
      `event:decision:${new Date(NOW).toISOString()}`, `event:decision:${new Date(NOW).toISOString()}`]);
    expect(vi.mocked(h.store.sourceRuns).mock.calls[0][1]).toBe(new Date(NOW - 60_000).toISOString());
  });
  it("does not admit work from a stale scheduler tick", async () => {
    const h = harness(); await h.processor.tick(new Date(NOW - 120_001)); expect(h.store.pending).not.toHaveBeenCalled();
  });
  it("does not claim a manual occurrence after shutdown during the report read", async () => {
    const h = harness(); let active = true;
    vi.mocked(h.store.sourceRuns).mockImplementation(async () => { active = false; return { runs: [runFixture()], truncated: false }; });
    await expect(h.processor.requestNow(h.routine, REQUEST, () => active)).rejects.toThrow(); expect(h.store.claim).not.toHaveBeenCalled();
  });
  it("does not claim a scheduled occurrence after shutdown during the report read", async () => {
    const h = harness(); let active = true;
    vi.mocked(h.store.sourceRuns).mockImplementation(async () => { active = false; return { runs: [runFixture()], truncated: false }; });
    await h.processor.tick(new Date(NOW), () => active); expect(h.store.claim).not.toHaveBeenCalled();
  });
});
