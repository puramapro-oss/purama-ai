import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ lookup: vi.fn(), quota: vi.fn(), guard: vi.fn(), credentialSignals: [] as AbortSignal[] }));
vi.mock("../src/lib/gmail-token-crypto.js", () => ({
  decryptGmailToken: (value: string) => value, encryptGmailToken: (value: string) => value,
}));
vi.mock("../src/config.js", () => ({ config: {} }));
vi.mock("../src/db/supabase.js", () => ({ supabase: {
  rpc: (...args: unknown[]) => {
    const request = (args[0] === "partner_direct_send_guard" ? h.guard(...args) : h.quota(...args)) as Promise<unknown>;
    return Object.assign(request, { abortSignal: () => request });
  },
  from: () => ({
    select() { return this; }, eq() { return this; },
    abortSignal(signal: AbortSignal) { h.credentialSignals.push(signal); return this; },
    maybeSingle: h.lookup,
  }),
} }));

const { gmailCreateDraftTool, gmailSendTool } = await import("../src/tools/gmail.js");
const ctx = { userId: "fixture-user", agentType: "email" as const, mode: "live" as const };
const params = { to: "camille@example.com", subject: "Question", body: "Réponse",
  threadId: "thread-1", replyToMessageId: "parent-1" };
const cases = [
  { name: "draft", tool: gmailCreateDraftTool, suffix: "/drafts", result: { draftId: "receipt-1" } },
  { name: "send", tool: gmailSendTool, suffix: "/messages/send", result: { messageId: "receipt-1" } },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function credential() {
  return { data: { gmail_refresh_token: "fixture-refresh", gmail_access_token: "fixture-access",
    gmail_token_expiry: new Date(Date.now() + 3_600_000).toISOString() }, error: null };
}
function parent() {
  return { id: "parent-1", threadId: "thread-1", payload: {
    mimeType: "text/plain", headers: [
      { name: "From", value: "Camille <camille@example.com>" },
      { name: "Subject", value: "Question" },
      { name: "Message-ID", value: "<parent@example.com>" },
    ], body: { size: 7, data: Buffer.from("Bonjour").toString("base64url") },
  } };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  h.lookup.mockReset().mockImplementation(async () => credential());
  h.quota.mockReset().mockResolvedValue({ data: 1, error: null });
  h.guard.mockReset().mockResolvedValue({ data: { status: "allowed", reason: null }, error: null });
  h.credentialSignals.length = 0;
  fetchMock = vi.fn(async (url: string) => json(url.includes("/messages/parent-1?") ? parent() : { id: "receipt-1" }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each(cases)("Gmail $name has one action deadline", ({ tool, suffix, result }) => {
  it("preserves the authenticated parent and uses one signal through the POST", async () => {
    await expect(tool.execute(params, ctx)).resolves.toEqual(result);
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1].signal).toBe(h.credentialSignals[0]);
    expect(calls[1]![0]).toMatch(new RegExp(suffix + "$"));
    expect(calls[1]![1].signal).toBe(h.credentialSignals[0]);
    expect(calls[1]![1].redirect).toBe("error");
  });

  it("settles an uncooperative POST without retry or accepting its late receipt", async () => {
    const late = deferred<Response>();
    fetchMock.mockImplementation(async (url: string) => url.endsWith(suffix) ? late.promise : json(parent()));
    let settled = false;
    const outcome = tool.execute(params, ctx).then(value => ({ value, error: undefined }),
      error => ({ value: undefined, error: error as Error })).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(40_001);
    const lateResponse = json({ id: "late-receipt" });
    const cancel = vi.spyOn(lateResponse.body!, "cancel");
    try { expect(settled).toBe(true); }
    finally { late.resolve(lateResponse); }
    const observed = await outcome;
    expect(observed.value).toBeUndefined();
    expect(observed.error?.message).toMatch(/non confirmé.*vérifier/i);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix))).toHaveLength(1);
  });

  it("does not start a POST when the parent completes after expiry", async () => {
    const late = deferred<Response>();
    fetchMock.mockImplementationOnce(() => late.promise);
    let settled = false;
    const outcome = tool.execute(params, ctx).then(() => false, () => true).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(40_001);
    try { expect(settled).toBe(true); }
    finally { late.resolve(json(parent())); }
    expect(await outcome).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.quota).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not continue after a late credential lookup", async () => {
    const late = deferred<ReturnType<typeof credential>>();
    h.lookup.mockImplementationOnce(() => late.promise);
    const outcome = tool.execute(params, ctx).then(() => false, () => true);
    await vi.advanceTimersByTimeAsync(40_001);
    late.resolve(credential());
    expect(await outcome).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.quota).not.toHaveBeenCalled();
  });

  it.each([" ", "bad\nidentifier", "a".repeat(257), { id: "nested" }])(
    "refuses a malformed provider receipt: %j", async id => {
      fetchMock.mockImplementation(async (url: string) => json(url.endsWith(suffix) ? { id } : parent()));
      await expect(tool.execute(params, ctx)).rejects.toThrow(/non confirmé/i);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix))).toHaveLength(1);
    });

  it("does not expose a provider error body", async () => {
    const response = new Response("private-provider-body secret-token camille@example.com", { status: 503 });
    const text = vi.spyOn(response, "text");
    fetchMock.mockImplementation(async (url: string) => url.endsWith(suffix) ? response : json(parent()));
    const error = await tool.execute(params, ctx).then(() => null, error => error as Error);
    expect(error?.message).toMatch(/non confirmé.*vérifier/i);
    expect(error?.message).not.toMatch(/private-provider|secret-token|camille@/);
    expect(text).not.toHaveBeenCalled();
  });

  it.each([{ ok: false }, { success: false }, { error: "provider-failure" }])(
    "does not erase an explicit failure beside a receipt: %j", async failure => {
      fetchMock.mockImplementation(async (url: string) => json(url.endsWith(suffix) ? { id: "receipt-1", ...failure } : parent()));
      await expect(tool.execute(params, ctx)).rejects.toThrow(/non confirmé.*vérifier/i);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix))).toHaveLength(1);
    });
});

