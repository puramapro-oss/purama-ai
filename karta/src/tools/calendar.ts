import { createHash } from "node:crypto";
import { getGmailAccessToken } from "./gmail.js";
import type { ToolDefinition } from "../engine/types.js";

/** Réutilise le token OAuth Google (scope Calendar inclus dans le consentement Gmail — cf email_agent_config). */
export const calendarCreateEventTool: ToolDefinition<
  { title: string; startIso: string; endIso: string; attendeeEmail?: string },
  { eventId: string }
> = {
  name: "calendar_create_event",
  description: "Crée un événement dans le Google Calendar de l'utilisateur (ex: appel planifié, rendez-vous).",
  sensitive: true,
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 300 },
      startIso: { type: "string", minLength: 1, maxLength: 64 },
      endIso: { type: "string", minLength: 1, maxLength: 64 },
      attendeeEmail: { type: "string", minLength: 3, maxLength: 320 },
    },
    required: ["title", "startIso", "endIso"],
    additionalProperties: false,
  },
  async execute(params, ctx) {
    const startMs = Date.parse(params.startIso);
    const endMs = Date.parse(params.endIso);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new Error("Dates Calendar invalides");
    }
    if (params.attendeeEmail && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(params.attendeeEmail)) {
      throw new Error("Email participant invalide");
    }

    const accessToken = await getGmailAccessToken(ctx.userId);
    if (!accessToken) throw new Error("Google OAuth non complété pour cet utilisateur");

    // Google Calendar accepte un id client. On dérive un id stable de l'opération
    // afin qu'un retry/replay ne puisse pas créer un second événement.
    const eventId = ctx.operationId
      ? createHash("sha256").update(ctx.operationId).digest("hex")
      : undefined;

    const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: eventId,
        summary: params.title,
        start: { dateTime: params.startIso },
        end: { dateTime: params.endIso },
        attendees: params.attendeeEmail ? [{ email: params.attendeeEmail }] : undefined,
      }),
    });

    if (response.status === 409 && eventId) {
      const existing = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (existing.ok) return { eventId };
    }

    if (!response.ok) throw new Error(`Calendar create event échoué (${response.status}): ${await response.text()}`);
    const created = (await response.json()) as { id?: unknown };
    if (typeof created.id !== "string" || !created.id) throw new Error("Réponse Calendar invalide");
    return { eventId: created.id };
  },
};
