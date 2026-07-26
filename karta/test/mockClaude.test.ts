import { describe, expect, it } from "vitest";
import { createMockClaudeClient } from "../src/claude/mock.js";
import type { ToolDefinition } from "../src/engine/types.js";

function tool(name: string): ToolDefinition {
  return { name, description: "test", sensitive: false, execute: async () => ({}) };
}

describe("createMockClaudeClient", () => {
  const client = createMockClaudeClient();

  it("isMock est toujours true", () => {
    expect(client.isMock).toBe(true);
  });

  it("email: no-op si aucun nouvel email", async () => {
    const decision = await client.decide({ systemPrompt: "", agentType: "email", context: { newEmails: [] }, tools: [] });
    expect(decision.toolCalls).toHaveLength(0);
    expect(decision.mock).toBe(true);
  });

  it("email: propose un brouillon si nouveaux emails et outil disponible", async () => {
    const decision = await client.decide({
      systemPrompt: "",
      agentType: "email",
      context: { newEmails: [{ subject: "Question", from: "a@b.com", threadId: "t1" }] },
      tools: [tool("gmail_create_draft")],
    });
    expect(decision.toolCalls).toHaveLength(1);
    expect(decision.toolCalls[0].tool).toBe("gmail_create_draft");
    expect(decision.requiresApproval).toBe(true);
  });

  it("compta: no-op si aucune déclaration en attente", async () => {
    const decision = await client.decide({ systemPrompt: "", agentType: "compta", context: { pendingDeclarations: [] }, tools: [] });
    expect(decision.toolCalls).toHaveLength(0);
  });

  it("legal: notifie si échéance imminente et outil disponible", async () => {
    const decision = await client.decide({
      systemPrompt: "",
      agentType: "legal",
      context: { upcomingDeadlines: [{ title: "doc", expires_at: "2026-08-01" }] },
      tools: [tool("send_notification")],
    });
    expect(decision.toolCalls[0].tool).toBe("send_notification");
  });

  it("partner: propose une prospection si nouveau prospect", async () => {
    const decision = await client.decide({
      systemPrompt: "",
      agentType: "partner",
      context: { newProspects: [{ id: "p1", name: "Prospect X" }] },
      tools: [tool("send_outreach_email")],
    });
    expect(decision.toolCalls[0].tool).toBe("send_outreach_email");
    expect(decision.requiresApproval).toBe(true);
  });

  it("agent inconnu: fallback générique no-op", async () => {
    const decision = await client.decide({ systemPrompt: "", agentType: "inconnu", context: {}, tools: [] });
    expect(decision.toolCalls).toHaveLength(0);
    expect(decision.summary).toContain("TODO_LIVE_TEST");
  });
});
