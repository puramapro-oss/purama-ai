import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../src/engine/types.js";

const dependencies = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock("../src/tools/gmail.js", () => ({ getGmailAccessToken: dependencies.getToken }));
import { calendarCreateEventTool } from "../src/tools/calendar.js";

const context: ToolExecutionContext = {
  userId: "calendar-test-user", agentType: "planificateur-d-appels", mode: "live",
  operationId: "calendar-test-operation",
};
const appointment = {
  title: "Appel demandé", startIso: "2026-11-23T10:30:00+01:00", endIso: "2026-11-23T11:00:00+01:00",
};
let transport: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  dependencies.getToken.mockReset().mockResolvedValue("test-only-calendar-token");
  transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "calendar-event-1" }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  // Every provider request is intercepted. These tests cannot create invitations.
  vi.stubGlobal("fetch", transport);
});
afterEach(() => vi.unstubAllGlobals());

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
        start: { dateTime: appointment.startIso }, end: { dateTime: appointment.endIso },
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: eventId }), { status: 200 }));
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
      .rejects.toThrow("Google OAuth non complété");
    expect(transport).not.toHaveBeenCalled();
  });

  it("still rejects an invalid interval before OAuth and provider I/O", async () => {
    await expect(calendarCreateEventTool.execute({ ...appointment, endIso: appointment.startIso }, context))
      .rejects.toThrow("Dates Calendar invalides");
    expect(dependencies.getToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});
