import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, configUpdates, mailbox } = vi.hoisted(() => ({ rpc: vi.fn(async () => ({ data: 1, error: null })), configUpdates: [] as Array<Record<string, unknown>>, mailbox: { oauthAvailable: true } }));
vi.mock("../src/lib/gmail-token-crypto.js", () => ({ decryptGmailToken: (v: string) => v, encryptGmailToken: (v: string) => v }));
vi.mock("../src/config.js", () => ({ config: {} }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc, from: () => ({
  select() { return this; }, eq() { return this; },
  update(value: Record<string, unknown>) { configUpdates.push(value); return { eq: async () => ({ error: null }) }; },
  async maybeSingle() { return { data: { is_active: true, gmail_refresh_token: mailbox.oauthAvailable ? "fixture-refresh" : null, gmail_access_token: "fixture-access", gmail_token_expiry: new Date(Date.now() + 3600000).toISOString() }, error: null }; },
}) } }));

const { listNewGmailMessages, buildGmailInboxContext, gmailSendTool, gmailCreateDraftTool } = await import("../src/tools/gmail.js");
const ctx = { userId: "fixture-user", agentType: "email" as const, mode: "live" as const };
const longBody = "Première question : délai ?\n" + "Contexte. ".repeat(180) + "\nDernière question : puis-je annuler ?";
const parent = () => ({ id: "parent1", threadId: "thread1", snippet: longBody.slice(0, 153), payload: {
  mimeType: "text/plain", filename: "", headers: [
    { name: "From", value: "Camille <camille@example.com>" },
    { name: "Subject", value: "Question" },
    { name: "Message-ID", value: "<parent1@example.com>" },
    { name: "References", value: "<root@example.com>" },
    { name: "Content-Type", value: "text/plain; charset=UTF-8" },
  ], body: { size: Buffer.byteLength(longBody), data: Buffer.from(longBody).toString("base64url") },
} });
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  rpc.mockClear();
  configUpdates.length = 0;
  mailbox.oauthAvailable = true;
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/messages?")) return json({ messages: [{ id: "parent1", threadId: "thread1" }] });
    if (url.includes("/messages/parent1?")) return json(parent());
    if (url.includes("/threads/thread1?")) return json({ id: "thread1", messages: [parent()] });
    if (url.endsWith("/messages/send")) return json({ id: "sent1" });
    if (url.endsWith("/drafts")) return json({ id: "draft1" });
    throw new Error(`Unexpected fixture URL ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Gmail complete input and anchored replies", () => {
  it("preserves the final question beyond the 153-character preview", async () => {
    const [message] = await listNewGmailMessages("fixture-user", null);
    expect(message).toMatchObject({ body: longBody, bodyStatus: "complete" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("format=full"))).toBe(true);
  });
  it("sets verified thread and RFC parent headers on direct replies", async () => {
    await gmailSendTool.execute({ to: "camille@example.com", subject: "Question", body: "Réponse", threadId: "thread1", replyToMessageId: "parent1" }, ctx);
    const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/messages/send"))!;
    const payload = JSON.parse((post[1] as RequestInit).body as string);
    expect(payload.threadId).toBe("thread1");
    const raw = Buffer.from(payload.raw, "base64url").toString("utf8");
    expect(raw).toContain("In-Reply-To: <parent1@example.com>\r\n");
    expect(raw).toContain("References: <root@example.com> <parent1@example.com>\r\n");
  });
  it("uses the same parent checks for a draft", async () => {
    await gmailCreateDraftTool.execute({ to: "camille@example.com", subject: "Question", body: "Réponse", threadId: "thread1", replyToMessageId: "parent1" }, ctx);
    const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/drafts"))!;
    const payload = JSON.parse((post[1] as RequestInit).body as string);
    expect(Buffer.from(payload.message.raw, "base64url").toString("utf8")).toContain("In-Reply-To: <parent1@example.com>");
  });
  it("refuses a mismatched subject before reserving or posting", async () => {
    await expect(gmailSendTool.execute({ to: "camille@example.com", subject: "Autre sujet", body: "Réponse", threadId: "thread1", replyToMessageId: "parent1" }, ctx)).rejects.toThrow(/sujet/i);
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).endsWith("/messages/send"))).toBe(true);
  });
  it.each([
    ["wrong thread", (p: ReturnType<typeof parent>) => { p.threadId = "another-thread"; }],
    ["wrong id", (p: ReturnType<typeof parent>) => { p.id = "another-parent"; }],
    ["different sender", (p: ReturnType<typeof parent>) => { p.payload.headers[0]!.value = "other@example.com"; }],
    ["multiple senders", (p: ReturnType<typeof parent>) => { p.payload.headers[0]!.value = "victim@example.com, Camille <camille@example.com>"; }],
    ["Reply-To redirection", (p: ReturnType<typeof parent>) => { p.payload.headers.push({ name: "Reply-To", value: "other@example.com" }); }],
    ["duplicate subject", (p: ReturnType<typeof parent>) => { p.payload.headers.push({ name: "subject", value: "Question" }); }],
    ["Message-ID CRLF", (p: ReturnType<typeof parent>) => { p.payload.headers[2]!.value = "<parent@example.com>\r\nBcc: other@example.com"; }],
    ["References CRLF", (p: ReturnType<typeof parent>) => { p.payload.headers[3]!.value = "<root@example.com>\nBcc: other@example.com"; }],
    ["invalid References", (p: ReturnType<typeof parent>) => { p.payload.headers[3]!.value = "not-a-message-id"; }],
    ["missing Message-ID", (p: ReturnType<typeof parent>) => { p.payload.headers = p.payload.headers.filter(h => h.name !== "Message-ID"); }],
    ["unsupported parent body", (p: ReturnType<typeof parent>) => { p.payload.mimeType = "text/html"; }],
    ["oversized parent body", (p: ReturnType<typeof parent>) => { p.payload.body = { size: 65537, data: Buffer.from("a".repeat(65537)).toString("base64url") }; }],
  ])("rejects %s before any outbound effect", async (_label, mutate) => {
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.includes("/messages/parent1?")) throw new Error("No outbound request expected");
      const p = parent(); mutate(p); return json(p);
    });
    await expect(gmailSendTool.execute({ to: "camille@example.com", subject: "Question", body: "Réponse", threadId: "thread1", replyToMessageId: "parent1" }, ctx)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("supports a legacy draft only when the parent is unambiguous", async () => {
    const customCtx = { ...ctx, agentType: "custom:legacy-reply" as const };
    await expect(gmailCreateDraftTool.execute({ to: "camille@example.com", subject: "Question", body: "Réponse", threadId: "thread1" }, customCtx)).resolves.toEqual({ draftId: "draft1" });
    fetchMock.mockImplementation(async () => json({ id: "thread1", messages: [parent(), parent()] }));
    await expect(gmailCreateDraftTool.execute({ to: "camille@example.com", subject: "Question", body: "Réponse", threadId: "thread1" }, customCtx)).rejects.toThrow(/ambigu/);
  });
  it.each(["email", "repondeur-intelligent"] as const)("blocks missing reply identities in %s before I/O", async agentType => {
    await expect(gmailSendTool.execute({ to: "camille@example.com", subject: "Question", body: "Réponse" }, { ...ctx, agentType })).rejects.toThrow(/exige/);
    await expect(gmailCreateDraftTool.execute({ to: "camille@example.com", subject: "Question", body: "Réponse", threadId: "thread1" }, { ...ctx, agentType })).rejects.toThrow(/exige/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    { threadId: "thread1\r\nBcc: extra" },
    { replyToMessageId: "parent1" },
    { threadId: "thread1", replyToMessageId: "../parent1" },
  ])("rejects invalid or incomplete reply anchors before network access: %j", async reply => {
    await expect(gmailSendTool.execute({ to: "camille@example.com", subject: "Question", body: "Réponse", ...reply }, ctx)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("keeps an unsupported body explicit instead of treating the snippet as complete", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/messages?")) return json({ messages: [{ id: "parent1", threadId: "thread1" }] });
      const p = parent(); p.payload.mimeType = "text/html"; return json(p);
    });
    expect((await listNewGmailMessages("fixture-user", null))[0]).toMatchObject({ body: null, bodyStatus: "unsupported", snippet: longBody.slice(0, 153) });
  });
  it("refuses an oversized batch rather than advancing a truncated sync", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/messages?")) return json({ messages: Array.from({ length: 5 }, (_, i) => ({ id: `parent${i}`, threadId: "thread1" })) });
      const p = parent(); p.id = /\/messages\/([^?]+)\?/.exec(url)![1]!;
      p.payload.body = { size: 65536, data: Buffer.from("a".repeat(65536)).toString("base64url") };
      return json(p);
    });
    await expect(listNewGmailMessages("fixture-user", null)).rejects.toThrow(/Lot Gmail trop volumineux/);
  });
  it("retains the sensitive send flag and draft behavior", () => {
    expect(gmailSendTool.sensitive).toBe(true);
    expect(gmailCreateDraftTool.sensitive).toBe(false);
  });
  it("collects two pages, deduplicates IDs and uses the polling start as cursor", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-11-22T00:00:00.000Z"); vi.setSystemTime(start);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/messages?")) {
        return url.includes("pageToken=next")
          ? json({ messages: [{ id: "parent1", threadId: "thread1" }, { id: "parent2", threadId: "thread1" }] })
          : json({ messages: [{ id: "parent1", threadId: "thread1" }], nextPageToken: "next" });
      }
      vi.setSystemTime(new Date("2026-11-22T00:00:30.000Z"));
      const p = parent(); p.id = /\/messages\/([^?]+)\?/.exec(url)![1]!; return json(p);
    });
    const result = await buildGmailInboxContext("fixture-user");
    expect((result.newEmails as Array<{ id: string }>).map(x => x.id)).toEqual(["parent1", "parent2"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(configUpdates).toEqual([{ last_sync_at: start.toISOString(), last_email_id: "parent1" }]);
  });
  it.each(["repeated", "limit"] as const)("does not advance the cursor on %s pagination", async mode => {
    let page = 0;
    fetchMock.mockImplementation(async () => json({ messages: [], nextPageToken: mode === "repeated" ? "same-token" : `page-${++page}` }));
    await expect(buildGmailInboxContext("fixture-user")).rejects.toThrow(/Pagination Gmail/);
    expect(configUpdates).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(mode === "repeated" ? 2 : 5);
  });
  it("does not advance an active inbox cursor when OAuth is absent", async () => {
    mailbox.oauthAvailable = false;
    await expect(buildGmailInboxContext("fixture-user")).rejects.toThrow(/OAuth absent/);
    expect(configUpdates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
