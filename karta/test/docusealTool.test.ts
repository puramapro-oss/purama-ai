import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docusealCreateSubmissionTool } from "../src/tools/docuseal.js";
import type { ToolExecutionContext } from "../src/engine/types.js";

const h = vi.hoisted(() => ({
  config: { docusealApiKey: "test-only-docuseal", docusealBaseUrl: "https://docuseal.example.invalid" },
}));
vi.mock("../src/config.js", () => ({ config: h.config }));

const send = vi.fn<typeof fetch>();
const input = { templateId: "12", signerName: "Signer", signerEmail: "signer@example.test" };
const context = { userId: "owner", agentType: "legal", mode: "live", operationId: "approval-1" } as const satisfies ToolExecutionContext;
const unconfirmed = "Création DocuSeal non confirmée : vérifier la demande avant toute reprise";
const receipt = (overrides: Record<string, unknown> = {}) => ({
  id: 17, submission_id: 42, email: input.signerEmail, status: "sent", ...overrides,
});
const execute = () => docusealCreateSubmissionTool.execute({ ...input }, { ...context });

beforeEach(() => {
  send.mockReset();
  vi.stubGlobal("fetch", send);
  h.config.docusealApiKey = "test-only-docuseal";
  h.config.docusealBaseUrl = "https://docuseal.example.invalid";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DocuSeal submission creation receipt", () => {
  it("returns the submission identity from the submitter array without confusing it with the signer identity", async () => {
    send.mockResolvedValue(Response.json([receipt()]));
    await expect(execute()).resolves.toEqual({ submissionId: "42" });
    expect(send).toHaveBeenCalledExactlyOnceWith("https://docuseal.example.invalid/api/submissions", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-Auth-Token": "test-only-docuseal" }),
      body: JSON.stringify({ template_id: "12", submitters: [{ name: input.signerName, email: input.signerEmail }] }),
    }));
    expect(docusealCreateSubmissionTool.sensitive).toBe(true);
  });

  it("accepts consistent submitters when the requested signer is not the first entry", async () => {
    send.mockResolvedValue(Response.json([
      receipt({ id: 18, email: "other@example.test" }), receipt({ email: " SIGNER@EXAMPLE.TEST " }),
    ]));
    await expect(execute()).resolves.toEqual({ submissionId: "42" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("accepts the largest safe positive submission identity without truncation", async () => {
    send.mockResolvedValue(Response.json([receipt({ submission_id: Number.MAX_SAFE_INTEGER })]));
    await expect(execute()).resolves.toEqual({ submissionId: String(Number.MAX_SAFE_INTEGER) });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "empty object", value: {} },
    { label: "legacy object envelope", value: { id: 42, submission_id: 42, email: input.signerEmail } },
    { label: "null", value: null },
    { label: "empty submitter array", value: [] },
    { label: "null submitter", value: [null] },
    { label: "scalar submitter", value: [42] },
    { label: "nested array", value: [[receipt()]] },
    { label: "missing submission identity", value: [{ id: 17, email: input.signerEmail }] },
    { label: "string submission identity", value: [receipt({ submission_id: "42" })] },
    { label: "null submission identity", value: [receipt({ submission_id: null })] },
    { label: "zero submission identity", value: [receipt({ submission_id: 0 })] },
    { label: "negative submission identity", value: [receipt({ submission_id: -1 })] },
    { label: "fractional submission identity", value: [receipt({ submission_id: 4.2 })] },
    { label: "unsafe submission identity", value: [receipt({ submission_id: Number.MAX_SAFE_INTEGER + 1 })] },
    { label: "inconsistent submission identities", value: [receipt(), receipt({ id: 18, submission_id: 43 })] },
    { label: "later submitter without submission identity", value: [receipt(), { id: 18, email: "other@example.test" }] },
    { label: "missing expected signer", value: [receipt({ email: "other@example.test" })] },
    { label: "missing signer email", value: [receipt({ email: undefined })] },
    { label: "nonstring signer email", value: [receipt({ email: 7 })] },
    { label: "contradictory provider error", value: [receipt({ error: "PRIVATE_PROVIDER_FAILURE" })] },
  ])("refuses $label without another POST", async ({ value }) => {
    send.mockResolvedValue(Response.json(value));
    await expect(execute()).rejects.toThrow(unconfirmed);
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not contact the provider without its configured credential", async () => {
    h.config.docusealApiKey = "";
    await expect(execute()).rejects.toThrow("DOCUSEAL_API_KEY non configurée côté KARTA");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("DocuSeal canonical tool-result envelope", () => {
  it.each([
    { label: "ok false", entries: [receipt({ ok: false })] },
    { label: "success false", entries: [receipt({ success: false })] },
    { label: "contradictory ok", entries: [receipt({ ok: false, success: true })] },
    { label: "contradictory success", entries: [receipt({ ok: true, success: false })] },
    { label: "later ok false", entries: [receipt(), receipt({ id: 18, ok: false })] },
    { label: "later success false", entries: [receipt(), receipt({ id: 18, success: false })] },
  ])("refuses $label even with a matching submission and signer", async ({ entries }) => {
    send.mockResolvedValue(Response.json(entries));
    await expect(execute()).rejects.toThrow(unconfirmed);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([{ ok: true }, { success: true }, { ok: true, success: true }, { error: null }, { error: false }, { error: "" }])(
    "retains a valid non-failure envelope: %j", async flags => {
      send.mockResolvedValue(Response.json([receipt(flags)]));
      await expect(execute()).resolves.toEqual({ submissionId: "42" });
      expect(send).toHaveBeenCalledOnce();
    },
  );
});

describe("DocuSeal provider completion boundaries", () => {
  it.each([
    { label: "HTTP error", response: () => Response.json({ error: "PRIVATE_PROVIDER_DIAGNOSTIC" }, { status: 500 }) },
    { label: "redirect", response: () => new Response(null, { status: 302, headers: { location: "https://other.example.invalid" } }) },
    { label: "invalid JSON", response: () => new Response("PRIVATE_INVALID_JSON", { status: 200 }) },
    { label: "oversized body", response: () => Response.json([receipt({ extra: "x".repeat(64 * 1024) })]) },
  ])("reports $label as unconfirmed without exposing or retrying it", async ({ response }) => {
    send.mockResolvedValue(response());
    const failure: unknown = await execute().catch(error => error);
    expect(failure).toEqual(new Error(unconfirmed));
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not expose a transport exception that may contain secrets", async () => {
    send.mockRejectedValue(new Error("PRIVATE_PROVIDER_DIAGNOSTIC"));
    await expect(execute()).rejects.toThrow(unconfirmed);
    expect(send).toHaveBeenCalledOnce();
  });

  it("accepts a valid response at the 64 KiB limit and closes its timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const body = JSON.stringify([receipt()]);
    send.mockResolvedValue(new Response(body + " ".repeat(64 * 1024 - Buffer.byteLength(body))));
    await expect(execute()).resolves.toEqual({ submissionId: "42" });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an unresponsive POST even when its transport ignores cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    send.mockImplementation(() => new Promise<Response>(() => {}));
    const result = execute().catch(error => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toEqual(new Error(unconfirmed));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes a stalled response body in the same deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    send.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('[{"submission_id":42')); },
    })));
    const result = execute().catch(error => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toEqual(new Error(unconfirmed));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept a late receipt or issue a second creation after its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    let respond!: (value: Response) => void;
    send.mockImplementation(() => new Promise<Response>(resolve => { respond = resolve; }));
    const result = execute().catch(error => error);
    await vi.advanceTimersByTimeAsync(20_000);
    const failure = await result;
    expect(failure).toEqual(new Error(unconfirmed));
    respond(Response.json([receipt()]));
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(failure);
    expect(send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
