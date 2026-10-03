import { getGmailAccessToken } from "./gmail.js";
import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";
import { defineTool, objectSchema, optionalSchema, stringSchema, ToolInputError } from "./validation.js";
import { isOutputObject, isOutputText, requireOutput } from "./response-validation.js";

/** Réutilise le token OAuth Google (scope Calendar inclus dans le consentement Gmail — cf email_agent_config). */
export const calendarCreateEventTool: ToolDefinition<
  { title: string; startIso: string; endIso: string; attendeeEmail?: string },
  { eventId: string }
> = defineTool({
  name: "calendar_create_event",
  description: "Crée un événement dans le Google Calendar de l'utilisateur (ex: appel planifié, rendez-vous).",
  sensitive: false,
  input: objectSchema({
    title: stringSchema({ maxLength: 512, pattern: "\\S" }),
    startIso: stringSchema({ format: "date-time", maxLength: 40 }),
    endIso: stringSchema({ format: "date-time", maxLength: 40 }),
    attendeeEmail: optionalSchema(stringSchema({ format: "email", maxLength: 254 })),
  }, (params) => {
    if (Date.parse(params.endIso) <= Date.parse(params.startIso)) {
      throw new ToolInputError("input.endIso", "la fin doit être postérieure au début");
    }
  }),
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
      signal: AbortSignal.timeout(config.providerTimeoutMs),
    });

    if (!response.ok) throw new Error(`Calendar create event échoué (${response.status}): ${await response.text()}`);
    const created: unknown = await response.json();
    requireOutput(isOutputObject(created) && isOutputText(created.id) && !("error" in created), "Calendar");
    requireOutput(created.status === undefined || created.status === "confirmed" || created.status === "tentative", "Calendar");
    return { eventId: created.id };
  },
});
