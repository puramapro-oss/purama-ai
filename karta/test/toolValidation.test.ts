import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyToolDefinition } from "../src/engine/types.js";
import { defineTool, objectSchema, stringSchema, ToolInputError, validateToolInput } from "../src/tools/validation.js";

const spies = vi.hoisted(() => ({ database: vi.fn(), notify: vi.fn(), enqueue: vi.fn(), anthropic: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { from: spies.database } }));
vi.mock("../src/engine/notify.js", () => ({ notify: spies.notify }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: spies.enqueue }));
vi.mock("../src/config.js", () => ({ config: { anthropicApiKey: "offline-test", anthropicModelFast: "fast", anthropicModelMain: "main" } }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: spies.anthropic }; } }));

const registry = await import("../src/tools/registry.js");
const { createRealClaudeClient } = await import("../src/claude/real.js");
const ctx = { userId: "u1", agentType: "legal" as const, mode: "live" as const };
const samples: Array<[AnyToolDefinition, Record<string, unknown>]> = [
  [registry.apolloSearchPeopleTool, { keywords: "industrial design", limit: 10 }],
  [registry.calendarCreateEventTool, { title: "Appel", startIso: "2028-02-29T14:00:00+01:00", endIso: "2028-02-29T15:00:00+01:00", attendeeEmail: "a@example.com" }],
  [registry.delegateToAgentTool, { targetAgent: "legal", reason: "Examiner le document" }],
  [registry.docusealCreateSubmissionTool, { templateId: "42", signerName: "Test", signerEmail: "a@example.com" }],
  [registry.gmailCreateDraftTool, { threadId: "thread_1", to: "a@example.com", subject: "Question", body: "Bonjour\nMerci" }],
  [registry.gmailSendTool, { to: "a@example.com", subject: "Question", body: "Bonjour\nMerci" }],
  [registry.sendNotificationTool, { title: "Échéance", body: "Relire le document", priority: "normal" }],
  [registry.generatePdfTool, { title: "Note", paragraphs: ["Une ligne", ""], fileName: "note-1.pdf" }],
  [registry.stripeListUnpaidInvoicesTool, { customerEmail: "a@example.com" }],
  [registry.supabaseUpsertTool, { table: "legal_documents", row: { title: "Note", details: { tags: ["a", null, true, 2] } } }],
  [registry.supabaseSelectTool, { table: "legal_documents", filters: { title: "Note", valid: true, version: 2 }, limit: 20 }],
  [registry.webSearchTool, { query: "norme fabrication" }],
  [registry.zernioPublishTool, { title: "Note", content: "Contenu" }],
];

beforeEach(() => {
  vi.clearAllMocks();
  spies.database.mockImplementation(() => { throw new Error("Unexpected database access"); });
  spies.anthropic.mockResolvedValue({ content: [{ type: "text", text: "Aucune action" }] });
});

