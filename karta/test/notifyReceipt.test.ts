import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyInput } from "../src/engine/notify.js";

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  getUser: vi.fn(),
  config: {
    supabaseUrl: "https://notifications.invalid",
    supabaseServiceRoleKey: "PRIVATE_SERVICE_KEY",
    resendApiKey: "PRIVATE_RESEND_KEY",
    resendFromEmail: "sender@example.invalid",
  },
}));
vi.mock("../src/config.js", () => ({ config: h.config }));
vi.mock("../src/db/supabase.js", () => ({
  supabase: { auth: { admin: { getUserById: h.getUser } } },
}));

import { notify } from "../src/engine/notify.js";

const DEADLINE_MS = 10_000;
const PRIVATE_MARKER = "PRIVATE_PROVIDER_OR_USER_DATA";
const receipt = { ok: true, notification_id: "notification-receipt", push_sent: 0, push_failed: 0 };
const user = { data: { user: { email: "recipient@example.invalid" } }, error: null };
const input = (channels?: NotifyInput["channels"]): NotifyInput => ({
  userId: "private-user", agentType: "legal", title: PRIVATE_MARKER, body: PRIVATE_MARKER,
  ...(channels ? { channels } : {}),
});
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

function observe(promise: Promise<void>) {
  const state: { status: "pending" | "resolved" | "rejected"; error?: unknown } = { status: "pending" };
  void promise.then(() => { state.status = "resolved"; }, error => {
    state.status = "rejected";
    state.error = error;
  });
  return state;
}

async function rejectedWithoutPrivateData(promise: Promise<void>): Promise<void> {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toContain(PRIVATE_MARKER);
  expect(String(failure)).not.toContain(h.config.supabaseServiceRoleKey);
  expect(String(failure)).not.toContain("PRIVATE_RESEND_KEY");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.config.resendApiKey = "PRIVATE_RESEND_KEY";
  h.getUser.mockResolvedValue(user);
  h.fetch.mockReset().mockImplementation(async (url: string) =>
    url.includes("resend.com") ? json({ id: "email-receipt" }) : json(receipt));
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("notification receipts", () => {
  it("accepts the actual edge receipt for the default in-app channel", async () => {
    await expect(notify(input())).resolves.toBeUndefined();
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(h.fetch.mock.calls[0][1].body).channels).toEqual(["in_app"]);
    expect(h.getUser).not.toHaveBeenCalled();
  });

  it("accepts confirmed push and email providers without claiming the messages were read", async () => {
    h.fetch.mockResolvedValueOnce(json({ ...receipt, push_sent: 2 })).mockResolvedValueOnce(json({ id: "email-receipt" }));
    await expect(notify(input(["in_app", "push", "email"]))).resolves.toBeUndefined();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.getUser).toHaveBeenCalledOnce();
    expect(h.fetch.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["absent", null],
    ["array", []],
    ["empty", {}],
    ["provider refusal", { ...receipt, ok: false, error: PRIVATE_MARKER }],
    ["nonboolean success", { ...receipt, ok: "true" }],
    ["missing id", { ok: true }],
    ["blank id", { ...receipt, notification_id: " \n " }],
    ["nonstring id", { ...receipt, notification_id: 42 }],
    ["contradictory error", { ...receipt, error: PRIVATE_MARKER }],
  ])("refuses a %s edge receipt before any email and does not retry", async (_label, body) => {
    h.fetch.mockResolvedValueOnce(json(body));
    await rejectedWithoutPrivateData(notify(input(["in_app", "email"])));
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.getUser).not.toHaveBeenCalled();
  });

  it.each([
    ["no delivery", 0, 0],
    ["partial delivery", 2, 1],
    ["missing counters", undefined, undefined],
    ["string counters", "1", 0],
    ["negative failed count", 1, -1],
    ["fractional success count", 0.5, 0],
  ])("does not confirm requested push with %s", async (_label, sent, failed) => {
    h.fetch.mockResolvedValueOnce(json({ ...receipt, push_sent: sent, push_failed: failed }));
    await rejectedWithoutPrivateData(notify(input(["push", "email"])));
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.getUser).not.toHaveBeenCalled();
  });

  it("does not require a push delivery for an in-app notification", async () => {
    await expect(notify(input(["in_app"]))).resolves.toBeUndefined();
  });

  it.each(["transport", "http", "json"])("redacts an edge %s error", async kind => {
    if (kind === "transport") h.fetch.mockRejectedValueOnce(new Error(PRIVATE_MARKER));
    else if (kind === "http") h.fetch.mockResolvedValueOnce(new Response(PRIVATE_MARKER, { status: 503 }));
    else h.fetch.mockResolvedValueOnce(new Response(PRIVATE_MARKER, { status: 200 }));
    await rejectedWithoutPrivateData(notify(input()));
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("reports an unconfirmed email when its requested channel has no provider key", async () => {
    h.config.resendApiKey = "";
    await rejectedWithoutPrivateData(notify(input(["in_app", "email"])));
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.getUser).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(PRIVATE_MARKER);
  });

  it.each([
    ["missing email", { data: { user: {} }, error: null }],
    ["lookup refusal", { data: { user: null }, error: { message: PRIVATE_MARKER } }],
  ])("reports %s without starting the email request", async (_label, result) => {
    h.getUser.mockResolvedValueOnce(result);
    await rejectedWithoutPrivateData(notify(input(["email"])));
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(PRIVATE_MARKER);
  });

  it("redacts a rejected auth lookup without starting the email request", async () => {
    h.getUser.mockRejectedValueOnce(new Error(PRIVATE_MARKER));
    await rejectedWithoutPrivateData(notify(input(["email"])));
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["no id", {}],
    ["blank id", { id: " " }],
    ["nonstring id", { id: 42 }],
    ["contradictory error", { id: "email-receipt", error: PRIVATE_MARKER }],
  ])("does not confirm a Resend receipt with %s", async (_label, body) => {
    h.fetch.mockResolvedValueOnce(json(receipt)).mockResolvedValueOnce(json(body));
    await rejectedWithoutPrivateData(notify(input(["email"])));
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["transport", "http", "json"])("redacts a Resend %s failure and never retries", async kind => {
    h.fetch.mockResolvedValueOnce(json(receipt));
    if (kind === "transport") h.fetch.mockRejectedValueOnce(new Error(PRIVATE_MARKER));
    else if (kind === "http") h.fetch.mockResolvedValueOnce(new Response(PRIVATE_MARKER, { status: 503 }));
    else h.fetch.mockResolvedValueOnce(new Response(PRIVATE_MARKER, { status: 200 }));
    await rejectedWithoutPrivateData(notify(input(["email"])));
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(PRIVATE_MARKER);
  });
});

