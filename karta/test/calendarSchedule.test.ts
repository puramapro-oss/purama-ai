import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../src/engine/types.js";

const dependencies = vi.hoisted(() => ({ getToken: vi.fn(), assertCurrent: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: {} }));
vi.mock("../src/tools/google-calendar-connection.js", async (original) => ({
  ...await original<typeof import("../src/tools/google-calendar-connection.js")>(),
  getGoogleCalendarConnection: dependencies.getToken,
}));
import { calendarCreateEventTool } from "../src/tools/calendar.js";

const context: ToolExecutionContext = {
  userId: "calendar-schedule-user", agentType: "planificateur-d-appels", mode: "live",
  operationId: "calendar-schedule-operation",
};
const appointment = {
  title: "Rappel demandé", startIso: "2026-11-23T10:30:00+01:00", endIso: "2026-11-23T11:00:00+01:00",
  timeZone: "Europe/Paris",
};
let transport: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  dependencies.assertCurrent.mockReset().mockResolvedValue(undefined);
  dependencies.getToken.mockReset().mockResolvedValue({ accessToken: "calendar-test-only-token", assertCurrent: dependencies.assertCurrent });
  transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "calendar-scheduled-event" }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  // Real Calendar, OAuth, email invitations and telephone providers are never reached.
  vi.stubGlobal("fetch", transport);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("calendar appointment instants", () => {
  it.each([
    "2026-11-23T10:30:00", "2026-11-23", "2026-11-23 10:30:00+01:00",
    "Mon, 23 Nov 2026 10:30:00 GMT", "2026-02-30T10:30:00+01:00",
    "2026-11-31T10:30:00+01:00", "2027-02-29T10:30:00+01:00",
    "2026-11-23T24:00:00+01:00", "2026-11-23T10:30:60+01:00",
    "2026-11-23T10:30:00-00:00", "2026-11-23T10:30:00+25:00",
    "2026-11-23T10:30:00+01:60", "2026-11-23T10:30:00.0001+01:00",
  ])("rejects an ambiguous, impossible or unsupported instant before I/O: %s", async (startIso) => {
    await expect(calendarCreateEventTool.execute({ ...appointment, startIso }, context)).rejects.toThrow();
    expect(dependencies.getToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("also validates the end instead of accepting Date.parse rollover", async () => {
    await expect(calendarCreateEventTool.execute({
      ...appointment, startIso: "2026-02-28T10:30:00+01:00", endIso: "2026-02-30T11:00:00+01:00",
    }, context)).rejects.toThrow();
    expect(dependencies.getToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("preserves an explicit UTC instant for a generic reservation without a named zone", async () => {
    await expect(calendarCreateEventTool.execute({
      title: "Réservation", startIso: "2026-11-23T09:30:00Z", endIso: "2026-11-23T10:00:00Z",
    }, { ...context, agentType: "reservation-intelligente" })).resolves.toEqual({ eventId: "calendar-scheduled-event" });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).start).toEqual({ dateTime: "2026-11-23T09:30:00Z" });
  });
});

describe("call appointment time zone", () => {
  it.each([undefined, "", "Invalid/Unknown", " Europe/Paris", "+01:00"])(
    "refuses a missing, invalid or offset-only recipient zone: %j", async (timeZone) => {
      await expect(calendarCreateEventTool.execute({ ...appointment, timeZone }, context)).rejects.toThrow();
      expect(dependencies.getToken).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["2026-07-23T10:30:00+01:00", "2026-07-23T11:00:00+01:00"],
    ["2026-11-23T10:30:00+02:00", "2026-11-23T11:00:00+02:00"],
    ["2026-11-23T10:30:00+01:00", "2026-11-23T11:30:00+02:00"],
    ["2026-03-29T02:30:00+01:00", "2026-03-29T04:00:00+02:00"],
    ["2026-03-29T02:30:00+02:00", "2026-03-29T04:00:00+02:00"],
  ])("rejects local clock/zone disagreement including the skipped DST hour: %s", async (startIso, endIso) => {
    await expect(calendarCreateEventTool.execute({ ...appointment, startIso, endIso }, context)).rejects.toThrow();
    expect(dependencies.getToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["Europe/Paris", "2026-11-23T10:30:00+01:00", "2026-11-23T11:00:00+01:00"],
    ["Europe/Paris", "2026-07-23T10:30:00+02:00", "2026-07-23T11:00:00+02:00"],
    ["Europe/Paris", "2026-03-29T01:30:00+01:00", "2026-03-29T03:30:00+02:00"],
    ["Europe/Paris", "2026-10-25T02:15:00+02:00", "2026-10-25T02:45:00+02:00"],
    ["Europe/Paris", "2026-10-25T02:15:00+01:00", "2026-10-25T02:45:00+01:00"],
    ["Asia/Kathmandu", "2026-11-23T10:30:00+05:45", "2026-11-23T11:00:00+05:45"],
    ["Australia/Lord_Howe", "2026-06-23T10:30:00+10:30", "2026-06-23T11:00:00+10:30"],
    ["UTC", "2026-11-23T10:30:00Z", "2026-11-23T11:00:00Z"],
  ])("transmits the supplied zone and exact instants without choosing an offset: %s %s", async (timeZone, startIso, endIso) => {
    const requested = { ...appointment, timeZone, startIso, endIso };
    const before = { ...requested };
    await expect(calendarCreateEventTool.execute(requested, context)).resolves.toEqual({ eventId: "calendar-scheduled-event" });
    const sent = JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(sent.start).toEqual({ dateTime: startIso, timeZone });
    expect(sent.end).toEqual({ dateTime: endIso, timeZone });
    expect(requested).toEqual(before);
  });
});

describe("call appointment admission before Calendar POST", () => {
  it.each([0, 1])("refuses a call appointment at or after its start (+%i ms)", async (lateBy) => {
    vi.setSystemTime(new Date(Date.parse(appointment.startIso) + lateBy));
    await expect(calendarCreateEventTool.execute(appointment, context)).rejects.toThrow();
    expect(dependencies.getToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("rechecks the exact boundary after OAuth has delayed preparation", async () => {
    vi.setSystemTime(new Date(Date.parse(appointment.startIso) - 1000));
    dependencies.getToken.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(appointment.startIso));
      return { accessToken: "calendar-test-only-token", assertCurrent: dependencies.assertCurrent };
    });
    await expect(calendarCreateEventTool.execute(appointment, context)).rejects.toThrow();
    expect(dependencies.getToken).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it("permits preparation immediately before the future boundary", async () => {
    vi.setSystemTime(new Date(Date.parse(appointment.startIso) - 1));
    await expect(calendarCreateEventTool.execute(appointment, context)).resolves.toEqual({ eventId: "calendar-scheduled-event" });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("stops before Calendar if the connection was revoked after preparation", async () => {
    dependencies.assertCurrent.mockRejectedValueOnce(new Error("Connexion Calendar modifiée ou révoquée"));
    await expect(calendarCreateEventTool.execute(appointment, context)).rejects.toThrow("révoquée");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rechecks lateness after the final connection reread as well", async () => {
    dependencies.assertCurrent.mockImplementationOnce(async () => { vi.setSystemTime(new Date(appointment.startIso)); });
    await expect(calendarCreateEventTool.execute(appointment, context)).rejects.toThrow("Créneau d'appel dépassé");
    expect(transport).not.toHaveBeenCalled();
  });

  it("sends the validated values even if the caller mutates its object during OAuth", async () => {
    const params = { ...appointment, attendeeEmail: "accepted@example.com" };
    dependencies.getToken.mockImplementationOnce(async () => {
      params.startIso = "2026-12-23T10:30:00+01:00";
      params.attendeeEmail = "changed@example.com";
      return { accessToken: "calendar-test-only-token", assertCurrent: dependencies.assertCurrent };
    });
    await calendarCreateEventTool.execute(params, context);
    const sent = JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(sent.start.dateTime).toBe(appointment.startIso);
    expect(sent.attendees).toEqual([{ email: "accepted@example.com" }]);
  });

  it("does not apply call-only lateness restrictions to a generic calendar record", async () => {
    vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));
    await expect(calendarCreateEventTool.execute(appointment, { ...context, agentType: "reservation-intelligente" }))
      .resolves.toEqual({ eventId: "calendar-scheduled-event" });
  });
});
