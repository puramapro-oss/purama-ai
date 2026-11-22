import { createHash } from "node:crypto";
import { getGoogleCalendarConnection, requestCalendarJson } from "./google-calendar-connection.js";
import type { ToolDefinition } from "../engine/types.js";

interface CalendarInstant {
  timestamp: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Never let Date.parse select the host zone or normalize an impossible day. */
function parseCalendarInstant(value: unknown): CalendarInstant {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
    : null;
  if (!match) throw new Error("Dates Calendar invalides : instant explicite avec décalage requis");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8]!;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]!
    || hour > 23 || minute > 59 || second > 59 || offset === "-00:00"
    || (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))) {
    throw new Error("Dates Calendar invalides : date ou décalage impossible");
  }
  const timestamp = Date.parse(value as string);
  if (!Number.isFinite(timestamp)) throw new Error("Dates Calendar invalides");
  return { timestamp, year, month, day, hour, minute, second };
}

/** Supplied clock fields and offsets must describe the named local zone at both ends. */
function validateCalendarTimeZone(
  value: unknown, start: CalendarInstant, end: CalendarInstant, required: boolean,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value || value.length > 100 || value.trim() !== value || /^[+-]/.test(value)) {
    throw new Error("Fuseau IANA du rendez-vous requis");
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: value, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    throw new Error("Fuseau IANA du rendez-vous invalide");
  }
  for (const instant of [start, end]) {
    const parts = new Map(formatter.formatToParts(instant.timestamp).map(part => [part.type, part.value]));
    for (const field of ["year", "month", "day", "hour", "minute", "second"] as const) {
      if (Number(parts.get(field)) !== instant[field]) {
        throw new Error("Date ou décalage incompatible avec le fuseau du rendez-vous");
      }
    }
  }
  return value;
}

/** Calendar uses its own existing OAuth connection; Gmail consent does not grant Calendar access. */
export const calendarCreateEventTool: ToolDefinition<
  { title: string; startIso: string; endIso: string; timeZone?: string; attendeeEmail?: string },
  { eventId: string }
> = {
  name: "calendar_create_event",
  description: "Crée un événement Google Calendar, sans émettre d'appel. Dates locales avec décalage explicite ; timeZone IANA obligatoire pour le planificateur d'appels.",
  sensitive: true,
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 300 },
      startIso: { type: "string", minLength: 1, maxLength: 64, description: "Date et heure locales avec secondes et décalage explicite, cohérents avec timeZone." },
      endIso: { type: "string", minLength: 1, maxLength: 64, description: "Fin locale avec secondes et décalage explicite, cohérents avec timeZone." },
      timeZone: { type: "string", minLength: 1, maxLength: 100, description: "Fuseau IANA fourni pour le destinataire, par exemple Europe/Paris ; ne pas le deviner." },
      attendeeEmail: { type: "string", minLength: 3, maxLength: 320 },
    },
    required: ["title", "startIso", "endIso"],
    additionalProperties: false,
  },
  async execute(params, ctx) {
    const { title, startIso, endIso, attendeeEmail, timeZone: requestedTimeZone } = params;
    const start = parseCalendarInstant(startIso);
    const end = parseCalendarInstant(endIso);
    if (end.timestamp <= start.timestamp) {
      throw new Error("Dates Calendar invalides");
    }
    const callAppointment = ctx.agentType === "planificateur-d-appels";
    const timeZone = validateCalendarTimeZone(requestedTimeZone, start, end, callAppointment);
    if (callAppointment && start.timestamp <= Date.now()) {
      throw new Error("Créneau d'appel dépassé : une nouvelle planification est nécessaire");
    }
    if (attendeeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attendeeEmail)) {
      throw new Error("Email participant invalide");
    }

    const connection = await getGoogleCalendarConnection(ctx.userId);
    if (!connection) throw new Error("Google Calendar OAuth non complété pour cet utilisateur");
    await connection.assertCurrent();
    const accessToken = connection.accessToken;
    // The approval queue or OAuth refresh may have consumed the remaining time.
    // This guards a Calendar insertion, not a future carrier dispatch.
    if (callAppointment && start.timestamp <= Date.now()) {
      throw new Error("Créneau d'appel dépassé : une nouvelle planification est nécessaire");
    }

    // Google Calendar accepte un id client. On dérive un id stable de l'opération
    // afin qu'un retry/replay ne puisse pas créer un second événement.
    const eventId = ctx.operationId
      ? createHash("sha256").update(ctx.operationId).digest("hex")
      : undefined;

    const response = await requestCalendarJson("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: eventId,
        summary: title,
        start: { dateTime: startIso, timeZone },
        end: { dateTime: endIso, timeZone },
        attendees: attendeeEmail ? [{ email: attendeeEmail }] : undefined,
      }),
    });

    if (response.status === 409 && eventId) {
      const existing = await requestCalendarJson(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (existing.ok) return { eventId };
    }

    if (!response.ok) throw new Error(`Calendar create event échoué (${response.status})`);
    const created = response.value as { id?: unknown } | null;
    if (!created || typeof created.id !== "string" || !created.id) throw new Error("Réponse Calendar invalide");
    return { eventId: created.id };
  },
};
