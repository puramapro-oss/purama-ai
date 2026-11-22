import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Connection = {
  id: string; user_id: string; gmail_email: string;
  gmail_refresh_token: string | null; gmail_access_token: string | null;
  gmail_token_expiry: string | null; updated_at: string;
};
const state = vi.hoisted(() => ({
  row: null as Connection | null,
  writes: [] as Array<{ filters: Record<string, string>; values: Record<string, unknown> }>,
  beforePatch: undefined as (() => void) | undefined,
  readError: false,
  writeError: false,
  responseId: undefined as string | undefined,
}));
vi.mock("../src/config.js", () => ({ config: {
  googleClientId: "fixture-client-id", googleClientSecret: "fixture-client-secret",
  gmailTokenEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
} }));
// Use the real Supabase/PostgREST serializer. Only its HTTP boundary is doubled;
// matching predicates are evaluated against the current row at PATCH time.
vi.mock("../src/db/supabase.js", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const dbFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://db.example.invalid" || url.pathname !== "/rest/v1/email_agent_config") {
      throw new Error("Unexpected database fixture URL");
    }
    const filters = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "select"));
    const matches = () => state.row !== null && Object.entries(filters).every(([key, value]) =>
      value === "is.null" ? state.row![key as keyof Connection] === null : value === `eq.${String(state.row![key as keyof Connection])}`);
    if (!init?.method || init.method === "GET") {
      if (state.readError) return Response.json({ message: "sensitive-database-detail" }, { status: 400 });
      const keys = url.searchParams.get("select")!.split(",");
      return Response.json(matches() ? [Object.fromEntries(keys.map(key => [key, state.row![key as keyof Connection]]))] : []);
    }
    if (init.method !== "PATCH") throw new Error("Unexpected database fixture method");
    state.beforePatch?.();
    const values = JSON.parse(String(init.body)) as Record<string, unknown>;
    state.writes.push({ filters, values });
    if (state.writeError) return Response.json({ message: "sensitive-database-detail" }, { status: 503 });
    if (!matches()) return Response.json({ code: "PGRST116", details: "The result contains 0 rows", message: "No match" }, { status: 406 });
    Object.assign(state.row!, values, { updated_at: new Date(Date.now() + 1).toISOString() });
    // Older unguarded updates request no representation; modern ones require it.
    if (!url.searchParams.has("select")) return new Response(null, { status: 204 });
    return Response.json({ id: state.responseId ?? state.row!.id });
  };
  return { supabase: createClient("https://db.example.invalid", "fixture-service-key", {
    db: { schema: "purama_ai" }, global: { fetch: dbFetch },
    auth: { persistSession: false, autoRefreshToken: false },
  }) };
});

const { getGmailAccessToken } = await import("../src/tools/gmail.js");
const { encryptGmailToken, decryptGmailToken } = await import("../src/lib/gmail-token-crypto.js");
const owner = "00000000-0000-4000-8000-000000000001";
const rowId = "00000000-0000-4000-8000-000000000011";
const account = "owner@example.invalid";
let provider: ReturnType<typeof vi.fn>;
const tokenResponse = (extra: Record<string, unknown> = {}) => Response.json({
  access_token: "fresh-access-token", expires_in: 3600, token_type: "Bearer", ...extra,
});
const profileResponse = (emailAddress = account) => Response.json({ emailAddress });