describe("one global notification deadline", () => {
  it.each(["edge-fetch", "edge-body", "auth", "email-fetch", "email-body"] as const)(
    "bounds a stalled %s and never starts a late follow-up", async stage => {
      vi.useFakeTimers();
      const pending = deferred<unknown>();
      const stalledBody = { ok: true, status: 200, json: () => pending.promise } as Response;
      if (stage === "edge-fetch") h.fetch.mockImplementationOnce(() => pending.promise);
      if (stage === "edge-body") h.fetch.mockResolvedValueOnce(stalledBody);
      if (stage === "auth") h.getUser.mockImplementationOnce(() => pending.promise);
      if (stage === "email-fetch") h.fetch.mockResolvedValueOnce(json(receipt)).mockImplementationOnce(() => pending.promise);
      if (stage === "email-body") h.fetch.mockResolvedValueOnce(json(receipt)).mockResolvedValueOnce(stalledBody);

      const state = observe(notify(input(["email"])));
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      expect(state.status).toBe("rejected");
      expect(String(state.error)).not.toContain(PRIVATE_MARKER);
      const callsAtDeadline = h.fetch.mock.calls.length;
      expect(callsAtDeadline).toBe(stage.startsWith("email") ? 2 : 1);
      for (const [, options] of h.fetch.mock.calls) {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.signal.aborted).toBe(true);
      }

      pending.resolve(stage === "edge-fetch" ? json(receipt)
        : stage === "edge-body" ? receipt
        : stage === "auth" ? user
        : stage === "email-fetch" ? json({ id: "late-email" }) : { id: "late-email" });
      await vi.advanceTimersByTimeAsync(1);
      expect(state.status).toBe("rejected");
      expect(h.fetch).toHaveBeenCalledTimes(callsAtDeadline);
      if (stage.startsWith("edge")) expect(h.getUser).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("includes edge transport and auth lookup in the same budget as the email", async () => {
    vi.useFakeTimers();
    h.fetch.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(json(receipt)), 6_000)))
      .mockImplementationOnce(() => new Promise(() => {}));
    h.getUser.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(user), 3_000)));
    const state = observe(notify(input(["email"])));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(state.status).toBe("pending");
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.status).toBe("rejected");
    expect(h.fetch.mock.calls[1][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after an early rejection or successful receipt", async () => {
    vi.useFakeTimers();
    h.fetch.mockResolvedValueOnce(json({ ok: false })).mockResolvedValueOnce(json(receipt));
    await rejectedWithoutPrivateData(notify(input()));
    await expect(notify(input())).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
