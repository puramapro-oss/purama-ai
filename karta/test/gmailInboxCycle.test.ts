import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  rpc: vi.fn(), conn: vi.fn(), getPage: vi.fn(), getMessage: vi.fn(), policy: vi.fn(),
}));
vi.mock("../src/db/supabase.js", () => ({ supabase: {
  rpc: (name: string, params: Record<string, unknown>) => ({ abortSignal: () => mock.rpc(name, params) }),
} }));
vi.mock("../src/tools/gmail.js", () => ({
  GmailInboxPageExpired: class extends Error {}, getGmailInboxConnection: mock.conn, gmailInboxPage: mock.getPage,
  readGmailInboxMessage: mock.getMessage, assertGmailInboxPolicy: mock.policy, singleMailbox: (value: string) => value.toLowerCase(),
}));
import { getApprovedGmailInboxBinding, prepareGmailInboxCycle } from "../src/tools/gmail-inbox-cycle.js";
import { GmailInboxPageExpired } from "../src/tools/gmail.js";

const [user, run, config, policy, item, approval] = Array.from({ length: 6 }, (_, i) => `55000000-0000-4000-8000-00000000000${i}`);
const mailbox = "fixture@example.invalid";
const source = { id: "message1", threadId: "thread1", from: "author@example.invalid", subject: "Facture 12",
  body: "contenu de la facture", bodyStatus: "complete", replyToMessageId: "message1" };
const ref = { id: source.id, threadId: source.threadId };
const claimed = { status: "claimed", item_id: item, message_id: source.id, thread_id: source.threadId, mailbox, policy_version: policy };
const params = { replyToMessageId: source.id, threadId: source.threadId, to: source.from, subject: source.subject, body: "Justificatif" };
const conn = { id: config, updatedAt: "2026-11-26T01:00:00Z", lastSyncAt: "2026-11-26T00:00:00Z",
  policyVersion: policy, pageToken: null, scanStartedAt: null, mailbox, accessToken: "private-fixture",
  tone: "courtois", signature: "C.", excludedEmails: new Set(["private@example.invalid"]), excludedDomains: new Set() };
