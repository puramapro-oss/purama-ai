import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), notify: vi.fn(), preferences: vi.fn(), list: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { from: () => ({ select: () => ({ gte: mocks.read }) }) } }));
vi.mock("../src/engine/notify.js", () => ({ notify: mocks.notify }));
vi.mock("../src/routines/store.js", () => ({ routineStore: { preferences: mocks.preferences, list: mocks.list } }));
import { runDailyReport } from "../src/scheduler/dailyReport.js";
import { OWNER, REQUEST, routineFixture } from "./routineFixtures.js";
const row = (overrides = {}) => ({ user_id: OWNER, agent_type: "email", status: "success", mode: "live", claude_mock: false, ...overrides });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("IAO_ROUTINES_ENABLED", "false");
  mocks.read.mockResolvedValue({ data: [row()], error: null }); mocks.notify.mockResolvedValue(undefined);
  mocks.preferences.mockResolvedValue(null); mocks.list.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());
describe("legacy daily digest regression and routine coexistence", () => {
  it("does not double count simulations or mock decisions as real successes", async () => {
    mocks.read.mockResolvedValue({ data: [row(), row({ mode: "simulation" }), row({ claude_mock: true }), row({ status: "simulated" }),
      row({ status: "error", mode: "simulation" }), row({ status: "awaiting_approval" }), row({ status: "skipped" })], error: null });
    await runDailyReport(); const body = mocks.notify.mock.calls[0][0].body;
    expect(body).toContain("7 cycle(s) enregistré(s)"); expect(body).toContain("1 réussi(s) hors simulation");
    expect(body).toContain("3 simulé(s)"); expect(body).toContain("1 en erreur"); expect(body).toContain("1 ignoré(s)");
  });
  it("retains unclassified work as an explicit other status", async () => {
    mocks.read.mockResolvedValue({ data: [row({ status: "running" }), row({ status: "partial" })], error: null });
    await runDailyReport(); expect(mocks.notify.mock.calls[0][0].body).toContain("2 en cours ou de statut à vérifier");
  });
  it("continues other users after a notification outcome is uncertain, without retrying", async () => {
    mocks.read.mockResolvedValue({ data: [row(), row({ user_id: REQUEST })], error: null });
    mocks.notify.mockRejectedValueOnce(new Error("unconfirmed"));
    await expect(runDailyReport()).rejects.toBeInstanceOf(AggregateError);
    expect(mocks.notify.mock.calls.map(call => call[0].userId)).toEqual([OWNER, REQUEST]);
  });
  it("does not invent a report after source failure", async () => {
    mocks.read.mockResolvedValue({ data: null, error: { message: "private-error" } });
    await expect(runDailyReport()).rejects.not.toThrow("private-error"); expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("honors the existing daily-report opt out", async () => {
    mocks.preferences.mockResolvedValue({ daily_report_enabled: false }); await runDailyReport(); expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("honors the existing email opt out while retaining the written in-app report", async () => {
    mocks.preferences.mockResolvedValue({ email_enabled: false }); await runDailyReport();
    expect(mocks.notify.mock.calls[0][0].channels).toEqual(["in_app"]);
  });
  it("fails closed on an unreadable preference while continuing another user", async () => {
    mocks.read.mockResolvedValue({ data: [row(), row({ user_id: REQUEST })], error: null }); mocks.preferences.mockRejectedValueOnce(new Error("unavailable"));
    await expect(runDailyReport()).rejects.toThrow(); expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify.mock.calls[0][0].userId).toBe(REQUEST);
  });
  it.each([true, false])("does not reactivate the generic digest when a custom recurring routine enabled=%s exists", async enabled => {
    vi.stubEnv("IAO_ROUTINES_ENABLED", "true"); const routine = routineFixture(); routine.config.enabled = enabled;
    mocks.list.mockResolvedValue([routine]); await runDailyReport(); expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("retains the generic digest when only an event routine exists", async () => {
    vi.stubEnv("IAO_ROUTINES_ENABLED", "true"); const routine = routineFixture(); routine.config.schedule = { kind: "event", event: "blocked", timezone: "Europe/Paris" };
    mocks.list.mockResolvedValue([routine]); await runDailyReport(); expect(mocks.notify).toHaveBeenCalledOnce();
  });
  it("stops after a preference read that crossed shutdown", async () => {
    let active = true; mocks.preferences.mockImplementation(async () => { active = false; return null; });
    await runDailyReport(() => active); expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("does nothing for an empty activity period", async () => {
    mocks.read.mockResolvedValue({ data: [], error: null }); await runDailyReport(); expect(mocks.notify).not.toHaveBeenCalled();
  });
});
