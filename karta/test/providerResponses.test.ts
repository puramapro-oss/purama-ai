import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDefinition, AnyToolDefinition } from "../src/engine/types.js";

const h = vi.hoisted(() => ({
  fetch: vi.fn(), upload: vi.fn(), publicUrl: vi.fn(), invoices: vi.fn(),
  decide: vi.fn<() => Promise<AgentDecision>>(), finish: vi.fn(),
  config: {
    docusealApiKey: "offline-test", docusealBaseUrl: "https://docuseal.invalid",
    zernioApiKey: "offline-test", zernioBaseUrl: "https://adapter.invalid",
    stripeSecretKey: "offline-test",
  },
}));

vi.mock("../src/config.js", () => ({ config: h.config }));
vi.mock("../src/lib/gmail-token-crypto.js", () => ({
  decryptGmailToken: (value: string) => value, encryptGmailToken: (value: string) => value,
}));
vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (!["email_agent_config", "karta_agent_memory"].includes(table)) throw new Error("Unexpected database access");
      return {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn(async () => ({
          data: table === "email_agent_config" ? {
            gmail_refresh_token: "refresh", gmail_access_token: "access",
            gmail_token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
          } : null,
          error: null,
        })),
        upsert: vi.fn(async () => ({ error: null })),
      };
    }),
    storage: { from: vi.fn(() => ({ upload: h.upload, getPublicUrl: h.publicUrl })) },
  },
}));
vi.mock("stripe", () => ({ default: class { invoices = { list: h.invoices }; } }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide }) }));
vi.mock("../src/engine/autonomy.js", () => ({
  isRunnable: () => ({ ok: true }), requiresHumanApproval: () => false,
  loadAgentState: async () => ({ simulationMode: false }), recordRunOutcome: vi.fn(),
}));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "run-1", finish: h.finish }) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: vi.fn() }));
vi.mock("../src/engine/notify.js", () => ({ notify: vi.fn() }));

const { calendarCreateEventTool } = await import("../src/tools/calendar.js");
const { gmailCreateDraftTool, gmailSendTool, listNewGmailMessages } = await import("../src/tools/gmail.js");
const { docusealCreateSubmissionTool } = await import("../src/tools/docuseal.js");
const { zernioPublishTool } = await import("../src/tools/zernio.js");
const { generatePdfTool } = await import("../src/tools/pdf.js");
const { stripeListUnpaidInvoicesTool } = await import("../src/tools/stripe-tool.js");
const { runAgentCycle } = await import("../src/engine/loop.js");

const ctx = { userId: "user-1", agentType: "legal" as const, mode: "live" as const };
const calendarInput = { title: "Call", startIso: "2028-01-01T12:00:00Z", endIso: "2028-01-01T13:00:00Z" };
const emailInput = { to: "a@example.com", subject: "Subject", body: "Body" };
const docusealInput = { templateId: "42", signerName: "Test", signerEmail: "a@example.com" };
const pdfInput = { title: "Test", paragraphs: ["Text"], fileName: "test.pdf" };
const publicationInput = { title: "Test", content: "Text" };
const idTools: Array<[AnyToolDefinition, Record<string, unknown>, string]> = [
  [calendarCreateEventTool, calendarInput, "eventId"],
  [gmailCreateDraftTool, { ...emailInput, threadId: "thread-1" }, "draftId"],
  [gmailSendTool, emailInput, "messageId"],
  [zernioPublishTool, publicationInput, "publicationId"],
];

