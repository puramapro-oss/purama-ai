import { describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ from: vi.fn(), schema: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: database }));

const { AGENT_REGISTRY } = await import("../src/agents/index.js");
const { resolveCustomAgentTools } = await import("../src/tools/customRegistry.js");
const { buildSocialBriefContext } = await import("../src/agents/social-status-context.js");

describe("social status capability registration", () => {
  it("prepares social context only for the existing advertising agent", () => {
    const owners = Object.values(AGENT_REGISTRY)
      .filter(agent => agent.buildContext === buildSocialBriefContext)
      .map(agent => agent.type);
    expect(owners).toEqual(["maitre-des-publicites"]);
    // This engine makes one decision. A post-decision read would lose its
    // result instead of informing a later decision or private delivery.
    expect(Object.values(AGENT_REGISTRY).some(agent => agent.tools.some(tool => tool.name === "social_status"))).toBe(false);
    expect(Object.keys(AGENT_REGISTRY)).toHaveLength(16);
    expect(resolveCustomAgentTools(["social_status"])).toEqual([]);
  });

  it("preserves the brief-only simulation path without querying social data", async () => {
    const agent = AGENT_REGISTRY["maitre-des-publicites"];
    expect(agent.pendingBriefKey).toBe("pending_brief");
    const result = await agent.buildContext("11111111-1111-4111-8111-111111111111",
      { type: "manual", source: "social-context-fixture" },
      { pendingBrief: "Synthetic advertising brief", executionMode: "simulation" });
    expect(result).toEqual({ items: [{ brief: "Synthetic advertising brief" }] });
    expect(database.from).not.toHaveBeenCalled();
    expect(database.schema).not.toHaveBeenCalled();
  });
});
