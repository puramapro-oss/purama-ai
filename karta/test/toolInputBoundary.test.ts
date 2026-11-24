import { describe, expect, it } from "vitest";
import { validateToolParams } from "../src/engine/tool-input.js";
import type { AnyToolDefinition, ToolInputSchema } from "../src/engine/types.js";

const reservedNames = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];
const makeTool = (properties: ToolInputSchema["properties"], required: string[] = []): AnyToolDefinition => ({
  name: "boundary_fixture",
  description: "Fixture de validation des paramètres, sans effet externe",
  sensitive: false,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  execute: async () => ({ ok: true }),
});

describe("tool parameter own-property boundary", () => {
  it.each(reservedNames.flatMap(key => [
    { key, kind: "null", value: null },
    { key, kind: "undefined", value: undefined },
    { key, kind: "string", value: "undeclared private value" },
  ]))("rejects undeclared $key with a $kind value", ({ key, value }) => {
    const tool = makeTool({ query: { type: "string" } }, ["query"]);
    // fromEntries creates a direct data property even for __proto__.
    const params = Object.fromEntries([["query", "valid"], [key, value]]);
    expect(Object.hasOwn(params, key)).toBe(true);
    expect(() => validateToolParams(tool, params)).toThrow();
  });

  it("rejects reserved unknown fields received through JSON", () => {
    const tool = makeTool({ query: { type: "string" } }, ["query"]);
    const params = JSON.parse('{"query":"valid","__proto__":null,"constructor":null}');
    expect(() => validateToolParams(tool, params)).toThrow();
  });

  it("does not accept an inherited property as a required argument", () => {
    const tool = makeTool({ query: { type: "string" } }, ["query"]);
    const params = Object.create({ query: "inherited private value" });
    expect(Object.hasOwn(params, "query")).toBe(false);
    expect(() => validateToolParams(tool, params)).toThrow();
  });

  it.each(["constructor", "__proto__", "toString"])(
    "requires a direct value for explicitly declared %s", key => {
      const tool = makeTool(Object.fromEntries([[key, { type: "string" }]]), [key]);
      expect(() => validateToolParams(tool, {})).toThrow();
    },
  );

  it.each([
    { kind: "string", value: "valid-looking value" },
    { kind: "null", value: null },
    { kind: "undefined", value: undefined },
  ])("does not authorize an inherited schema property for a $kind value", ({ value }) => {
    const properties = Object.create({ query: { type: "string" } });
    expect(Object.hasOwn(properties, "query")).toBe(false);
    expect(() => validateToolParams(makeTool(properties), { query: value })).toThrow();
  });

  it("accepts valid direct parameters and schema properties without prototypes", () => {
    const properties = Object.assign(Object.create(null), {
      query: { type: "string", minLength: 1 }, optional: { type: "string" },
    });
    const params = Object.assign(Object.create(null), { query: "valid", optional: null });
    expect(() => validateToolParams(makeTool(properties, ["query"]), params)).not.toThrow();
  });

  it.each(["constructor", "__proto__", "toString"])(
    "accepts an explicitly declared %s and still enforces its type", key => {
      const tool = makeTool(Object.fromEntries([[key, { type: "string", minLength: 1 }]]), [key]);
      expect(() => validateToolParams(tool, Object.fromEntries([[key, "valid"]]))).not.toThrow();
      expect(() => validateToolParams(tool, Object.fromEntries([[key, 42]]))).toThrow();
      expect(() => validateToolParams(tool, Object.fromEntries([[key, ""]]))).toThrow();
    },
  );

  it("preserves existing acceptance of null and undefined optional values", () => {
    const tool = makeTool({ query: { type: "string" }, optional: { type: "string" } }, ["query"]);
    expect(() => validateToolParams(tool, { query: "valid", optional: null })).not.toThrow();
    expect(() => validateToolParams(tool, { query: "valid", optional: undefined })).not.toThrow();
  });

  it.each(reservedNames)("allows no undeclared %s in the legacy empty schema", key => {
    const tool = makeTool({});
    delete tool.inputSchema;
    expect(() => validateToolParams(tool, Object.fromEntries([[key, null]]))).toThrow();
    expect(() => validateToolParams(tool, {})).not.toThrow();
  });
});
