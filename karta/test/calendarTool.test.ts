import { createHash } from "node:crypto";
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
  userId: "calendar-test-user", agentType: "planificateur-d-appels", mode: "live",
  operationId: "calendar-test-operation",
};
const appointment = {
  title: "Appel demandé", startIso: "2026-11-23T10:30:00+01:00", endIso: "2026-11-23T11:00:00+01:00",
  timeZone: "Europe/Paris",
};
const replayEventId = createHash("sha256").update(context.operationId!).digest("hex");
const replayReceipt = () => ({
  id: replayEventId, status: "confirmed", summary: appointment.title,
  start: { dateTime: appointment.startIso, timeZone: appointment.timeZone },
  end: { dateTime: appointment.endIso, timeZone: appointment.timeZone },
  attendees: [{ email: "person@example.com" }],
});
let transport: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-22T00:00:00Z"));
  dependencies.assertCurrent.mockReset().mockResolvedValue(undefined);
  dependencies.getToken.mockReset().mockResolvedValue({ accessToken: "test-only-calendar-token", assertCurrent: dependencies.assertCurrent });
  transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "calendar-event-1" }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  // Every provider request is intercepted. These tests cannot create invitations.
  vi.stubGlobal("fetch", transport);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("calendar_create_event attendee validation", () => {
  it.each(["person@example.com", "contact@purama.dev", "a@b.co", "sam+appel@example.co.uk"])(
    "creates the requested event for a valid attendee: %s", async (attendeeEmail) => {
      await expect(calendarCreateEventTool.execute({ ...appointment, attendeeEmail }, context))
        .resolves.toEqual({ eventId: "calendar-event-1" });
      expect(dependencies.getToken).toHaveBeenCalledExactlyOnceWith(context.userId);
      expect(transport).toHaveBeenCalledOnce();
      const [url, init] = transport.mock.calls[0];
      expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        id: createHash("sha256").update(context.operationId!).digest("hex"),
        summary: appointment.title,
        start: { dateTime: appointment.startIso, timeZone: appointment.timeZone },
        end: { dateTime: appointment.endIso, timeZone: appointment.timeZone },
        attendees: [{ email: attendeeEmail }],
      });
    },
  );

  it.each([
    "missing-at.example.com", "@example.com", "person@", "person@example", "person@@example.com",
    "per son@example.com", "person@example .com", " person@example.com", "person@example.com\n",
    "person@example.com\r\nBcc:another@example.com",
  ])("rejects malformed or whitespace-bearing attendees before OAuth and provider I/O: %j", async (attendeeEmail) => {
    await expect(calendarCreateEventTool.execute({ ...appointment, attendeeEmail }, context))
      .rejects.toThrow("Email participant invalide");
    expect(dependencies.getToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps an appointment without an attendee valid", async () => {
    await expect(calendarCreateEventTool.execute(appointment, context))
      .resolves.toEqual({ eventId: "calendar-event-1" });
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).not.toHaveProperty("attendees");
  });

  it("keeps provider replay tied to the same operation identity", async () => {
    const eventId = createHash("sha256").update(context.operationId!).digest("hex");
    transport.mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(replayReceipt()), { status: 200 }));
    await expect(calendarCreateEventTool.execute({ ...appointment, attendeeEmail: "person@example.com" }, context))
      .resolves.toEqual({ eventId });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).id).toBe(eventId);
    expect(transport.mock.calls[1][0]).toBe(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`);
    expect(transport.mock.calls[1][1]?.method).toBeUndefined();
  });

  it("still requires the user's OAuth token before provider I/O", async () => {
    dependencies.getToken.mockResolvedValueOnce(null);
    await expect(calendarCreateEventTool.execute({ ...appointment, attendeeEmail: "person@example.com" }, context))
      .rejects.toThrow("Google Calendar OAuth non complété");
    expect(transport).not.toHaveBeenCalled();
  });

  it("still rejects an invalid interval before OAuth and provider I/O", async () => {
    await expect(calendarCreateEventTool.execute({ ...appointment, endIso: appointment.startIso }, context))
      .rejects.toThrow("Dates Calendar invalides");
    expect(dependencies.getToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("calendar conflict reconciliation", () => {
  it.each<Array<[string, unknown]>[number]>([
    ["cancelled event with retained details", { ...replayReceipt(), status: "cancelled" }],
    ["deleted event tombstone", { id: replayEventId, status: "cancelled" }],
    ["tentative event", { ...replayReceipt(), status: "tentative" }],
    ["unknown event status", { ...replayReceipt(), status: "unknown" }],
    ["different identity", { ...replayReceipt(), id: "different-event" }],
    ["different purpose", { ...replayReceipt(), summary: "Autre rendez-vous" }],
    ["moved start", { ...replayReceipt(), start: { dateTime: "2026-11-23T10:45:00+01:00", timeZone: "Europe/Paris" } }],
    ["moved end", { ...replayReceipt(), end: { dateTime: "2026-11-23T11:15:00+01:00", timeZone: "Europe/Paris" } }],
    ["same clock with a different instant", { ...replayReceipt(), start: { dateTime: "2026-11-23T10:30:00+02:00", timeZone: "Europe/Paris" } }],
    ["different start zone at the same instant", { ...replayReceipt(), start: { dateTime: "2026-11-23T09:30:00Z", timeZone: "UTC" } }],
    ["different end zone at the same instant", { ...replayReceipt(), end: { dateTime: "2026-11-23T10:00:00Z", timeZone: "UTC" } }],
    ["missing explicit zone", { ...replayReceipt(), start: { dateTime: appointment.startIso } }],
    ["ambiguous returned instant", { ...replayReceipt(), start: { dateTime: "2026-11-23T10:30:00", timeZone: "Europe/Paris" } }],
    ["all-day event", { ...replayReceipt(), start: { date: "2026-11-23" } }],
    ["unspecified duration", { ...replayReceipt(), endTimeUnspecified: true }],
    ["added recurrence", { ...replayReceipt(), recurrence: ["RRULE:FREQ=WEEKLY"] }],
    ["different recipient", { ...replayReceipt(), attendees: [{ email: "other@example.com" }] }],
    ["unproven address alias", { ...replayReceipt(), attendees: [{ email: "person+alias@example.com" }] }],
    ["different local-part case without identity proof", { ...replayReceipt(), attendees: [{ email: "Person@example.com" }] }],
    ["additional recipient", { ...replayReceipt(), attendees: [{ email: "person@example.com" }, { email: "other@example.com" }] }],
    ["unproven organizer entry", { ...replayReceipt(), organizer: { email: "owner@example.com", self: true },
      attendees: [{ email: "person@example.com" }, { email: "owner@example.com", organizer: true }] }],
    ["organizer address mismatch", { ...replayReceipt(), organizer: { email: "owner@example.com", self: true },
      attendees: [{ email: "person@example.com" }, { email: "other@example.com", organizer: true, self: true }] }],
    ["additional guests", { ...replayReceipt(), attendees: [{ email: "person@example.com", additionalGuests: 1 }] }],
    ["omitted recipients", { ...replayReceipt(), attendeesOmitted: true }],
    ["missing recipients", { ...replayReceipt(), attendees: undefined }],
    ["incomplete event", { id: replayEventId }],
    ["null receipt", null],
    ["array receipt", []],
  ])("does not confirm a %s or create a replacement", async (_label, receipt) => {
    transport.mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    await expect(calendarCreateEventTool.execute({ ...appointment, attendeeEmail: "person@example.com" }, context))
      .rejects.toThrow("Rendez-vous Calendar non confirmé");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["POST", "GET"]);
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).id).toBe(replayEventId);
    expect(transport.mock.calls[1][0]).toBe(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${replayEventId}`);
  });

  it("compares instants instead of rejecting Google's normalized UTC representation", async () => {
    const receipt = {
      ...replayReceipt(),
      start: { dateTime: "2026-11-23T09:30:00.000Z", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-11-23T10:00:00Z", timeZone: "Europe/Paris" },
      attendees: [{ email: "person@example.com", displayName: "Person", responseStatus: "needsAction" }],
    };
    transport.mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    await expect(calendarCreateEventTool.execute({ ...appointment, attendeeEmail: "person@example.com" }, context))
      .resolves.toEqual({ eventId: replayEventId });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["documented default status", { ...replayReceipt(), status: undefined }],
    ["email domain case", { ...replayReceipt(), attendees: [{ email: "person@EXAMPLE.COM" }] }],
    ["current calendar organizer added as an attendee", {
      ...replayReceipt(), organizer: { email: "owner@example.com", self: true },
      attendees: [{ email: "person@example.com" }, { email: "owner@example.com", organizer: true, self: true }],
    }],
    ["requested attendee is also the organizer", {
      ...replayReceipt(), organizer: { email: "person@example.com", self: true },
      attendees: [{ email: "person@example.com", organizer: true, self: true }],
    }],
  ])("accepts a corresponding event with %s", async (_label, receipt) => {
    transport.mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    await expect(calendarCreateEventTool.execute({ ...appointment, attendeeEmail: "person@example.com" }, context))
      .resolves.toEqual({ eventId: replayEventId });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, []])("accepts an event without requested attendees: %j", async (attendees) => {
    transport.mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...replayReceipt(), attendees }), { status: 200 }));
    await expect(calendarCreateEventTool.execute(appointment, context)).resolves.toEqual({ eventId: replayEventId });
  });

  it("rejects an added participant when the original intent had none", async () => {
    transport.mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(replayReceipt()), { status: 200 }));
    await expect(calendarCreateEventTool.execute(appointment, context)).rejects.toThrow("Rendez-vous Calendar non confirmé");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("accepts canonical IANA aliases while retaining the intended instants", async () => {
    const requested = { ...appointment, startIso: "2026-11-23T09:30:00Z", endIso: "2026-11-23T10:00:00Z", timeZone: "Etc/UTC" };
    const receipt = { ...replayReceipt(),
      start: { dateTime: requested.startIso, timeZone: "UTC" },
      end: { dateTime: requested.endIso, timeZone: "UTC" } };
    transport.mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    await expect(calendarCreateEventTool.execute({ ...requested, attendeeEmail: "person@example.com" }, context))
      .resolves.toEqual({ eventId: replayEventId });
  });

  it("does not invent a named zone for a generic reservation that specified only instants", async () => {
    const receipt = { ...replayReceipt(), attendees: undefined,
      start: { dateTime: "2026-11-23T09:30:00Z" }, end: { dateTime: "2026-11-23T10:00:00Z" } };
    transport.mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    await expect(calendarCreateEventTool.execute({ ...appointment, timeZone: undefined }, { ...context, agentType: "reservation-intelligente" }))
      .resolves.toEqual({ eventId: replayEventId });
  });

  it.each([404, 410, 500])("does not create a replacement when reconciliation returns HTTP %i", async (status) => {
    transport.mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response("provider-private-body", { status }));
    await expect(calendarCreateEventTool.execute(appointment, context)).rejects.toThrow("Rendez-vous Calendar non confirmé");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failed reconciliation transport or expose its body", async () => {
    transport.mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockRejectedValueOnce(new Error("provider-private-body"));
    await expect(calendarCreateEventTool.execute(appointment, context))
      .rejects.toThrow("Réponse Google Calendar invalide ou indisponible");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("keeps the same operation identity after an explicitly repeated unresolved execution", async () => {
    transport.mockImplementation(async (_url, init) => init?.method === "POST"
      ? new Response(null, { status: 409 })
      : new Response(JSON.stringify({ ...replayReceipt(), status: "cancelled" }), { status: 200 }));
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(calendarCreateEventTool.execute({ ...appointment, attendeeEmail: "person@example.com" }, context))
        .rejects.toThrow("Rendez-vous Calendar non confirmé");
    }
    expect(transport).toHaveBeenCalledTimes(4);
    const insertions = transport.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(insertions.map(([, init]) => JSON.parse(String(init?.body)).id)).toEqual([replayEventId, replayEventId]);
  });
});
