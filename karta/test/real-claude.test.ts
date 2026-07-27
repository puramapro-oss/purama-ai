import { describe, expect, it } from "vitest";
import { selectModel } from "../src/claude/real.js";
import { config } from "../src/config.js";
import type { ClaudeDecideInput } from "../src/claude/types.js";

function makeInput(overrides: Partial<ClaudeDecideInput> = {}): ClaudeDecideInput {
  return {
    systemPrompt: "Tu es un agent.",
    context: { items: [] },
    tools: [],
    agentType: "test",
    ...overrides,
  };
}

describe("selectModel — routage Haiku/Sonnet selon complexité", () => {
  it("choisit Haiku pour un cycle simple (peu d'outils, petit contexte)", () => {
    expect(selectModel(makeInput())).toBe(config.anthropicModelFast);
  });

  it("choisit Sonnet dès que le nombre d'outils dépasse le seuil", () => {
    const tools = Array.from({ length: 3 }, (_, i) => ({ name: `tool-${i}` })) as ClaudeDecideInput["tools"];
    expect(selectModel(makeInput({ tools }))).toBe(config.anthropicModelMain);
  });

  it("choisit Sonnet dès que le contexte est volumineux", () => {
    const context = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, note: "x".repeat(20) })) };
    expect(selectModel(makeInput({ context }))).toBe(config.anthropicModelMain);
  });

  it("choisit Sonnet dès que le system prompt est long", () => {
    expect(selectModel(makeInput({ systemPrompt: "x".repeat(2000) }))).toBe(config.anthropicModelMain);
  });
});
