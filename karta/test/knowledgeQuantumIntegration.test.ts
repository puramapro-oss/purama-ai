import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDefinition, ToolExecutionContext } from "../src/engine/types.js";

const h = vi.hoisted(() => ({
  simulation: false,
  decision: { summary: "", toolCalls: [], requiresApproval: false, mock: false } as AgentDecision,
  finish: vi.fn(),
  record: vi.fn(),
  pending: vi.fn(),
}));

vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: async () => h.decision }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async () => ({
    userId: "integration-user", agentType: "legal", isEnabled: true, killSwitch: false,
    simulationMode: h.simulation, autonomyLevel: 2,
  }),
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({
  startRun: async () => ({ runId: "knowledge-quantum-run", finish: h.finish }),
}));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => undefined }));
// Registry imports can reach the static delegation module. This suite exercises
// tool selection and a simulated cycle, so a Redis connection is never needed.
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));

const { CUSTOM_AGENT_TOOL_NAMES, resolveCustomAgentTools } = await import("../src/tools/customRegistry.js");
const { buildCustomAgentDefinition } = await import("../src/agents/customAgent.js");
const { knowledgeSearchTool, createKnowledgeSearchTool } = await import("../src/tools/knowledge-search.js");
const { quantumSimulateTool } = await import("../src/tools/quantum.js");
const { runAgentCycle } = await import("../src/engine/loop.js");
const { assertToolResult } = await import("../src/engine/tool-result.js");
const { shouldMinimizeToolTrace, summarizeToolParams, summarizeToolResult } = await import("../src/engine/tool-trace.js");

const ctx: ToolExecutionContext = {
  userId: "integration-user", agentType: "legal", mode: "live", operationId: "integration-operation",
};
const toolNames = ["knowledge_search", "quantum_simulate"];
const marker = "PRIVATE_KNOWLEDGE_QUANTUM_SENTINEL_74361";

