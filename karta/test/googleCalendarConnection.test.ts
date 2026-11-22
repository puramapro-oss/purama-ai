import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  reads: 0,
  error: false,
  hang: false,
  wrongRow: false,
  beforeWrite: null as null | (() => void),
  writes: [] as Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }>,
  queries: [] as Array<{ table: string; filters: Record<string, unknown>; signal?: AbortSignal }>,
  config: { googleClientId: "calendar-test-client", googleClientSecret: "calendar-test-secret" },
}));
vi.mock("../src/config.js", () => ({ config: state.config }));
vi.mock("../src/db/supabase.js", () => ({ supabase: {
  from(table: string) {
    const query: { table: string; filters: Record<string, unknown>; signal?: AbortSignal } = { table, filters: {} };
    state.queries.push(query);
    let values: Record<string, unknown> | undefined;
    const builder = {
      select() { return builder; },
      eq(key: string, value: unknown) { query.filters[key] = value; return builder; },
      update(input: Record<string, unknown>) { values = input; return builder; },
      abortSignal(signal: AbortSignal) { query.signal = signal; return builder; },
      async maybeSingle() {
        if (state.hang) return new Promise<never>(() => undefined);
        if (values) {
          state.beforeWrite?.();
          state.writes.push({ table, values, filters: { ...query.filters } });
        } else state.reads += 1;
        if (state.error) return { data: null, error: { message: "private-database-detail" } };
        const matches = state.row && Object.entries(query.filters).every(([key, value]) => state.row![key] === value);
        if (!matches && !state.wrongRow) return { data: null, error: null };
        if (values && state.row) {
          state.row = { ...state.row, ...values, updated_at: "2026-11-22T00:00:01+00:00",
            // PostgREST normalizes timestamptz instead of returning JS's exact spelling.
            token_expires_at: String(values.token_expires_at).replace(/Z$/, "+00:00") };
        }
        return { data: state.row ? { ...state.row } : null, error: null };
      },
    };
    return builder;
  },
} }));
vi.mock("../src/tools/gmail.js", () => ({ getGmailAccessToken: () => { throw new Error("Gmail is not a Calendar connection"); } }));
import { getGoogleCalendarConnection, requestCalendarJson } from "../src/tools/google-calendar-connection.js";
import { calendarCreateEventTool } from "../src/tools/calendar.js";

const row = {
  id: "calendar-connection-test", user_id: "calendar-user-test", provider: "google_calendar",
  access_token: "calendar-access-test", refresh_token: "calendar-refresh-test",
  token_expires_at: "2026-11-22T01:00:00+00:00", updated_at: "2026-11-21T23:00:00+00:00",
};
const refreshed = { access_token: "calendar-refreshed-test", token_type: "Bearer", expires_in: 3600,
  scope: "https://www.googleapis.com/auth/calendar" };
let transport: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-22T00:00:00Z"));
  state.row = { ...row }; state.reads = 0; state.error = false; state.hang = false; state.wrongRow = false;
  state.beforeWrite = null; state.writes = []; state.queries = [];
  state.config.googleClientId = "calendar-test-client"; state.config.googleClientSecret = "calendar-test-secret";
  transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(refreshed), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", transport);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("canonical Calendar connection", () => {
  it("reads only this owner's Google Calendar connection, with no Gmail fallback", async () => {
    const connection = await getGoogleCalendarConnection(row.user_id);
    expect(connection?.accessToken).toBe(row.access_token);
    await connection?.assertCurrent();
    expect(state.reads).toBe(2);
    expect(state.queries.every(q => q.table === "user_connections"
      && q.filters.user_id === row.user_id && q.filters.provider === "google_calendar" && q.signal instanceof AbortSignal)).toBe(true);
    expect(state.writes).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not treat a missing Calendar connection as Gmail authorization", async () => {
    state.row = null;
    expect(await getGoogleCalendarConnection(row.user_id)).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { user_id: "different-user" }, { provider: "gmail" }, { refresh_token: null },
    { access_token: "token\r\nInjected: secret" }, { token_expires_at: "invalid" }, { updated_at: "invalid" },
  ])("rejects invalid or foreign connection data: %j", async (change) => {
    state.row = { ...row, ...change }; state.wrongRow = true;
    await expect(getGoogleCalendarConnection(row.user_id)).rejects.toThrow("Connexion Calendar invalide");
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not disclose storage details", async () => {
    state.error = true;
    await expect(getGoogleCalendarConnection(row.user_id)).rejects.toThrow("Lecture de la connexion Calendar indisponible");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    null, { ...row, updated_at: "2026-11-22T00:00:01+00:00" },
    { ...row, access_token: "replacement-access" }, { ...row, refresh_token: "replacement-refresh" },
    { ...row, id: "replacement-connection" },
  ])("refuses an absent or changed connection at the final action boundary", async (replacement) => {
    const connection = await getGoogleCalendarConnection(row.user_id);
    state.row = replacement;
    await expect(connection!.assertCurrent()).rejects.toThrow("modifiée ou révoquée");
  });

  it("rechecks expiration immediately before the action", async () => {
    const connection = await getGoogleCalendarConnection(row.user_id);
    vi.setSystemTime(new Date(row.token_expires_at));
    await expect(connection!.assertCurrent()).rejects.toThrow("modifiée ou révoquée");
  });

  it("the real Calendar tool uses the canonical token without invoking Gmail", async () => {
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ id: "calendar-created" }), { status: 200 }));
    await expect(calendarCreateEventTool.execute({ title: "Rappel demandé", timeZone: "Europe/Paris",
      startIso: "2026-11-23T10:00:00+01:00", endIso: "2026-11-23T10:30:00+01:00" },
    { userId: row.user_id, agentType: "planificateur-d-appels", mode: "live", operationId: "calendar-operation-test" }))
      .resolves.toEqual({ eventId: "calendar-created" });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0]).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(transport.mock.calls[0][1]?.headers).toEqual({ Authorization: `Bearer ${row.access_token}`, "Content-Type": "application/json" });
    expect(state.reads).toBe(2);
  });
});

