import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoutineService } from "../src/routines/service.js";
import type { Routine, RoutineInput } from "../src/routines/contracts.js";
import type { RoutineRuntimeConfig } from "../src/routines/runtime.js";
import { routineStore, RoutineError, type RoutineOccurrence } from "../src/routines/store.js";

vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: { email: { type: "email" }, legal: { type: "legal" } } }));

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const ID = "00000000-0000-4000-8000-000000000003";
const OCC = "00000000-0000-4000-8000-000000000004";
const REQUEST = "00000000-0000-4000-8000-000000000005";
const COMMAND = "00000000-0000-4000-8000-000000000006";
const AT = "2026-11-28T10:00:00.000Z";
const configuration = (extra: Partial<RoutineInput> = {}): RoutineInput => ({
  name: "Matin", instruction: "Présente le bilan et les décisions attendues.", enabled: true,
  schedule: { kind: "daily", time: "08:30", timezone: "UTC" }, channels: ["in_app"], deliveryMode: "parallel",
  agentTypes: [], length: "standard", quietHours: null, pausedUntil: null, onlyIfNew: true,
  maxCallMinutes: 2, monthlyCallMinutes: 30, ...extra,
});
const routine = (config: RoutineInput = configuration(), extra: Partial<Routine> = {}): Routine => ({
  id: ID, userId: USER, revision: 1, config, createdAt: AT, updatedAt: AT, lastOccurrenceAt: null, ...extra,
});
const occurrence = (): RoutineOccurrence => ({
  id: OCC, userId: USER, routineId: ID, revision: 1, slot: `manual:${REQUEST}`, scheduledAt: AT,
  expiresAt: "2026-11-28T10:30:00.000Z", status: "pending",
  report: { title: "Bilan IAO", body: "Aucune activité enregistrée dans cette fenêtre.", sourceCount: 0, hasNewActivity: false,
    window: { since: "2026-11-27T10:00:00.000Z", until: AT }, items: [],
    counts: { success: 0, error: 0, awaiting: 0, simulated: 0, running: 0, skipped: 0, other: 0 }, truncated: false },
});
const runtimeConfig = (): RoutineRuntimeConfig => ({ enabled: true, pushEnabled: true,
  commandSecret: "synthetic-command-secret-with-32-characters",
  phone: { enabled: true, apiKey: "synthetic-phone-key", agentId: ID, webhookSecret: "synthetic-webhook-secret",
    webhookUrl: "https://iao.example.invalid/callback" },
});
const preferences = () => ({ user_id: USER, email_enabled: true, daily_report_enabled: true,
  task_completed_enabled: true, question_enabled: true, alert_enabled: true });