function respond(body: unknown, status = 200): void {
  h.fetch.mockResolvedValue({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.fetch.mockReset();
  h.upload.mockReset();
  h.publicUrl.mockReset();
  h.invoices.mockReset();
  h.decide.mockReset();
  h.finish.mockResolvedValue(undefined);
  h.config.zernioBaseUrl = "https://adapter.invalid";
  h.fetch.mockRejectedValue(new Error("Unexpected HTTP access"));
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("provider creation acknowledgements", () => {
  for (const [tool, input, resultKey] of idTools) {
    it(`${tool.name}: returns a provider id without claiming delivery`, async () => {
      respond({ id: "provider-1", extra: "provider extension" });
      await expect(tool.execute(input, ctx)).resolves.toEqual({ [resultKey]: "provider-1" });
      expect(h.fetch).toHaveBeenCalledOnce();
    });

    it.each([{}, null, false, [], { id: 42 }, { id: " " }, { error: { message: "denied" } }, { id: "provider-1", error: { message: "denied" } }].map((body) => ({ body })))(
      `${tool.name}: refuses malformed HTTP 2xx body $body without a second request`, async ({ body }) => {
        respond(body);
        await expect(tool.execute(input, ctx)).rejects.toThrow(/réponse fournisseur invalide/);
        expect(h.fetch).toHaveBeenCalledOnce();
      },
    );

    it(`${tool.name}: preserves a provider HTTP failure without retrying`, async () => {
      respond({ error: "denied" }, 403);
      await expect(tool.execute(input, ctx)).rejects.toThrow(/403/);
      expect(h.fetch).toHaveBeenCalledOnce();
    });
  }

  it("refuses a Calendar cancellation acknowledgement", async () => {
    respond({ id: "event-1", status: "cancelled" });
    await expect(calendarCreateEventTool.execute(calendarInput, ctx)).rejects.toThrow(/non confirmé/);
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("preserves a legitimate empty Gmail inbox result", async () => {
    respond({ resultSizeEstimate: 0 });
    await expect(listNewGmailMessages("user-1", null)).resolves.toEqual([]);
  });
});

describe("DocuSeal response and template contract", () => {
  it("uses the documented submission_id rather than the submitter id", async () => {
    respond([{ id: 101, submission_id: 55, status: "sent" }]);
    await expect(docusealCreateSubmissionTool.execute(docusealInput, ctx)).resolves.toEqual({ submissionId: "55" });
    expect(JSON.parse(h.fetch.mock.calls[0][1].body).template_id).toBe(42);
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it.each([{}, null, false, [], { id: 55 }, [{ id: 101 }], [{ submission_id: "55" }], [{ submission_id: 0 }], [{ submission_id: 1.5 }], [{ submission_id: 55 }, { submission_id: 56 }]].map((body) => ({ body })))(
    "rejects an unconfirmed or inconsistent submission response $body", async ({ body }) => {
      respond(body);
      await expect(docusealCreateSubmissionTool.execute(docusealInput, ctx)).rejects.toThrow(/non confirmé/);
      expect(h.fetch).toHaveBeenCalledOnce();
    },
  );

  it("rejects a submitter id accompanied by an explicit provider error", async () => {
    respond([{ id: 101, submission_id: 55, error: "signature request failed" }]);
    await expect(docusealCreateSubmissionTool.execute(docusealInput, ctx)).rejects.toThrow(/non confirmé/);
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it.each(["NaN", "0", "01", "-1", "1.5", "1e3", "9007199254740992"])("rejects noncanonical or unsafe template id %s before HTTP", async (templateId) => {
    await expect(docusealCreateSubmissionTool.execute({ ...docusealInput, templateId }, ctx)).rejects.toThrow(/Paramètres invalides/);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("public Zernio contract is not implemented by the legacy adapter", () => {
  it.each(["https://zernio.com/api/v1", "https://ZERNIO.COM/api/v1/", "https://zernio.com./api/v1", "https://api.zernio.com/api/v1", "https://API.ZERNIO.COM.:443/api/v1"])(
    "blocks %s before sending an unsupported publication", async (baseUrl) => {
      h.config.zernioBaseUrl = baseUrl;
      await expect(zernioPublishTool.execute(publicationInput, ctx)).rejects.toThrow(/comptes et plateformes autorisés requis/);
      expect(h.fetch).not.toHaveBeenCalled();
    },
  );
});

describe("PDF storage acknowledgement", () => {
  it("requires the upload id, matching path and provider bucket/object key before returning a generated public URL", async () => {
    h.upload.mockImplementation(async (path: string) => ({ data: { id: "storage-1", path, fullPath: `agent-documents/${path}` }, error: null }));
    h.publicUrl.mockReturnValue({ data: { publicUrl: "https://storage.invalid/test.pdf" } });
    await expect(generatePdfTool.execute(pdfInput, ctx)).resolves.toEqual({ url: "https://storage.invalid/test.pdf" });
    expect(h.upload).toHaveBeenCalledOnce();
    expect(h.upload.mock.calls[0][1].subarray(0, 4).toString()).toBe("%PDF");
  });

  it.each([null, {}, { id: 42 }, { id: "storage-1", path: "wrong/path.pdf" }])("refuses unconfirmed upload data %j", async (data) => {
    h.upload.mockResolvedValue({ data, error: null });
    await expect(generatePdfTool.execute(pdfInput, ctx)).rejects.toThrow(/non confirmé/);
    expect(h.upload).toHaveBeenCalledOnce();
    expect(h.publicUrl).not.toHaveBeenCalled();
  });

  it("rejects a SDK-generated matching path when the remote response omitted its id", async () => {
    h.upload.mockImplementation(async (path: string) => ({ data: { path, fullPath: `agent-documents/${path}` }, error: null }));
    await expect(generatePdfTool.execute(pdfInput, ctx)).rejects.toThrow(/non confirmé/);
    expect(h.publicUrl).not.toHaveBeenCalled();
  });

  it.each(["missing", "wrong bucket", "wrong path"])("rejects a provider object key that is %s despite a matching local path and valid id", async (kind) => {
    h.upload.mockImplementation(async (path: string) => ({
      data: { id: "storage-1", path, fullPath: kind === "missing" ? undefined : kind === "wrong bucket" ? `other-bucket/${path}` : "agent-documents/other.pdf" },
      error: null,
    }));
    await expect(generatePdfTool.execute(pdfInput, ctx)).rejects.toThrow(/non confirmé/);
    expect(h.upload).toHaveBeenCalledOnce();
    expect(h.publicUrl).not.toHaveBeenCalled();
  });

  it("preserves an upload provider error and does not construct an apparent success URL", async () => {
    h.upload.mockResolvedValue({ data: null, error: { message: "storage denied" } });
    await expect(generatePdfTool.execute(pdfInput, ctx)).rejects.toThrow(/storage denied/);
    expect(h.upload).toHaveBeenCalledOnce();
    expect(h.publicUrl).not.toHaveBeenCalled();
  });

  it.each([{}, { publicUrl: " " }, { publicUrl: 42 }, { publicUrl: "javascript:alert(1)" }])("rejects malformed public URL data after one acknowledged upload %j", async (data) => {
    h.upload.mockImplementation(async (path: string) => ({ data: { id: "storage-1", path, fullPath: `agent-documents/${path}` }, error: null }));
    h.publicUrl.mockReturnValue({ data });
    await expect(generatePdfTool.execute(pdfInput, ctx)).rejects.toThrow(/non confirmé/);
    expect(h.upload).toHaveBeenCalledOnce();
  });
});

describe("Stripe invoice read contract", () => {
  it("allows a legitimate empty list", async () => {
    h.invoices.mockResolvedValue({ data: [] });
    await expect(stripeListUnpaidInvoicesTool.execute({}, ctx)).resolves.toEqual({ invoices: [] });
  });

  it("returns validated invoice fields and preserves the customer filter", async () => {
    h.invoices.mockResolvedValue({ data: [
      { id: "inv-1", amount_due: 100, due_date: null, customer_email: "a@example.com" },
      { id: "inv-2", amount_due: 0, due_date: 1_900_000_000, customer_email: "b@example.com" },
    ] });
    await expect(stripeListUnpaidInvoicesTool.execute({ customerEmail: "a@example.com" }, ctx)).resolves.toEqual({
      invoices: [{ id: "inv-1", amountDue: 100, dueDate: null }],
    });
  });

  it.each([{}, false, { data: null }, { data: [{}] }, { data: [{ id: "", amount_due: 1, due_date: null, customer_email: null }] },
    { data: [{ id: "inv-1", amount_due: "100", due_date: null, customer_email: null }] },
    { data: [{ id: "inv-1", amount_due: 100, due_date: "tomorrow", customer_email: null }] }])(
    "rejects malformed provider records instead of fabricating invoice values %j", async (body) => {
      h.invoices.mockResolvedValue(body);
      await expect(stripeListUnpaidInvoicesTool.execute({}, ctx)).rejects.toThrow(/non confirmé/);
      expect(h.invoices).toHaveBeenCalledOnce();
    },
  );
});

it("keeps a real-tool malformed acknowledgement unknown and stops later cycle effects", async () => {
  respond({});
  h.decide.mockResolvedValue({
    summary: "Create two events", requiresApproval: false, mock: true,
    toolCalls: [{ tool: "calendar_create_event", params: calendarInput }, { tool: "calendar_create_event", params: calendarInput }],
  });
  const definition: AgentDefinition = {
    type: "legal", systemPrompt: "test", tools: [calendarCreateEventTool], buildContext: async () => ({}),
  };
  const result = await runAgentCycle("user-1", definition, { type: "manual", source: "test" });
  expect(result.status).toBe("error");
  expect(result.retrySafe).toBe(false);
  expect(result.toolsUsed).toHaveLength(1);
  expect(result.toolsUsed[0]).toMatchObject({ outcome: "unknown", success: false });
  expect(result.toolsUsed[0].resultSummary).toMatch(/non confirmé/);
  expect(h.fetch).toHaveBeenCalledOnce();
});