beforeEach(() => {
  state.row = { id: rowId, user_id: owner, gmail_email: account,
    gmail_refresh_token: encryptGmailToken("original-refresh-token"),
    gmail_access_token: encryptGmailToken("expired-access-token"),
    gmail_token_expiry: new Date(Date.now() - 1000).toISOString(),
    updated_at: "2026-11-22T00:00:00.000Z" };
  state.writes.length = 0; state.beforePatch = undefined;
  state.readError = false; state.writeError = false; state.responseId = undefined;
  provider = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") return tokenResponse();
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") return profileResponse();
    throw new Error("Unexpected provider fixture URL");
  });
  vi.stubGlobal("fetch", provider);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Gmail credential refresh keeps its original connection", () => {
  it("keeps the disconnected and valid cached-token contracts", async () => {
    state.row = null;
    await expect(getGmailAccessToken(owner)).resolves.toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });
  it("uses a still-valid encrypted access token without refreshing", async () => {
    state.row!.gmail_token_expiry = new Date(Date.now() + 3600_000).toISOString();
    await expect(getGmailAccessToken(owner)).resolves.toBe("expired-access-token");
    expect(provider).not.toHaveBeenCalled(); expect(state.writes).toHaveLength(0);
  });
  it("persists encrypted credentials only on the exact selected connection", async () => {
    const snapshot = structuredClone(state.row!);
    await expect(getGmailAccessToken(owner)).resolves.toBe("fresh-access-token");
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]!.filters).toMatchObject({ user_id: `eq.${owner}`, id: `eq.${rowId}`,
      gmail_email: `eq.${account}`, gmail_refresh_token: `eq.${snapshot.gmail_refresh_token}`,
      updated_at: `eq.${snapshot.updated_at}` });
    expect(state.row!.gmail_access_token).not.toBe("fresh-access-token");
    expect(decryptGmailToken(state.row!.gmail_access_token!)).toBe("fresh-access-token");
    expect(state.row!.gmail_refresh_token).toBe(snapshot.gmail_refresh_token);
    expect(provider.mock.calls.some(([url]) => String(url).endsWith("/profile"))).toBe(true);
    for (const [, init] of provider.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
      expect((init as RequestInit).redirect).toBe("error");
    }
  });
  it.each([
    ["disconnect", () => { state.row!.gmail_refresh_token = null; state.row!.gmail_access_token = null; }],
    ["different refresh token", () => { state.row!.gmail_refresh_token = encryptGmailToken("new-refresh"); }],
    ["version changed", () => { state.row!.updated_at = "2026-11-22T00:00:01.000Z"; }],
    ["access token changed without a new timestamp", () => { state.row!.gmail_access_token = encryptGmailToken("winning-access"); }],
    ["expiry changed without a new timestamp", () => { state.row!.gmail_token_expiry = "2026-11-22T10:00:00.000Z"; }],
    ["different account", () => { state.row!.gmail_email = "other@example.invalid"; }],
    ["replacement row", () => { state.row!.id = "00000000-0000-4000-8000-000000000012"; }],
    ["owner changed", () => { state.row!.user_id = "00000000-0000-4000-8000-000000000002"; }],
  ] as const)("does not restore credentials after %s wins the database race", async (_name, mutate) => {
    let winning: Connection | null = null;
    state.beforePatch = () => { mutate(); winning = structuredClone(state.row); };
    await expect(getGmailAccessToken(owner)).rejects.toThrow();
    expect(state.row).toEqual(winning); expect(provider).toHaveBeenCalledTimes(2);
  });
  it("does not return an unconfirmed token when the write fails", async () => {
    const previous = structuredClone(state.row);
    state.writeError = true;
    await expect(getGmailAccessToken(owner)).rejects.toThrow();
    expect(state.row).toEqual(previous);
  });
  it("rejects a write receipt for another row", async () => {
    state.responseId = "00000000-0000-4000-8000-000000000099";
    await expect(getGmailAccessToken(owner)).rejects.toThrow();
  });
  it("does not expose storage errors", async () => {
    state.readError = true;
    const error = await getGmailAccessToken(owner).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("sensitive-database-detail");
    expect(provider).not.toHaveBeenCalled();
  });
  it("does not persist or return a token belonging to another mailbox", async () => {
    provider.mockImplementation(async (input: string | URL | Request) => String(input).endsWith("/profile")
      ? profileResponse("other@example.invalid") : tokenResponse());
    await expect(getGmailAccessToken(owner)).rejects.toThrow();
    expect(state.writes).toHaveLength(0);
  });
  it("supports a case-only difference in the verified mailbox", async () => {
    provider.mockImplementation(async (input: string | URL | Request) => String(input).endsWith("/profile")
      ? profileResponse("OWNER@EXAMPLE.INVALID") : tokenResponse());
    await expect(getGmailAccessToken(owner)).resolves.toBe("fresh-access-token");
  });
  it("stores a rotated refresh token with the existing encryption", async () => {
    provider.mockImplementation(async (input: string | URL | Request) => String(input).endsWith("/profile")
      ? profileResponse() : tokenResponse({ refresh_token: "rotated-refresh-token" }));
    await expect(getGmailAccessToken(owner)).resolves.toBe("fresh-access-token");
    expect(decryptGmailToken(state.row!.gmail_refresh_token!)).toBe("rotated-refresh-token");
  });
  it("refreshes a connection whose old access token and expiry are null", async () => {
    state.row!.gmail_access_token = null; state.row!.gmail_token_expiry = null;
    await expect(getGmailAccessToken(owner)).resolves.toBe("fresh-access-token");
    expect(state.writes[0]!.filters).toMatchObject({ gmail_access_token: "is.null", gmail_token_expiry: "is.null" });
  });
  it("admits only one of two refreshes from the same stale snapshot", async () => {
    const outcomes = await Promise.allSettled([getGmailAccessToken(owner), getGmailAccessToken(owner)]);
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(x => x.status === "rejected")).toHaveLength(1);
    expect(decryptGmailToken(state.row!.gmail_access_token!)).toBe("fresh-access-token");
  });
});

