import { createHash } from "node:crypto";
import { getGmailAccessToken } from "./gmail.js";
import type { ToolDefinition } from "../engine/types.js";

function assertSingleLine(name: string, value: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\u0000]/.test(value)) {
    throw new Error(`${name} invalide`);
  }
  return value.trim();
}

function eventIdForOperation(operationId?: string): string | undefined {
  if (!operationId) return undefined;
  // Google Calendar accepte les caractères base32hex (0-9, a-v) : SHA-256 hex est un sous-ensemble.
  return `p${createHash("sha256").update(operationId).digest("hex")}`;
}

export const calendarCreateEventTool: ToolDefinition<
  { title: string; startIso: string; endIso: string; attendeeEmail?: string },
  { eventId: string }
> = {
  name: "calendar_create_event",
  description: "Crée un événement dans le Google Calendar de l'utilisateur.",
  // Écriture externe ; peut inviter un tiers. Ne jamais la traiter comme une simple lecture.
  sensitive: true,
  async execute(params, ctx) {
    const accessToken = await getGmailAccessToken(ctx.userId);
    if (!accessToken) throw new Error("Google OAuth non complété pour cet utilisateur");

    const title = assertSingleLine("Titre", params.title, 500);
    const start = new Date(params.startIso);
    const end = new Date(params.endIso);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      throw new Error("Plage calendrier invalide");
    }

    let attendeeEmail: string | undefined;
    if (params.attendeeEmail !== undefined) {
      attendeeEmail = assertSingleLine("Email participant", params.attendeeEmail, 320);
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(attendeeEmail)) throw new Error("Email participant invalide");
    }

    const eventId = eventIdForOperation(ctx.operationId);
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    // L'envoi d'invitations doit être une décision explicite séparée, pas un effet secondaire.
    url.searchParams.set("sendUpdates", "none");

    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(eventId ? { id: eventId } : {}),
        summary: title,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: attendeeEmail ? [{ email: attendeeEmail }] : undefined,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 409 && eventId) {
      const existing = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
        { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) }
      );
      if (existing.ok) return { eventId };
    }

    if (!response.ok) throw new Error(`Calendar create event échoué (${response.status})`);
    const created = (await response.json()) as { id?: string };
    if (!created.id) throw new Error("Calendar event sans identifiant");
    return { eventId: created.id };
  },
};