describe("Calendar OAuth refresh", () => {
  beforeEach(() => { state.row = { ...row, token_expires_at: "2026-11-21T23:59:59+00:00" }; });

  it("refreshes only Calendar and persists against the exact connection version", async () => {
    const connection = await getGoogleCalendarConnection(row.user_id);
    expect(connection?.accessToken).toBe(refreshed.access_token);
    await connection?.assertCurrent();
    expect(transport).toHaveBeenCalledOnce();
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      client_id: state.config.googleClientId, client_secret: state.config.googleClientSecret,
      refresh_token: row.refresh_token, grant_type: "refresh_token",
    });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].filters).toEqual({ id: row.id, user_id: row.user_id, provider: "google_calendar",
      refresh_token: row.refresh_token, updated_at: row.updated_at });
    expect(state.row?.token_expires_at).toBe("2026-11-22T01:00:00.000+00:00");
  });

  it("persists a returned refresh token rotation on the same guarded row", async () => {
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...refreshed, refresh_token: "rotated-refresh-test" }), { status: 200 }));
    const connection = await getGoogleCalendarConnection(row.user_id);
    expect(state.row?.refresh_token).toBe("rotated-refresh-test");
    await expect(connection!.assertCurrent()).resolves.toBeUndefined();
  });

  it.each(["revoked", "reconnected"])("does not restore credentials after the connection was %s during OAuth", async (change) => {
    state.beforeWrite = () => { state.row = change === "revoked" ? null : { ...row, refresh_token: "new-account-refresh" }; };
    await expect(getGoogleCalendarConnection(row.user_id)).rejects.toThrow("modifiée pendant le renouvellement");
    expect(state.row?.refresh_token).not.toBe(row.refresh_token);
  });

  it.each([
    { access_token: "" }, { token_type: "MAC" }, { expires_in: 0 }, { expires_in: 1.5 }, { expires_in: Number.MAX_SAFE_INTEGER },
    { scope: "https://www.googleapis.com/auth/gmail.modify" }, { scope: "https://www.googleapis.com/auth/calendar.readonly" },
    { refresh_token: "" }, { access_token: "secret\nheader" },
  ])("rejects an invalid refresh response without persistence: %j", async (changes) => {
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...refreshed, ...changes }), { status: 200 }));
    await expect(getGoogleCalendarConnection(row.user_id)).rejects.toThrow();
    expect(state.writes).toEqual([]);
  });

  it("fails without missing client credentials rather than borrowing Gmail's token", async () => {
    state.config.googleClientSecret = "";
    await expect(getGoogleCalendarConnection(row.user_id)).rejects.toThrow("OAuth Calendar non configuré");
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not echo a provider error body containing confidential data", async () => {
    transport.mockResolvedValueOnce(new Response("refresh-token-confidential-value", { status: 400 }));
    await expect(getGoogleCalendarConnection(row.user_id)).rejects.toThrow("Renouvellement Calendar refusé (400)");
    expect(state.writes).toEqual([]);
  });
});

describe("bounded Calendar provider requests", () => {
  it("rejects an oversized body before JSON parsing, including a lying Content-Length", async () => {
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ value: "x".repeat(70_000) }),
      { status: 200, headers: { "Content-Length": "2" } }));
    await expect(requestCalendarJson("https://www.googleapis.com/calendar/v3/calendars/primary/events", {}))
      .rejects.toThrow("Réponse Google Calendar invalide ou indisponible");
  });

  it("does not expose malformed JSON content", async () => {
    transport.mockResolvedValueOnce(new Response("secret-json-not-valid", { status: 200 }));
    await expect(requestCalendarJson("https://oauth2.googleapis.com/token", {}))
      .rejects.toThrow("Réponse Google Calendar invalide ou indisponible");
  });

  it("bounds an unresponsive transport even if it ignores AbortSignal", async () => {
    vi.useFakeTimers();
    transport.mockImplementationOnce(() => new Promise<never>(() => undefined));
    const result = requestCalendarJson("https://oauth2.googleapis.com/token", {});
    const check = expect(result).rejects.toThrow("Délai Google Calendar dépassé");
    await vi.advanceTimersByTimeAsync(15_000);
    await check;
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a body that never completes", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    transport.mockResolvedValueOnce(new Response(new ReadableStream({ start() { /* no chunks */ }, cancel: cancelled }), { status: 200 }));
    const result = requestCalendarJson("https://oauth2.googleapis.com/token", {});
    const check = expect(result).rejects.toThrow("Délai Google Calendar dépassé");
    await vi.advanceTimersByTimeAsync(15_000);
    await check;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds connection storage reads too", async () => {
    vi.useFakeTimers(); state.hang = true;
    const result = getGoogleCalendarConnection(row.user_id);
    const check = expect(result).rejects.toThrow("Délai Google Calendar dépassé");
    await vi.advanceTimersByTimeAsync(15_000);
    await check;
    expect(transport).not.toHaveBeenCalled();
    expect(state.queries[0].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
