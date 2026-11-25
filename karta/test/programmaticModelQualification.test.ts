import { describe, expect, it, vi } from "vitest";
import { normalizeModelCatalog, resolveModelExecutionPlan } from "../src/claude/execution-profile.js";
import { loadAnthropicModelCatalog } from "../src/claude/model-catalog.js";
import { useProgrammaticReads } from "../src/claude/programmatic.js";

const base = { model: "exact-model", reasoning: "budget" as const, maxOutputTokens: 16_384 };
const supported = { supported: true };

describe("exact model qualification for hosted programmatic reads", () => {
  it("preserves the same execution plan and budgets when adding a capability", () => {
    const preference = { model: "exact-model", reflection: "maximum" as const, speed: "standard" as const };
    expect(resolveModelExecutionPlan(preference, [{ ...base, programmaticToolCalling: true }]))
      .toEqual(resolveModelExecutionPlan(preference, [base]));
    expect(normalizeModelCatalog([{ ...base, programmaticToolCalling: true }])[0].programmaticToolCalling).toBe(true);
    expect(normalizeModelCatalog([base])[0]).not.toHaveProperty("programmaticToolCalling");
  });
  it.each([false, null, "true", 1, {}, undefined])("rejects ambiguous host qualification %j", value => {
    expect(() => normalizeModelCatalog([{ ...base, programmaticToolCalling: value }])).toThrow();
  });
  it.each(["value", "getter"])("never promotes an inherited capability declared as %s", kind => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "programmaticToolCalling");
    const getter = vi.fn(() => true);
    try {
      Object.defineProperty(Object.prototype, "programmaticToolCalling", {
        configurable: true, ...(kind === "value" ? { value: true } : { get: getter }),
      });
      const [normalized] = normalizeModelCatalog([base]);
      expect(Object.hasOwn(normalized, "programmaticToolCalling")).toBe(false);
      expect(useProgrammaticReads({ enabled: true, native: true, model: base.model, catalog: [normalized], input: {
        systemPrompt: "Public read", context: {}, agentType: "custom:fixture",
        tools: [{ name: "web_search", description: "Public reader", sensitive: false, programmaticRead: true, execute: async () => ({}) }],
        programmaticReads: { toolNames: ["web_search"], beforeRequest: async () => {}, execute: async () => "{}" },
      } })).toBe(false);
      expect(getter).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(Object.prototype, "programmaticToolCalling", original);
      else Reflect.deleteProperty(Object.prototype, "programmaticToolCalling");
    }
  });
  it.each(["capabilities", "code_execution", "server_tools", "hosted_code_execution", "supported"])("does not qualify native support through inherited %s", async inherited => {
    const property = inherited === "hosted_code_execution" ? "code_execution" : inherited;
    const original = Object.getOwnPropertyDescriptor(Object.prototype, property);
    const getter = vi.fn(() => inherited === "supported" ? true
      : inherited === "server_tools" ? { code_execution: supported }
        : inherited === "capabilities" ? caps : supported);
    const caps: Record<string, unknown> = {
      code_execution: inherited === "supported" ? {} : supported,
      server_tools: { code_execution: supported },
      thinking: { supported: true, types: { enabled: supported } },
    };
    if (inherited === "hosted_code_execution") caps.server_tools = {};
    else if (inherited !== "supported" && inherited !== "capabilities") delete caps[inherited];
    try {
      Object.defineProperty(Object.prototype, property, { configurable: true, get: getter });
      const models = await loadAnthropicModelCatalog({ apiKey: "fixture-key", allowed: [{ model: base.model, maxOutputTokens: base.maxOutputTokens }],
        fetch: async () => Response.json({ has_more: false, data: [{ id: base.model, lifecycle: "active", max_tokens: 32768,
          ...(inherited === "capabilities" ? {} : { capabilities: caps }) }] }),
      });
      if (inherited === "capabilities") expect(models).toEqual([]);
      else expect(Object.hasOwn(models[0], "programmaticToolCalling")).toBe(false);
      expect(getter).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(Object.prototype, property, original);
      else Reflect.deleteProperty(Object.prototype, property);
    }
  });
  it.each(["value", "getter"])("requires an own tool opt-in despite inherited %s", kind => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "programmaticRead");
    const getter = vi.fn(() => true);
    try {
      Object.defineProperty(Object.prototype, "programmaticRead", {
        configurable: true, ...(kind === "value" ? { value: true } : { get: getter }),
      });
      expect(useProgrammaticReads({ enabled: true, native: true, model: base.model,
        catalog: [{ ...base, programmaticToolCalling: true }], input: {
          systemPrompt: "Public read", context: {}, agentType: "custom:fixture",
          tools: [{ name: "web_search", description: "Not explicitly opted in", sensitive: false, execute: async () => ({}) }],
          programmaticReads: { toolNames: ["web_search"], beforeRequest: async () => {}, execute: async () => "{}" },
        } })).toBe(false);
      expect(getter).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(Object.prototype, "programmaticRead", original);
      else Reflect.deleteProperty(Object.prototype, "programmaticRead");
    }
  });
  it.each([
    { code_execution: supported, server_tools: { code_execution: supported }, expected: true },
    { code_execution: { supported: false }, server_tools: { code_execution: supported }, expected: false },
    { code_execution: undefined, server_tools: { code_execution: supported }, expected: false },
    { code_execution: supported, server_tools: {}, expected: false },
    { code_execution: { supported: "true" }, server_tools: { code_execution: supported }, expected: false },
  ])("distinguishes native PTC from ordinary server code support: %j", async ({ expected, ...caps }) => {
    const models = await loadAnthropicModelCatalog({ apiKey: "fixture-key", allowed: [{ model: base.model, maxOutputTokens: base.maxOutputTokens }],
      fetch: async () => Response.json({ has_more: false, data: [{ id: base.model, lifecycle: "active", max_tokens: 32_768,
        capabilities: { ...caps, thinking: { supported: true, types: { enabled: supported } } },
      }] }),
    });
    expect(models[0]).toEqual({ ...base, ...(expected ? { programmaticToolCalling: true } : {}) });
  });
});
