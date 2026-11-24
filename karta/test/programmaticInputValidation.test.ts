import { describe, expect, it, vi } from "vitest";
import { validateProgrammaticToolParams, validateToolParams } from "../src/engine/tool-input.js";
import type { AnyToolDefinition } from "../src/engine/types.js";
import { knowledgeSearchTool } from "../src/tools/knowledge-search.js";
import { webSearchTool } from "../src/tools/websearch.js";

const reader: AnyToolDefinition = {
  name: "fixture_read", description: "fixture", sensitive: false, programmaticRead: true,
  inputSchema: { type: "object", properties: {
    query: { type: "string", minLength: 1, maxLength: 5 },
    sources: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1, maxItems: 2 },
    options: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 5 } },
      required: ["limit"], additionalProperties: false },
  }, required: ["query"], additionalProperties: false },
  execute: async () => { throw new Error("Validation must not execute a reader"); },
};

describe("programmatic preflight without provider strict mode", () => {
  it("validates the real public reader schemas without invoking their transports", () => {
    expect(() => validateProgrammaticToolParams(knowledgeSearchTool, { query: "énergie", sources: ["crossref", "wikidata"], limit: 5 })).not.toThrow();
    expect(() => validateProgrammaticToolParams(webSearchTool, { query: "documentation", include_domains: ["example.com"], response_format: "evidence" })).not.toThrow();
  });

  it.each([
    {}, { query: null }, { query: "" }, { query: "abcdef" }, { query: 3 }, { query: "a", extra: true },
    { query: "a", sources: [] }, { query: "a", sources: ["a", "b", "a"] },
    { query: "a", sources: ["unknown"] }, { query: "a", sources: [1] },
    { query: "a", options: {} }, { query: "a", options: { limit: 0 } },
    { query: "a", options: { limit: 6 } }, { query: "a", options: { limit: 1.5 } },
    { query: "a", options: { limit: "2" } }, { query: "a", options: { limit: 2, userId: "foreign" } },
    { query: "a", options: null }, { query: "a", sources: null },
    JSON.parse('{"query":"a","__proto__":null}'), JSON.parse('{"query":"a","constructor":null}'),
  ])("rejects invalid complete packets without echoing arguments: %j", value => {
    expect(() => validateProgrammaticToolParams(reader, value)).toThrow("Paramètres programmatiques non conformes");
  });

  it("preserves historical direct optional-null behavior while PTC rejects it", () => {
    const value = { query: "a", sources: null };
    expect(() => validateToolParams(reader, value)).not.toThrow();
    expect(() => validateProgrammaticToolParams(reader, value)).toThrow();
  });

  it("counts Unicode characters consistently for the qualified schema", () => {
    expect(() => validateProgrammaticToolParams(reader, { query: "😀😀😀😀😀" })).not.toThrow();
    expect(() => validateProgrammaticToolParams(reader, { query: "😀😀😀😀😀😀" })).toThrow();
  });

  it("does not read accessor or inherited arguments", () => {
    const get = vi.fn(() => "PRIVATE");
    const value = Object.defineProperty({}, "query", { enumerable: true, get });
    expect(() => validateProgrammaticToolParams(reader, value)).toThrow();
    expect(() => validateProgrammaticToolParams(reader, Object.create({ query: "a" }))).toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects proxy, sparse, custom and accessor arrays before iterating them", () => {
    const get = vi.fn();
    const accessor = Object.defineProperty([], "0", { enumerable: true, get });
    for (const sources of [new Array(1), accessor, new Proxy(["a"], { get }), Object.assign(["a"], { extra: "private" })]) {
      expect(() => validateProgrammaticToolParams(reader, { query: "a", sources })).toThrow();
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects unsupported schema constraints instead of pretending to enforce them", () => {
    const incompatible = { ...reader, inputSchema: { ...reader.inputSchema!, properties: { query: { type: "string", pattern: "^allowed$" } } } };
    expect(() => validateProgrammaticToolParams(incompatible, { query: "a" })).toThrow();
  });

  it("detects structurally duplicate array items regardless of object key order", () => {
    const structured: AnyToolDefinition = { ...reader, inputSchema: { type: "object", properties: {
      items: { type: "array", uniqueItems: true, items: { type: "object", properties: {
        a: { type: "integer" }, b: { type: "integer" },
      }, required: ["a", "b"], additionalProperties: false } },
    }, required: ["items"], additionalProperties: false } };
    expect(() => validateProgrammaticToolParams(structured, { items: [{ a: 1, b: 2 }, { b: 2, a: 1 }] })).toThrow();
    expect(() => validateProgrammaticToolParams(structured, { items: [{ a: 1, b: 2 }, { b: 3, a: 1 }] })).not.toThrow();
  });

  it("rejects cycles, non-JSON values and excessive input without invoking toJSON", () => {
    const toJSON = vi.fn(() => "a");
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of [{ query: "a", options: cycle }, { query: "a", options: { toJSON } },
      { query: "a", options: { limit: Infinity } }, { query: "a", options: { limit: 1n } },
      { query: "x".repeat(65_537) }]) {
      expect(() => validateProgrammaticToolParams(reader, value)).toThrow();
    }
    expect(toJSON).not.toHaveBeenCalled();
  });
});