beforeEach(() => {
  vi.clearAllMocks();
  h.simulation = false;
  h.decision = { summary: "", toolCalls: [], requiresApproval: false, mock: false };
  h.finish.mockResolvedValue(undefined);
  h.record.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("knowledge and quantum integration with the existing agent catalogue", () => {
  it("rejects inherited object properties while preserving explicitly registered tool names", () => {
    expect(resolveCustomAgentTools([
      "__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "knowledge_search", "quantum_simulate",
    ])).toEqual([knowledgeSearchTool, quantumSimulateTool]);
  });

  it("resolves the actual shared tools without wrappers that weaken their trace policy", () => {
    const registered = resolveCustomAgentTools(toolNames);
    expect(registered).toEqual([knowledgeSearchTool, quantumSimulateTool]);
    for (const tool of registered) {
      expect(tool.tracePolicy).toBe("metadata_only");
      expect(tool.sensitive).toBe(false);
      expect(shouldMinimizeToolTrace(tool)).toBe(true);
    }
  });

  it.each([{ tools: [] as string[] }, { tools: ["web_search"] }])("does not grant either new capability to an existing agent with $tools", ({ tools }) => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111", user_id: ctx.userId,
      name: "Existing personal agent", description: null, system_prompt: "Existing role",
      tools_enabled: [...tools], karta_enabled: true, is_active: true,
      schedule_enabled: false, schedule_cron: null,
    };
    const before = JSON.stringify(row);
    const definition = buildCustomAgentDefinition(row);
    expect(definition.tools.map(tool => tool.name)).toEqual(tools);
    expect(JSON.stringify(row)).toBe(before);
    expect(definition.tools.some(tool => toolNames.includes(tool.name))).toBe(false);
  });

  it("keeps the selectable frontend and generated edge catalogues aligned with the runtime allowlist", () => {
    // Read declarations rather than importing the frontend Supabase client or
    // executing a Deno HTTP handler in a Node unit test.
    const frontend = readFileSync(new URL("../../src/lib/creator-agent.ts", import.meta.url), "utf8");
    const edge = readFileSync(new URL("../../supabase/functions/creator-agent-generate/index.ts", import.meta.url), "utf8");
    const frontendBlock = frontend.match(/export const TOOL_OPTIONS = \[([\s\S]*?)\] as const;/)?.[1];
    const edgeBlock = edge.match(/const REAL_TOOL_NAMES = \[([\s\S]*?)\] as const;/)?.[1];
    expect(frontendBlock).toBeDefined();
    expect(edgeBlock).toBeDefined();
    const frontendNames = Array.from(frontendBlock!.matchAll(/\{\s*value:\s*'([^']+)'/g), match => match[1]);
    const edgeNames = Array.from(edgeBlock!.matchAll(/"([a-z_]+)"/g), match => match[1]);
    expect(frontendNames.sort()).toEqual([...CUSTOM_AGENT_TOOL_NAMES].sort());
    expect(edgeNames.sort()).toEqual([...CUSTOM_AGENT_TOOL_NAMES].sort());
    expect(new Set(frontendNames).size).toBe(frontendNames.length);
    expect(new Set(edgeNames).size).toBe(edgeNames.length);
    for (const name of toolNames) {
      expect(frontendNames).toContain(name);
      expect(edge).toMatch(new RegExp(`^- ${name} : `, "m"));
    }
  });

  it.each(toolNames)("minimizes sensitive parameters and results for registered %s", name => {
    const [tool] = resolveCustomAgentTools([name]);
    expect(tool).toBeDefined();
    const minimize = shouldMinimizeToolTrace(tool);
    const params = { query: marker, nested: { circuit_name: marker } };
    const result = { title: marker, body: marker, probabilities: [0.5, 0.5] };
    expect(summarizeToolParams(params, minimize)).not.toContain(marker);
    expect(summarizeToolResult(result, minimize)).not.toContain(marker);
    // Minimizing a trace must not rewrite the result delivered to an authorized caller.
    expect(params.query).toBe(marker);
    expect(result.title).toBe(marker);
  });

  it("executes a Bell circuit through the runtime registry with honest simulator provenance", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const [registered] = resolveCustomAgentTools(["quantum_simulate"]);
    expect(registered).toBeDefined();
    const result = await registered.execute({
      qubits: 2, gates: [{ gate: "H", target: 0 }, { gate: "CX", control: 0, target: 1 }], shots: 0,
    }, ctx);
    expect(() => assertToolResult(result)).not.toThrow();
    expect(result).toMatchObject({
      execution_kind: "local_simulator", backend_kind: "classical_statevector",
      physical_quantum_hardware: false, quantum_advantage_demonstrated: false,
      external_api_calls: 0, probabilities: [0.5, 0, 0, 0.5], counts: {}, karta_execution_mode: "live",
    });
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["partial", "failed"] as const)("cannot count a %s research result as completed tool success", async expectedStatus => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async url => {
      if (String(url).startsWith("https://api.crossref.org/") && expectedStatus === "partial") {
        return Response.json({ status: "ok", message: { items: [
          { DOI: "10.1234/example", title: ["Public result"], published: { "date-parts": [[2026]] } },
        ] } });
      }
      return new Response("Unavailable provider content", { status: 503 });
    });
    const result = await createKnowledgeSearchTool({ fetch: transport }).execute({
      query: "public test query", sources: ["crossref", "wikidata"], limit: 1,
    }, ctx);
    expect(result.status).toBe(expectedStatus);
    expect(result.ok).toBe(false);
    expect(() => assertToolResult(result)).toThrow();
    if (expectedStatus === "partial") expect(result.results).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("keeps both registered tools unexecuted in a KARTA simulation and hides private decision content", async () => {
    h.simulation = true;
    h.decision = {
      summary: marker, requiresApproval: false, mock: false,
      toolCalls: [
        { tool: "knowledge_search", params: { query: marker, sources: ["crossref"] } },
        { tool: "quantum_simulate", params: { qubits: 1, gates: [{ gate: "H", target: 0 }] } },
      ],
    };
    const search = vi.spyOn(knowledgeSearchTool, "execute");
    const quantum = vi.spyOn(quantumSimulateTool, "execute");
    const network = vi.spyOn(globalThis, "fetch");
    const definition: AgentDefinition = {
      type: "legal", systemPrompt: "Test the existing simulation boundary",
      buildContext: async () => ({}), tools: resolveCustomAgentTools(toolNames),
    };
    const result = await runAgentCycle(ctx.userId, definition, { type: "manual", source: "integration-test" });
    expect(result.status).toBe("simulated");
    expect(result.toolsUsed.map(tool => tool.outcome)).toEqual(["simulated", "simulated"]);
    expect(result.toolsUsed.every(tool => tool.success === false)).toBe(true);
    expect(search).not.toHaveBeenCalled();
    expect(quantum).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(h.finish.mock.calls)).not.toContain(marker);
  });
});
