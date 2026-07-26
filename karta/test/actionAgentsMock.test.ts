import { describe, expect, it } from "vitest";
import { createMockClaudeClient } from "../src/claude/mock.js";
import type { ToolDefinition } from "../src/engine/types.js";

function tool(name: string): ToolDefinition {
  return { name, description: "test", sensitive: false, execute: async () => ({}) };
}

describe("fallback générique (agents action, cf actionAgents.ts)", () => {
  const client = createMockClaudeClient();

  it("no-op si items vide, quel que soit l'agent", async () => {
    const decision = await client.decide({
      systemPrompt: "",
      agentType: "facture-pro",
      context: { items: [] },
      tools: [tool("generate_pdf")],
    });
    expect(decision.toolCalls).toHaveLength(0);
  });

  it("choisit le seul outil d'action disponible pour cet agent (facture-pro -> generate_pdf)", async () => {
    const decision = await client.decide({
      systemPrompt: "",
      agentType: "facture-pro",
      context: { items: [{ id: "inv-1" }] },
      tools: [tool("supabase_select"), tool("generate_pdf"), tool("send_notification")],
    });
    expect(decision.toolCalls[0].tool).toBe("generate_pdf");
    expect(decision.requiresApproval).toBe(true);
  });

  it("choisit calendar_create_event pour un agent de planification", async () => {
    const decision = await client.decide({
      systemPrompt: "",
      agentType: "planificateur-d-appels",
      context: { items: [{ brief: "appeler client X demain 14h" }] },
      tools: [tool("calendar_create_event"), tool("send_notification")],
    });
    expect(decision.toolCalls[0].tool).toBe("calendar_create_event");
  });

  it("repondeur-intelligent réutilise exactement le canevas mock de l'agent email", async () => {
    const emailDecision = await client.decide({
      systemPrompt: "",
      agentType: "email",
      context: { newEmails: [{ subject: "Q", from: "a@b.com", threadId: "t1" }] },
      tools: [tool("gmail_create_draft")],
    });
    const repondeurDecision = await client.decide({
      systemPrompt: "",
      agentType: "repondeur-intelligent",
      context: { newEmails: [{ subject: "Q", from: "a@b.com", threadId: "t1" }] },
      tools: [tool("gmail_create_draft")],
    });
    expect(repondeurDecision.toolCalls).toEqual(emailDecision.toolCalls);
  });
});