const ok = (data: unknown) => ({ data, error: null });
const cycle = () => prepareGmailInboxCycle(user, "email", run, "live");
beforeEach(() => {
  vi.resetAllMocks();
  mock.conn.mockResolvedValue(conn); mock.getMessage.mockResolvedValue(source); mock.policy.mockResolvedValue(undefined);
  mock.getPage.mockResolvedValue({ messages: [ref], next: "page2" });
  mock.rpc.mockImplementation(async (name, input) => {
    if (name === "gmail_inbox_claim") return ok(claimed);
    if (name === "gmail_inbox_approval_binding") return ok({ ...claimed, status: "bound" });
    if (name === "gmail_inbox_begin") return ok({ status: "armed" });
    if (name === "gmail_inbox_capture") return ok({ status: "captured" });
    if (name === "gmail_inbox_finish") return ok({ status: { complete: "done", ignored: "ignored", retry: "ready", unknown: "review" }[input.p_outcome as string] });
    throw new Error("Unexpected RPC");
  });
});
describe("Gmail durable input adapter", () => {
  it("keeps simulations entirely free of Gmail I/O for either inbox role", async () => {
    for (const role of ["email", "repondeur-intelligent"] as const) {
      const result = await prepareGmailInboxCycle(user, role, run, "simulation");
      expect(result.hasMessage).toBe(false);
      await expect(result.beforeEffect("gmail_send", params, "execute")).rejects.toThrow();
    }
    expect(mock.conn).not.toHaveBeenCalled(); expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("stops immediately on disabled mailbox", async () => {
    mock.conn.mockResolvedValue(null); expect((await cycle()).hasMessage).toBe(false);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("continues persisted pagination with the original cutoff and preserves only opaque identifiers", async () => {
    const stored = { ...conn, pageToken: "first", scanStartedAt: "2026-11-26T01:02:00Z" };
    mock.conn.mockResolvedValue(stored); mock.rpc.mockResolvedValueOnce(ok({ status: "empty" }));
    const result = await cycle();
    expect(result.context).toEqual({ tone: conn.tone, signature: conn.signature, newEmails: [source] });
    expect(mock.getPage).toHaveBeenCalledWith(conn.accessToken, conn.lastSyncAt, "first", stored.scanStartedAt);
    expect(mock.rpc).toHaveBeenCalledWith("gmail_inbox_capture", { p_user_id: user, p_config_id: config,
      p_config_updated_at: conn.updatedAt, p_previous_cursor: conn.lastSyncAt, p_sync_started_at: stored.scanStartedAt,
      p_messages: [ref], p_previous_page_token: "first", p_next_page_token: "page2", p_restart_scan: false });
    expect(mock.rpc.mock.calls.map(x => JSON.stringify(x)).join(" ")).not.toContain(source.body);
    expect(JSON.stringify(result.context)).not.toContain(conn.accessToken);
  });
  it("resets an expired continuation without consuming the date watermark", async () => {
    mock.conn.mockResolvedValue({ ...conn, pageToken: "expired", scanStartedAt: conn.updatedAt });
    mock.getPage.mockRejectedValue(new GmailInboxPageExpired());
    mock.rpc.mockResolvedValueOnce(ok({ status: "empty" }));
    expect((await cycle()).hasMessage).toBe(false);
    expect(mock.rpc).toHaveBeenCalledWith("gmail_inbox_capture", expect.objectContaining({
      p_messages: [], p_previous_page_token: "expired", p_previous_cursor: conn.lastSyncAt, p_next_page_token: null, p_restart_scan: true }));
    expect(mock.getMessage).not.toHaveBeenCalled();
  });
  it("doesn't claim on a concurrent capture or expose any model input", async () => {
    mock.rpc.mockResolvedValueOnce(ok({ status: "empty" })).mockResolvedValueOnce(ok({ status: "stale" }));
    const result = await cycle(); expect(result.hasMessage).toBe(false); expect(mock.getMessage).not.toHaveBeenCalled();
  });
  it("reads an already claimed message before issuing a new Gmail list query", async () => {
    const result = await cycle(); expect(mock.getPage).not.toHaveBeenCalled(); expect(result.hasMessage).toBe(true);
    await result.beforeInference(); expect(mock.policy).toHaveBeenCalledTimes(2);
    await result.beforeEffect("gmail_create_draft", params, "execute");
    await expect(result.beforeEffect("gmail_send", params, "execute")).rejects.toThrow();
    await result.finish("done", "draft:abcdef");
    expect(mock.rpc).toHaveBeenCalledWith("gmail_inbox_finish", { p_user_id: user, p_item_id: item, p_run_id: run, p_outcome: "complete", p_reference: "draft:abcdef" });
  });
  it.each(["threadId", "replyToMessageId", "to", "subject"])("refuses to arm a different %s", async key => {
    const result = await cycle();
    await expect(result.beforeEffect("gmail_send", { ...params, [key]: "different" }, "execute")).rejects.toThrow();
    expect(mock.rpc.mock.calls.some(([name]) => name === "gmail_inbox_begin")).toBe(false);
  });
  it("keeps inaccessible or excluded mail outside the model and records no external action", async () => {
    mock.getMessage.mockResolvedValue(null); expect((await cycle()).hasMessage).toBe(false);
    expect(mock.rpc).toHaveBeenCalledWith("gmail_inbox_finish", expect.objectContaining({ p_outcome: "ignored" }));
  });
  it("releases a provider read failure before any effect", async () => {
    mock.getMessage.mockRejectedValue(new Error("Fixture provider unavailable"));
    await expect(cycle()).rejects.toThrow(/Fixture/);
    expect(mock.rpc).toHaveBeenCalledWith("gmail_inbox_finish", expect.objectContaining({ p_outcome: "retry" }));
  });
  it("rechecks policy right before passing contents to inference", async () => {
    const result = await cycle();
    mock.policy.mockRejectedValue(new Error("disabled")); await expect(result.beforeInference()).rejects.toThrow(/disabled/);
    expect(mock.rpc.mock.calls.some(([name]) => name === "gmail_inbox_begin")).toBe(false);
  });
  it("keeps a received but unmatched approval/link outside the tool", async () => {
    await expect(getApprovedGmailInboxBinding(user, run, approval)).resolves.toEqual({ mailbox, policyVersion: policy, messageId: "message1", threadId: "thread1" });
    mock.rpc.mockResolvedValueOnce(ok({ status: "blocked" }));
    await expect(getApprovedGmailInboxBinding(user, run, approval)).rejects.toThrow();
    mock.rpc.mockResolvedValueOnce(ok({ status: "legacy" }));
    await expect(getApprovedGmailInboxBinding(user, run, approval)).resolves.toBeUndefined();
  });
});
