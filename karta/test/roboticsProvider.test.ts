import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wire = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: wire.create }; } }));
vi.mock("../src/config.js", () => ({ config: {
  anthropicApiKey: "test-only-not-a-secret", anthropicModelFast: "test-fast", anthropicModelMain: "test-main",
} }));

import { createRealClaudeClient } from "../src/claude/real.js";
import { robotCatalogTool, robotPlanSessionTool, robotSimulateSessionTool } from "../src/tools/robotics.js";
import { executeToolStrict } from "../src/engine/tool-result.js";
import type { AnyToolDefinition } from "../src/engine/types.js";

const NOW = Date.now();
const input = (tools: AnyToolDefinition[] = [robotCatalogTool, robotPlanSessionTool, robotSimulateSessionTool]) => ({
  agentType: "custom:robotics", systemPrompt: "Prépare une simulation PURAMA.", context: {}, tools,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  wire.create.mockResolvedValue({ content: [], stop_reason: "end_turn" });
});
afterEach(() => vi.restoreAllMocks());

describe("robotics provider boundary — real adapter, mocked remote service", () => {
  it("sends complete robot input schemas and a trusted current clock to the model", async () => {
    await createRealClaudeClient().decide(input());
    const sent = wire.create.mock.calls[0][0];
    expect(sent.messages[0].content).toContain(`serverTimeEpochMs=${NOW}`);
    const catalog = sent.tools.find((tool: { name: string }) => tool.name === "robot_catalog").input_schema;
    expect(catalog.additionalProperties).toBe(false);
    expect(catalog.properties.targetId.enum).toContain("tesla-optimus");
    const plan = sent.tools.find((tool: { name: string }) => tool.name === "robot_plan_session").input_schema;
    expect(plan.required).toEqual(["version", "sessionId", "targetId", "expiresAt", "steps"]);
    expect(plan.properties.steps.maxItems).toBe(24);
    expect(plan.properties.steps.items.oneOf).toHaveLength(3);
    const simulation = sent.tools.find((tool: { name: string }) => tool.name === "robot_simulate_session").input_schema;
    expect(simulation.properties.targetId.const).toBe("purama-simulator");
  });
  it("preserves the previous schema fallback for unrelated tools", async () => {
    await createRealClaudeClient().decide(input([{ name: "legacy", description: "Existing tool", sensitive: false, execute: async () => ({ ok: true }) }]));
    expect(wire.create.mock.calls[0][0].tools[0].input_schema).toEqual({ type: "object", properties: {}, additionalProperties: true });
  });
  it("takes a structured provider response through runtime validation and execution", async () => {
    wire.create.mockResolvedValueOnce({ stop_reason: "tool_use", content: [{
      type: "tool_use", name: "robot_simulate_session", input: {
        version: 1, sessionId: "provider-audit", targetId: "purama-simulator", expiresAt: NOW + 60_000,
        steps: [{ id: "welcome", kind: "speech", text: "Bienvenue.", durationMs: 1_000 }],
      },
    }] });
    const decision = await createRealClaudeClient().decide(input());
    const result = await executeToolStrict(robotSimulateSessionTool, decision.toolCalls[0].params, {
      userId: "provider-owner", agentType: "custom:robotics", mode: "live",
    });
    expect(result).toContain('"execution":"simulation"');
    expect(result).toContain('"physicalActions":0');
  });
});
