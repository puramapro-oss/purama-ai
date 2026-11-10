import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../src/engine/types.js";

const h = vi.hoisted(() => ({
  create: vi.fn(), execute: vi.fn(), finish: vi.fn(), record: vi.fn(), pending: vi.fn(),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic { messages = { create: h.create }; },
}));
vi.mock("../src/config.js", async original => {
  const actual = await original<typeof import("../src/config.js")>();
  return { ...actual, config: { ...actual.config, mockClaude: false } };
});
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async () => ({
    userId: "test-user", agentType: "legal", isEnabled: true, killSwitch: false,
    simulationMode: false, autonomyLevel: 2,
  }),
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({
  startRun: async () => ({ runId: "decision-completeness-run", finish: h.finish }),
}));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => undefined }));

const { createRealClaudeClient } = await import("../src/claude/real.js");
const { runAgentCycle } = await import("../src/engine/loop.js");
const definition: AgentDefinition = {
  type: "legal", systemPrompt: "Décide une action de test, ou explique pourquoi aucune n'est nécessaire.",
  buildContext: async () => ({}),
  tools: [{
    name: "act", description: "Action de test", sensitive: false, execute: h.execute,
    inputSchema: {
      type: "object", properties: { label: { type: "string", minLength: 1 } },
      required: ["label"], additionalProperties: false,
    },
  }],
};
const input = { systemPrompt: definition.systemPrompt, context: {}, tools: definition.tools, agentType: definition.type };
const tool = (id = "toolu_1", label = "préparer") => ({ type: "tool_use", id, name: "act", input: { label } });
const text = (value: string) => ({ type: "text", text: value });
const message = (stop_reason: unknown, content: unknown) => ({
  id: "msg_test", type: "message", role: "assistant", model: "test-model", content,
  stop_reason, stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 24 },
});
const decide = () => createRealClaudeClient().decide(input);
const run = () => runAgentCycle("test-user", definition, { type: "manual", source: "test" }, "test-execution-key");

beforeEach(() => {
  vi.clearAllMocks();
  h.create.mockResolvedValue(message("tool_use", [tool()]));
  h.execute.mockResolvedValue({ ok: true });
  h.finish.mockResolvedValue(undefined);
  h.record.mockResolvedValue(undefined);
  h.pending.mockResolvedValue("pending-test");
});

describe("real Claude decision completeness", () => {
  it.each([
    "max_tokens", "model_context_window_exceeded", "pause_turn", "refusal",
    "stop_sequence", "unknown_provider_stop", "", null, undefined,
  ])("rejects stop reason %j even if a tool block looks executable", async stop => {
    h.create.mockResolvedValue(message(stop, [text("Partiel"), tool()]));
    await expect(decide()).rejects.toThrow();
    expect(h.create).toHaveBeenCalledOnce();
  });

  it("accepts completed text and auxiliary thinking blocks without changing the text", async () => {
    h.create.mockResolvedValue(message("end_turn", [
      { type: "thinking", thinking: "test", signature: "test-signature" },
      text("Aucune action "), text("nécessaire. ✅"),
    ]));
    await expect(decide()).resolves.toMatchObject({
      summary: "Aucune action nécessaire. ✅", toolCalls: [], requiresApproval: false, mock: false,
    });
  });

  it("accepts tool_use without a text summary and preserves parallel calls in order", async () => {
    h.create.mockResolvedValue(message("tool_use", [tool(), tool("toolu_2", "vérifier")]));
    await expect(decide()).resolves.toMatchObject({
      toolCalls: [{ tool: "act", params: { label: "préparer" } }, { tool: "act", params: { label: "vérifier" } }],
      requiresApproval: false, mock: false,
    });
  });

  it("accepts a nonempty text summary with a completed tool request", async () => {
    h.create.mockResolvedValue(message("tool_use", [text("Je prépare."), tool()]));
    await expect(decide()).resolves.toMatchObject({ summary: "Je prépare.", toolCalls: [{ tool: "act", params: { label: "préparer" } }] });
  });

  it.each([
    ["empty content", []],
    ["blank text", [text(" \n\t ")]],
    ["thinking only", [{ type: "redacted_thinking", data: "test" }]],
  ])("does not qualify %s as a completed KARTA decision", async (_label, content) => {
    h.create.mockResolvedValue(message("end_turn", content));
    await expect(decide()).rejects.toThrow();
  });

  it("rejects tool_use without a client tool call", async () => {
    h.create.mockResolvedValue(message("tool_use", [text("Une action suivra.")]));
    await expect(decide()).rejects.toThrow();
  });

  it("rejects an end_turn that still contains an executable client tool call", async () => {
    h.create.mockResolvedValue(message("end_turn", [tool()]));
    await expect(decide()).rejects.toThrow();
  });

  it.each([
    ["null input", { ...tool("toolu_2"), input: null }],
    ["array input", { ...tool("toolu_2"), input: [] }],
    ["missing required argument", { ...tool("toolu_2"), input: {} }],
    ["wrong argument type", { ...tool("toolu_2"), input: { label: 42 } }],
    ["blank tool name", { ...tool("toolu_2"), name: " " }],
    ["unknown tool", { ...tool("toolu_2"), name: "unknown" }],
    ["missing tool id", { ...tool("toolu_2"), id: undefined }],
    ["duplicate tool id", tool("toolu_1")],
  ])("validates the entire decision before returning it: %s", async (_label, badTool) => {
    h.create.mockResolvedValue(message("tool_use", [tool(), badTool]));
    await expect(decide()).rejects.toThrow();
  });

  it("does not copy provider payload or argument names into validation errors", async () => {
    const marker = "private-payload-do-not-log";
    h.create.mockResolvedValue(message("tool_use", [
      tool(), { ...tool("toolu_2"), input: { label: "valid", [marker]: marker } },
    ]));
    let caught: unknown;
    try { await decide(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(marker);
  });
});

describe("real client through the KARTA loop, with a mocked provider transport", () => {
  it.each(["max_tokens", "model_context_window_exceeded", "pause_turn", "refusal", null])(
    "executes and queues no action when the decision ends with %j", async stop => {
      h.create.mockResolvedValue(message(stop, [tool(), tool("toolu_2", "suite")]));
      const result = await run();
      expect(h.execute).not.toHaveBeenCalled();
      expect(result.status).toBe("error");
      expect(result.toolsUsed).toEqual([]);
      expect(h.pending).not.toHaveBeenCalled();
      expect(h.create).toHaveBeenCalledOnce();
      expect(h.finish).toHaveBeenCalledWith(expect.objectContaining({ status: "error", toolsUsed: [] }));
    },
  );

  it("does not execute a valid first tool if a later tool fails its input schema", async () => {
    h.create.mockResolvedValue(message("tool_use", [tool(), { ...tool("toolu_2"), input: {} }]));
    const result = await run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.toolsUsed).toEqual([]);
    expect(h.pending).not.toHaveBeenCalled();
  });

  it("keeps the valid tool path functional and executes it once", async () => {
    const result = await run();
    expect(result.status).toBe("success");
    expect(result.toolsUsed).toHaveLength(1);
    expect(result.toolsUsed[0].outcome).toBe("executed");
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledWith({ label: "préparer" }, expect.objectContaining({ mode: "live" }));
    expect(h.create).toHaveBeenCalledOnce();
  });

  it("keeps a complete no-action decision as a successful cycle without effects", async () => {
    h.create.mockResolvedValue(message("end_turn", [text("Aucune action nécessaire.")]));
    const result = await run();
    expect(result.status).toBe("success");
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
  });
});