describe("Gmail send quota and cumulative budget", () => {
  it("never sends after a quota reservation resolves late", async () => {
    const late = deferred<{ data: number; error: null }>();
    h.quota.mockImplementationOnce(() => late.promise);
    let settled = false;
    const outcome = gmailSendTool.execute(params, ctx).then(() => false, () => true)
      .then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(40_001);
    try { expect(settled).toBe(true); }
    finally { late.resolve({ data: 1, error: null }); }
    expect(await outcome).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/messages/send"))).toBe(false);
    expect(h.quota).toHaveBeenCalledOnce();
  });

  it.each([NaN, 1.5, 0, -1, Infinity, 401, "1"])("rejects invalid quota receipts: %s", async data => {
    h.quota.mockResolvedValueOnce({ data, error: null });
    await expect(gmailSendTool.execute(params, ctx)).rejects.toThrow(/quota|Limite/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not reset the total budget between credentials, parent, quota and POST", async () => {
    h.lookup.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(credential()), 15_000)));
    fetchMock.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(json(parent())), 15_000)));
    h.quota.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ data: 1, error: null }), 15_000)));
    let settled = false;
    const outcome = gmailSendTool.execute(params, ctx).then(() => false, () => true)
      .then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(40_001);
    expect(settled).toBe(true);
    expect(await outcome).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.quota).toHaveBeenCalledOnce();
  });

  it("checks elapsed monotone time before starting a POST even if the timer has not fired", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    h.quota.mockImplementationOnce(async () => {
      clock.mockReturnValue(41_001);
      return { data: 1, error: null };
    });
    await expect(gmailSendTool.execute(params, ctx)).rejects.toThrow(/Délai/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
