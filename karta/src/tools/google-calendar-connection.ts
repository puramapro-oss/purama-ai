import { supabase } from "../db/supabase.js";
import { config } from "../config.js";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const CONNECTION_FIELDS = "id,user_id,provider,access_token,refresh_token,token_expires_at,updated_at";
const TOKEN = /^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

interface CalendarConnectionRow {
  id: string;
  user_id: string;
  provider: "google_calendar";
  access_token: string | null;
  refresh_token: string;
  token_expires_at: string | null;
  updated_at: string;
}

function calendarConnectionRow(value: unknown, userId: string): CalendarConnectionRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Connexion Calendar invalide");
  const row = value as Record<string, unknown>;
  if (row.user_id !== userId || row.provider !== "google_calendar"
    || typeof row.id !== "string" || !row.id || row.id.length > 128
    || typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at))
    || typeof row.refresh_token !== "string" || !TOKEN.test(row.refresh_token)
    || (row.access_token !== null && (typeof row.access_token !== "string" || !TOKEN.test(row.access_token)))
    || (row.token_expires_at !== null && (typeof row.token_expires_at !== "string" || !Number.isFinite(Date.parse(row.token_expires_at))))) {
    throw new Error("Connexion Calendar invalide : reconnecter le compte concerné");
  }
  return {
    id: row.id, user_id: userId, provider: "google_calendar", access_token: row.access_token as string | null,
    refresh_token: row.refresh_token, token_expires_at: row.token_expires_at as string | null, updated_at: row.updated_at,
  };
}

async function withCalendarDeadline<T>(work: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Délai Google Calendar dépassé"));
    }, REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Shared by OAuth refresh and Calendar requests; no provider body reaches errors. */
export async function requestCalendarJson(url: string, init: RequestInit): Promise<{
  ok: boolean; status: number; value?: unknown;
}> {
  return withCalendarDeadline(async signal => {
    let response: Response | undefined;
    try {
      response = await fetch(url, { ...init, redirect: "error", credentials: "omit", signal });
      signal.throwIfAborted();
      if (response.redirected) throw new Error("Redirection Google Calendar refusée");
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return { ok: false, status: response.status };
      }
      if (!response.body) throw new Error("Réponse Google Calendar vide");
      const reader = response.body.getReader();
      const cancelOnAbort = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener("abort", cancelOnAbort, { once: true });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new Error("Réponse Google Calendar trop volumineuse");
          chunks.push(next.value);
        }
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        return { ok: true, status: response.status, value };
      } finally {
        signal.removeEventListener("abort", cancelOnAbort);
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch {
      void response?.body?.cancel().catch(() => undefined);
      throw new Error("Réponse Google Calendar invalide ou indisponible");
    }
  });
}

export interface GoogleCalendarConnection {
  accessToken: string;
  /** Re-read the same owner/provider/version immediately before the external effect. */
  assertCurrent(): Promise<void>;
}

/** Uses the Calendar connection already created by oauth-google, never Gmail's grant. */
export async function getGoogleCalendarConnection(userId: string): Promise<GoogleCalendarConnection | null> {
  const read = async (): Promise<CalendarConnectionRow | null> => {
    const { data, error } = await withCalendarDeadline(signal => supabase.from("user_connections")
      .select(CONNECTION_FIELDS).eq("user_id", userId).eq("provider", "google_calendar")
      .abortSignal(signal).maybeSingle());
    if (error) throw new Error("Lecture de la connexion Calendar indisponible");
    return data === null ? null : calendarConnectionRow(data, userId);
  };
  let connection = await read();
  if (!connection) return null;
  if (!connection.access_token || !connection.token_expires_at || Date.parse(connection.token_expires_at) <= Date.now() + 60_000) {
    if (!config.googleClientId || !config.googleClientSecret) throw new Error("OAuth Calendar non configuré côté KARTA");
    const result = await requestCalendarJson("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret,
        refresh_token: connection.refresh_token, grant_type: "refresh_token" }),
    });
    if (!result.ok) throw new Error(`Renouvellement Calendar refusé (${result.status}) : reconnecter le compte`);
    const tokens = result.value as Record<string, unknown> | null;
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)
      || typeof tokens.access_token !== "string" || !TOKEN.test(tokens.access_token)
      || typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer"
      || typeof tokens.expires_in !== "number" || !Number.isSafeInteger(tokens.expires_in) || tokens.expires_in <= 0
      || (tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== "string" || !TOKEN.test(tokens.refresh_token)))
      || (tokens.scope !== undefined && (typeof tokens.scope !== "string" || !tokens.scope.split(" ").includes(CALENDAR_SCOPE)))) {
      throw new Error("Réponse OAuth Calendar invalide ou permission Calendar absente");
    }
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    if (!Number.isFinite(expiresAt.getTime())) throw new Error("Durée OAuth Calendar invalide");
    const previous = connection;
    const values = { access_token: tokens.access_token,
      refresh_token: (tokens.refresh_token as string | undefined) ?? previous.refresh_token,
      token_expires_at: expiresAt.toISOString() };
    const { data, error } = await withCalendarDeadline(signal => supabase.from("user_connections")
      .update(values).eq("id", previous.id).eq("user_id", userId).eq("provider", "google_calendar")
      .eq("refresh_token", previous.refresh_token).eq("updated_at", previous.updated_at)
      .select(CONNECTION_FIELDS).abortSignal(signal).maybeSingle());
    if (error) throw new Error("Persistance de la connexion Calendar indisponible");
    if (!data) throw new Error("Connexion Calendar modifiée pendant le renouvellement");
    connection = calendarConnectionRow(data, userId);
    if (connection.id !== previous.id || connection.access_token !== values.access_token || connection.refresh_token !== values.refresh_token
      || !connection.token_expires_at || Date.parse(connection.token_expires_at) !== expiresAt.getTime()) {
      throw new Error("Reçu de connexion Calendar incohérent");
    }
  }
  const snapshot = connection;
  return {
    accessToken: snapshot.access_token!,
    async assertCurrent() {
      const current = await read();
      if (!current || current.id !== snapshot.id || current.updated_at !== snapshot.updated_at
        || current.refresh_token !== snapshot.refresh_token || current.access_token !== snapshot.access_token
        || current.token_expires_at !== snapshot.token_expires_at || !current.token_expires_at
        || Date.parse(current.token_expires_at) <= Date.now()) {
        throw new Error("Connexion Calendar modifiée ou révoquée avant l'action");
      }
    },
  };
}
