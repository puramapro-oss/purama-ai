import { getGmailAccessToken } from "./gmail.js";
import type { ToolDefinition } from "../engine/types.js";

/** Réutilise le token OAuth Google (scope Calendar inclus dans le consentement Gmail — cf email_agent_config). */
export const calendarCreateEventTool: ToolDefinition<
  { title: string; startIso: string; endIso: string; attendeeEmail?: string },
  { eventId: string }
> = {
  name: "calendar_create_event",
  description: "Crée un événement dans le Google Calendar de l'utilisateur (ex: appel planifié, rendez-vous).",
  sensitive: false,
  async execute(params, ctx) {
    const accessToken = await getGmailAccessToken(ctx.userId);
    if (!accessToken) throw new Error("Google OAuth non complété pour cet utilisateur");

    const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: params.title,
        start: { dateTime: params.startIso },
        end: { dateTime: params.endIso },
        attendees: params.attendeeEmail ? [{ email: params.attendeeEmail }] : undefined,
      }),
    });

    if (!response.ok) throw new Error(`Calendar create event échoué (${response.status}): ${await response.text()}`);
    const created = (await response.json()) as { id: string };
    return { eventId: created.id };
  },
};
