import { describe, expect, it } from "vitest";
import { selectModel } from "../src/claude/real.js";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import { config } from "../src/config.js";

function request(overrides: Partial<ClaudeDecideInput> = {}): ClaudeDecideInput {
  return {
    agentType: "newsletter-genie",
    systemPrompt: "Résume les données disponibles.",
    context: { items: [] },
    tools: [],
    ...overrides,
  };
}

describe("model routing preserves the primary model for consequential decisions", () => {
  it.each(["legal", "compta", "facture-pro", "rapports-financiers", "chasseur-de-paiements"])(
    "does not infer that a short %s request requires less quality", agentType => {
      expect(selectModel(request({ agentType }))).toBe(config.anthropicModelMain);
    },
  );

  it("keeps the primary model for an unqualified custom agent with a short prompt", () => {
    expect(selectModel(request({ agentType: "custom:unqualified-agent" }))).toBe(config.anthropicModelMain);
  });

  it("keeps the primary model when even one available action is sensitive", () => {
    expect(selectModel(request({ tools: [{
      name: "send", description: "Action sensible", sensitive: true,
      execute: async () => ({ ok: true }),
    }] }))).toBe(config.anthropicModelMain);
  });

  it("keeps the existing fast route for short non-sensitive requests", () => {
    expect(selectModel(request())).toBe(config.anthropicModelFast);
  });

  it("does not alter a large-context primary route", () => {
    expect(selectModel(request({ context: { document: "x".repeat(2500) } })))
      .toBe(config.anthropicModelMain);
  });
});