describe("Gmail OAuth response boundaries", () => {
  it.each([
    { access_token: undefined }, { access_token: "" }, { access_token: "token\r\nInjected" },
    { access_token: "a".repeat(16_385) }, { expires_in: "3600" }, { expires_in: 0 },
    { expires_in: -1 }, { expires_in: 1.5 }, { expires_in: Number.MAX_SAFE_INTEGER },
    { token_type: "MAC" }, { token_type: undefined }, { refresh_token: "" },
    { scope: "https://www.googleapis.com/auth/userinfo.email" },
  ])("rejects unusable token metadata without writing %j", async fields => {
    provider.mockResolvedValue(tokenResponse(fields));
    await expect(getGmailAccessToken(owner)).rejects.toThrow();
    expect(state.writes).toHaveLength(0);
  });
  it("never reads or echoes a rejected provider response body", async () => {
    provider.mockResolvedValue(new Response("sensitive-provider-detail", { status: 400 }));
    const error = await getGmailAccessToken(owner).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("sensitive-provider-detail");
    expect(state.writes).toHaveLength(0);
  });
  it("rejects a body beyond the OAuth byte limit even with a lying length", async () => {
    provider.mockResolvedValue(new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600,
      token_type: "Bearer", padding: "x".repeat(65_536) }), { headers: { "Content-Length": "1" } }));
    await expect(getGmailAccessToken(owner)).rejects.toThrow(); expect(state.writes).toHaveLength(0);
  });
  it("rejects malformed JSON and redirected responses", async () => {
    provider.mockResolvedValue(new Response("{"));
    await expect(getGmailAccessToken(owner)).rejects.toThrow(); expect(state.writes).toHaveLength(0);
    const redirected = tokenResponse(); Object.defineProperty(redirected, "redirected", { value: true });
    provider.mockResolvedValue(redirected);
    await expect(getGmailAccessToken(owner)).rejects.toThrow(); expect(state.writes).toHaveLength(0);
  });
  it("expires a provider that ignores cancellation and never persists a late response", async () => {
    vi.useFakeTimers();
    let release!: (value: Response) => void;
    provider.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    let settled = false;
    const pending = getGmailAccessToken(owner).then(() => { settled = true; return "unexpected success"; }, () => { settled = true; return "rejected"; });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(settled).toBe(true);
    release(tokenResponse()); await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe("rejected"); expect(state.writes).toHaveLength(0);
  });
  it("bounds a stalled response stream and nonsettling cancellation", async () => {
    vi.useFakeTimers();
    provider.mockResolvedValue(new Response(new ReadableStream({
      pull: () => new Promise<void>(() => {}), cancel: () => new Promise<void>(() => {}),
    })));
    let settled = false;
    const pending = getGmailAccessToken(owner).then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(settled).toBe(true); expect(state.writes).toHaveLength(0); await pending;
  });
  it("rejects an unbounded sequence of empty chunks", async () => {
    provider.mockResolvedValue(new Response(new ReadableStream({
      pull: controller => { controller.enqueue(new Uint8Array()); },
    })));
    await expect(getGmailAccessToken(owner)).rejects.toThrow(); expect(state.writes).toHaveLength(0);
  });
});