function harness(runtime: RoutineRuntimeConfig = runtimeConfig(), emailConfigured = true) {
  const store = { ...routineStore,
    list: vi.fn(async () => [routine()]), history: vi.fn(async () => [] as Awaited<ReturnType<typeof routineStore.history>>),
    commands: vi.fn(async () => [] as Record<string, unknown>[]),
    destination: vi.fn(async () => ({ phone: "+33612345678" as string | null, email: "user@example.invalid" as string | null })),
    preferences: vi.fn(async () => preferences() as Record<string, unknown> | null),
    get: vi.fn(async (_userId: string, _id: string) => routine()),
    save: vi.fn(async (userId: string, id: string, expectedRevision: number, config: RoutineInput) =>
      routine(config, { userId, id, revision: expectedRevision + 1 })),
    pauseAll: vi.fn(async (_userId: string) => 2), cancel: vi.fn(async (_userId: string, _id: string) => undefined),
    deliveries: vi.fn(async (_occurrence: RoutineOccurrence) => [{ channel: "in_app" as const, status: "pending" as const,
      providerId: null, updatedAt: AT, details: {} }]),
    begin: vi.fn(routineStore.begin), finish: vi.fn(routineStore.finish),
  };
  const requestNow = vi.fn(async (_routine: Routine, _requestId: string): Promise<RoutineOccurrence | null> => occurrence());
  return { store, requestNow, service: createRoutineService({ store, runtime, requestNow, now: () => Date.parse(AT), emailConfigured }) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("routine service account and input boundary", () => {
  it.each([
    null, [], { action: "unknown" }, { action: "list", userId: OTHER }, { action: "list", tenantId: OTHER },
    { action: "preview", config: configuration(), phoneNumber: "+33699999999" },
    { action: "save", id: ID, expectedRevision: -1, config: configuration() },
    { action: "save", id: ID, expectedRevision: 1, config: { ...configuration(), user_id: OTHER } },
    { action: "pause", id: ID, expectedRevision: 0, pausedUntil: null },
    { action: "pause", id: ID, expectedRevision: 1, pausedUntil: "2026-02-30T10:00:00Z" },
    { action: "pause", id: ID, expectedRevision: 1, pausedUntil: null, enabled: "false" },
    { action: "run-now", id: ID, expectedRevision: 1, requestId: "new-random-key" },
    { action: "run-now", id: ID, expectedRevision: 1, requestId: REQUEST, user_id: OTHER },
    { action: "cancel", occurrenceId: OCC, force: true },
  ])("rejects malformed or additional fields %# before accessing an account", async body => {
    const { service, store, requestNow } = harness();
    await expect(service.handle(USER, body)).rejects.toMatchObject({ status: 400 });
    for (const operation of [store.get, store.list, store.save, store.destination, store.preferences, store.cancel, requestNow]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("uses only the trusted owner for account reads", async () => {
    const { service, store } = harness();
    await service.handle(USER, { action: "list" });
    for (const operation of [store.list, store.history, store.commands, store.destination, store.preferences]) expect(operation).toHaveBeenCalledWith(USER);
  });

  it("rejects a foreign stored routine instead of returning or mutating it", async () => {
    const { service, store } = harness();
    store.list.mockResolvedValue([routine(configuration(), { userId: OTHER })]);
    await expect(service.handle(USER, { action: "list" })).rejects.toMatchObject({ code: "ROUTINE_UNAVAILABLE" });
    store.get.mockResolvedValue(routine(configuration(), { userId: OTHER }));
    await expect(service.handle(USER, { action: "pause", id: ID, expectedRevision: 1, enabled: false, pausedUntil: null }))
      .rejects.toMatchObject({ code: "ROUTINE_UNAVAILABLE" });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("rejects preferences for another account and never turns a failed list into an empty list", async () => {
    const { service, store } = harness();
    store.preferences.mockResolvedValue({ ...preferences(), user_id: OTHER });
    await expect(service.handle(USER, { action: "list" })).rejects.toMatchObject({ code: "ROUTINE_UNAVAILABLE" });
    store.preferences.mockResolvedValue(preferences());
    store.list.mockRejectedValue(new RoutineError("ROUTINE_UNAVAILABLE"));
    await expect(service.handle(USER, { action: "list" })).rejects.toMatchObject({ code: "ROUTINE_UNAVAILABLE" });
  });
});

describe("routine service availability and receipts", () => {
  it("keeps account reads available when dispatch is disabled and reports actual capability limits", async () => {
    const { service } = harness({ ...runtimeConfig(), enabled: false });
    await expect(service.handle(USER, { action: "list" })).resolves.toMatchObject({ ok: true, routines: [routine()],
      capabilities: { routines: false, calls: false, email: false, push: false, verifiedPhone: "+•• •••• 5678",
        voiceCommands: "confirmation_required", agents: [{ type: "email", name: "Courrier" }, { type: "legal", name: "Juridique" }] } });
  });

  it.each(["provider-disabled", "missing-key", "short-command-secret", "unverified-phone"])("refuses phone capability when %s", async reason => {
    const runtime = runtimeConfig();
    if (reason === "provider-disabled") runtime.phone.enabled = false;
    if (reason === "missing-key") runtime.phone.apiKey = "";
    if (reason === "short-command-secret") runtime.commandSecret = "short";
    const { service, store } = harness(runtime);
    if (reason === "unverified-phone") store.destination.mockResolvedValue({ phone: null, email: "user@example.invalid" });
    await expect(service.handle(USER, { action: "list" })).resolves.toMatchObject({ capabilities: { calls: false, phoneBlockedReason: expect.any(String) } });
    await expect(service.handle(USER, { action: "save", id: ID, expectedRevision: 0, config: configuration({ channels: ["call"] }) }))
      .rejects.toMatchObject({ code: "ROUTINE_CHANNEL_UNAVAILABLE" });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("requires configured email, a verified address and an enabled email preference", async () => {
    const { service, store } = harness();
    await expect(service.handle(USER, { action: "list" })).resolves.toMatchObject({ capabilities: { email: true } });
    store.preferences.mockResolvedValue({ ...preferences(), email_enabled: false });
    await expect(service.handle(USER, { action: "list" })).resolves.toMatchObject({ capabilities: { email: false } });
    store.preferences.mockResolvedValue(null);
    await expect(service.handle(USER, { action: "list" })).resolves.toMatchObject({ capabilities: { email: true } });
    store.destination.mockResolvedValue({ phone: "+33612345678", email: null });
    await expect(service.handle(USER, { action: "list" })).resolves.toMatchObject({ capabilities: { email: false } });
    await expect(harness(runtimeConfig(), false).service.handle(USER, { action: "list" })).resolves.toMatchObject({ capabilities: { email: false } });
  });

  it("returns only public history and captured commands, without tokens or vendor detail", async () => {
    const { service, store } = harness();
    const item = occurrence();
    store.history.mockResolvedValue([{ id: item.id, routineId: item.routineId, scheduledAt: item.scheduledAt,
      status: "processing", report: item.report, deliveries: [{ channel: "call", status: "accepted", providerId: "hidden-provider-id" }],
      token: "hidden-capture-token" } as unknown as Awaited<ReturnType<typeof routineStore.history>>[number]]);
    store.commands.mockResolvedValue([{ id: COMMAND, occurrenceId: OCC, instruction: "Continue le projet dans IAO.",
      status: "pending_confirmation", createdAt: AT, token: "hidden-capture-token" }]);
    const result = await service.handle(USER, { action: "list" });
    expect(result).toMatchObject({ history: [{ status: "processing", deliveries: [{ channel: "call", status: "accepted" }] }],
      commands: [{ status: "pending_confirmation" }] });
    expect(JSON.stringify(result)).not.toContain("hidden-");
    expect(JSON.stringify(result)).not.toContain("heardConfirmed");
    expect(JSON.stringify(result)).not.toContain("+33612345678");
  });

  it("rejects invalid history and oversized listings instead of publishing casts", async () => {
    const { service, store } = harness();
    store.commands.mockResolvedValue([{ id: COMMAND, occurrenceId: OCC, instruction: "Demande", status: "executed", createdAt: AT }]);
    await expect(service.handle(USER, { action: "list" })).rejects.toMatchObject({ code: "ROUTINE_UNAVAILABLE" });
    store.commands.mockResolvedValue([]);
    store.list.mockResolvedValue(Array.from({ length: 101 }, () => routine()));
    await expect(service.handle(USER, { action: "list" })).rejects.toMatchObject({ code: "ROUTINE_UNAVAILABLE" });
  });
});

describe("routine service changes", () => {
  it("previews real future dates while runtime dispatch is disabled, with no save or call", async () => {
    const { service, store, requestNow } = harness({ ...runtimeConfig(), enabled: false });
    await expect(service.handle(USER, { action: "preview", config: configuration() })).resolves.toEqual({ ok: true,
      occurrences: ["2026-11-29T08:30:00.000Z", "2026-11-30T08:30:00.000Z", "2026-12-01T08:30:00.000Z"] });
    expect(store.save).not.toHaveBeenCalled(); expect(requestNow).not.toHaveBeenCalled(); expect(store.destination).not.toHaveBeenCalled();
  });

  it("saves normalized inactive settings even when their provider and runtime are unavailable", async () => {
    const { service, store } = harness({ ...runtimeConfig(), enabled: false });
    const config = configuration({ name: "  Matin  ", enabled: false, channels: ["call"] });
    await expect(service.handle(USER, { action: "save", id: ID, expectedRevision: 0, config })).resolves.toMatchObject({
      routine: { revision: 1, config: { name: "Matin", enabled: false, channels: ["call"] } },
    });
    expect(store.save).toHaveBeenCalledWith(USER, ID, 0, { ...config, name: "Matin" });
    expect(store.destination).not.toHaveBeenCalled();
    await expect(service.handle(USER, { action: "save", id: ID, expectedRevision: 0, config: configuration() }))
      .rejects.toMatchObject({ code: "ROUTINE_DISABLED" });
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it("checks the relevant notification preference before activating an event routine", async () => {
    const { service, store } = harness();
    store.preferences.mockResolvedValue({ ...preferences(), question_enabled: false });
    await expect(service.handle(USER, { action: "save", id: ID, expectedRevision: 0,
      config: configuration({ schedule: { kind: "event", event: "decision", timezone: "UTC" } }) }))
      .rejects.toMatchObject({ code: "ROUTINE_PREFERENCE_DISABLED" });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("preserves an actual idempotent save receipt and refuses a contradictory receipt", async () => {
    const { service, store } = harness();
    store.save.mockResolvedValue(routine());
    await expect(service.handle(USER, { action: "save", id: ID, expectedRevision: 1, config: configuration() }))
      .resolves.toMatchObject({ routine: { revision: 1 } });
    store.save.mockResolvedValue(routine(configuration({ enabled: false }), { revision: 2 }));
    await expect(service.handle(USER, { action: "save", id: ID, expectedRevision: 1, config: configuration() }))
      .rejects.toMatchObject({ code: "ROUTINE_UNAVAILABLE" });
  });

  it("allows stopping and extending a pause during an outage, but never re-enables through pause", async () => {
    const { service, store } = harness({ ...runtimeConfig(), enabled: false });
    await expect(service.handle(USER, { action: "pause", id: ID, expectedRevision: 1, pausedUntil: null, enabled: false }))
      .resolves.toMatchObject({ routine: { config: { enabled: false }, revision: 2 } });
    await expect(service.handle(USER, { action: "pause", id: ID, expectedRevision: 1, pausedUntil: "2026-11-29T10:00:00Z" }))
      .resolves.toMatchObject({ routine: { config: { pausedUntil: "2026-11-29T10:00:00.000Z" } } });
    store.get.mockResolvedValue(routine(configuration({ enabled: false })));
    await expect(service.handle(USER, { action: "pause", id: ID, expectedRevision: 1, pausedUntil: null, enabled: true }))
      .rejects.toMatchObject({ code: "ROUTINE_DISABLED" });
    expect(store.save).toHaveBeenCalledTimes(2); expect(store.destination).not.toHaveBeenCalled();
  });

  it("passes the expected revision and refuses stale pause requests before mutation", async () => {
    const { service, store } = harness();
    store.get.mockResolvedValue(routine(configuration(), { revision: 2 }));
    await expect(service.handle(USER, { action: "pause", id: ID, expectedRevision: 1, pausedUntil: null, enabled: false }))
      .rejects.toMatchObject({ code: "ROUTINE_CONFLICT" });
    expect(store.save).not.toHaveBeenCalled();
  });
});

describe("routine manual requests and cancellation", () => {
  const run = { action: "run-now", id: ID, expectedRevision: 1, requestId: REQUEST };
  it("preserves the stable request ID and returns pending without attempting delivery itself", async () => {
    const { service, store, requestNow } = harness();
    await expect(service.handle(USER, run)).resolves.toMatchObject({ ok: true, occurrence: { id: OCC, routineId: ID,
      status: "pending", deliveries: [{ channel: "in_app", status: "pending" }] } });
    await service.handle(USER, run);
    expect(requestNow).toHaveBeenCalledTimes(2);
    expect(requestNow).toHaveBeenNthCalledWith(1, routine(), REQUEST);
    expect(requestNow).toHaveBeenNthCalledWith(2, routine(), REQUEST);
    expect(store.begin).not.toHaveBeenCalled(); expect(store.finish).not.toHaveBeenCalled();
  });

  it("does not admit a manual request when disabled, stale or in quiet hours", async () => {
    const disabled = harness({ ...runtimeConfig(), enabled: false });
    await expect(disabled.service.handle(USER, run)).rejects.toMatchObject({ code: "ROUTINE_DISABLED" });
    expect(disabled.requestNow).not.toHaveBeenCalled();
    const { service, store, requestNow } = harness();
    store.get.mockResolvedValue(routine(configuration(), { revision: 2 }));
    await expect(service.handle(USER, run)).rejects.toMatchObject({ code: "ROUTINE_CONFLICT" });
    store.get.mockResolvedValue(routine(configuration({ quietHours: { start: "09:00", end: "11:00" } })));
    await expect(service.handle(USER, run)).rejects.toMatchObject({ code: "ROUTINE_PAUSED" });
    expect(requestNow).not.toHaveBeenCalled();
  });

  it("does not convert refused or foreign claims into success and never retries an uncertain claim", async () => {
    const { service, store, requestNow } = harness();
    requestNow.mockResolvedValueOnce(null);
    await expect(service.handle(USER, run)).rejects.toMatchObject({ code: "ROUTINE_REJECTED", status: 409 });
    expect(store.deliveries).not.toHaveBeenCalled();
    requestNow.mockResolvedValueOnce({ ...occurrence(), userId: OTHER });
    await expect(service.handle(USER, run)).rejects.toMatchObject({ code: "ROUTINE_UNAVAILABLE" });
    requestNow.mockRejectedValueOnce(new RoutineError("ROUTINE_UNAVAILABLE"));
    await expect(service.handle(USER, run)).rejects.toMatchObject({ code: "ROUTINE_UNAVAILABLE" });
    expect(requestNow).toHaveBeenCalledTimes(3);
  });

  it("keeps owner-scoped cancellation and pause-all available during outages without claiming external cancellation", async () => {
    const { service, store, requestNow } = harness({ ...runtimeConfig(), enabled: false });
    await expect(service.handle(USER, { action: "cancel", occurrenceId: OCC })).resolves.toEqual({ ok: true, cancelled: true, occurrenceId: OCC });
    expect(store.cancel).toHaveBeenCalledWith(USER, OCC);
    await expect(service.handle(USER, { action: "pause-all" })).resolves.toEqual({ ok: true, updatedCount: 2 });
    expect(store.pauseAll).toHaveBeenCalledWith(USER);
    expect(store.destination).not.toHaveBeenCalled(); expect(requestNow).not.toHaveBeenCalled();
    store.cancel.mockRejectedValue(new RoutineError("ROUTINE_UNAVAILABLE"));
    await expect(service.handle(USER, { action: "cancel", occurrenceId: OCC })).rejects.toMatchObject({ code: "ROUTINE_UNAVAILABLE" });
  });
});