describe("runtime tool contracts", () => {
  for (const [tool, valid] of samples) {
    it(`${tool.name}: preserves valid JSON without coercion or mutation`, () => {
      const original = structuredClone(valid);
      expect(validateToolInput(tool, valid)).toEqual(original);
      expect(valid).toEqual(original);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(tool.inputSchema.properties).length).toBeGreaterThan(0);
    });

    it(`${tool.name}: rejects malformed direct calls before any service access`, async () => {
      await expect(tool.execute({ ...valid, unexpected: true }, ctx)).rejects.toThrow(ToolInputError);
      await expect(tool.execute(null, ctx)).rejects.toThrow(ToolInputError);
      expect(spies.database).not.toHaveBeenCalled();
      expect(spies.notify).not.toHaveBeenCalled();
      expect(spies.enqueue).not.toHaveBeenCalled();
    });
  }

  it("rejects every missing required parameter", () => {
    for (const [tool, valid] of samples) {
      for (const key of tool.inputSchema.required ?? []) {
        const incomplete = { ...valid };
        delete incomplete[key];
        expect(() => validateToolInput(tool, incomplete), `${tool.name}.${key}`).toThrow(ToolInputError);
      }
    }
  });

  it("rejects tools without an explicit runtime contract", () => {
    const unvalidated = { name: "legacy", description: "legacy", sensitive: false, execute: vi.fn() };
    expect(() => validateToolInput(unvalidated as unknown as AnyToolDefinition, {})).toThrow(/contrat/);
    expect(unvalidated.execute).not.toHaveBeenCalled();
  });

  it("executes a validated typed callback exactly once and rejects wrong types", async () => {
    const execute = vi.fn(async (params: { text: string }) => params.text);
    const tool = defineTool({ name: "test", description: "test", sensitive: false, input: objectSchema({ text: stringSchema() }), execute });
    await expect(tool.execute({ text: 42 }, ctx)).rejects.toThrow(ToolInputError);
    expect(execute).not.toHaveBeenCalled();
    await expect(tool.execute({ text: "ok" }, ctx)).resolves.toBe("ok");
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe("specific invalid inputs", () => {
  const calendar = { title: "Appel", startIso: "2028-02-29T14:00:00Z", endIso: "2028-02-29T15:00:00Z" };
  it.each(["tomorrow", "2027-02-29T14:00:00Z", "2028-02-30T14:00:00Z", "2028-02-29T24:00:00Z", "2028-02-29T14:00:00", "2028-02-29T14:60:00Z", "2028-02-29T14:00:00+24:00", 42])("rejects invalid calendar dates %s", (startIso) => {
    expect(() => validateToolInput(registry.calendarCreateEventTool, { ...calendar, startIso })).toThrow(ToolInputError);
  });
  it("rejects end before or equal to start, comparing instants across offsets", () => {
    expect(() => validateToolInput(registry.calendarCreateEventTool, { ...calendar, endIso: calendar.startIso })).toThrow(/postérieure/);
    expect(() => validateToolInput(registry.calendarCreateEventTool, { ...calendar, endIso: "2028-02-29T15:00:00+02:00" })).toThrow(/postérieure/);
  });
  it.each([0, -1, 101, 1.5, "2", NaN, Infinity])("rejects invalid numeric limits %s", (limit) => {
    expect(() => validateToolInput(registry.apolloSearchPeopleTool, { keywords: "test", limit })).toThrow(ToolInputError);
    expect(() => validateToolInput(registry.supabaseSelectTool, { table: "legal_documents", limit })).toThrow(ToolInputError);
  });
  it("rejects header injection, unsupported filenames, enum values and blank searches", () => {
    expect(() => validateToolInput(registry.gmailSendTool, { to: "a@example.com\r\nBcc:b@example.com", subject: "s", body: "b" })).toThrow(ToolInputError);
    expect(() => validateToolInput(registry.gmailSendTool, { to: "a@example.com", subject: "s\nBcc:b@example.com", body: "b" })).toThrow(ToolInputError);
    expect(() => validateToolInput(registry.generatePdfTool, { title: "Note", paragraphs: [], fileName: "../secret.pdf" })).toThrow(ToolInputError);
    expect(() => validateToolInput(registry.sendNotificationTool, { title: "Note", body: "Texte", priority: "root" })).toThrow(ToolInputError);
    expect(() => validateToolInput(registry.delegateToAgentTool, { targetAgent: "custom:other", reason: "test" })).toThrow(ToolInputError);
    expect(() => validateToolInput(registry.webSearchTool, { query: " \n " })).toThrow(ToolInputError);
  });
  it("rejects non-JSON, non-scalar filters, dangerous keys and excessive payloads", () => {
    for (const row of [null, [], { amount: NaN }, { amount: 3n }, { date: new Date() }, JSON.parse('{"__proto__":{"polluted":true}}'), { data: "x".repeat(100_001) }]) {
      expect(() => validateToolInput(registry.supabaseUpsertTool, { table: "legal_documents", row })).toThrow(ToolInputError);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateToolInput(registry.supabaseUpsertTool, { table: "legal_documents", row: cyclic })).toThrow(ToolInputError);
    expect(() => validateToolInput(registry.supabaseSelectTool, { table: "legal_documents", filters: { title: { eq: "x" } } })).toThrow(ToolInputError);
    expect(() => validateToolInput(registry.supabaseSelectTool, { table: "legal_documents", filters: { "title,other": "x" } })).toThrow(ToolInputError);
  });
});

it("passes the actual parameter contracts to the Claude SDK", async () => {
  await createRealClaudeClient().decide({ agentType: "legal", systemPrompt: "test", context: {}, tools: [registry.calendarCreateEventTool, registry.supabaseUpsertTool] });
  expect(spies.anthropic).toHaveBeenCalledOnce();
  const request = spies.anthropic.mock.calls[0][0];
  expect(request.tools[0].input_schema).toEqual(registry.calendarCreateEventTool.inputSchema);
  expect(request.tools[0].input_schema.required).toEqual(["title", "startIso", "endIso"]);
  expect(request.tools[0].input_schema.properties.startIso.format).toBe("date-time");
  expect(request.tools[1].input_schema.required).toEqual(["table", "row"]);
  expect(request.tools[1].input_schema.properties.table.enum).toContain("legal_documents");
});
