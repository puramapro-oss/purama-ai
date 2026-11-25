import type { AnyToolDefinition, ToolInputSchema } from "./types.js";
import { isProxy } from "node:util/types";

const EMPTY_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export function schemaForTool(tool: AnyToolDefinition): ToolInputSchema {
  return tool.inputSchema ?? EMPTY_SCHEMA;
}

export function validateToolParams(tool: AnyToolDefinition, params: unknown): asserts params is Record<string, unknown> {
  const schema = schemaForTool(tool);
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`Paramètres invalides pour ${tool.name}: objet attendu`);
  }

  const value = params as Record<string, unknown>;
  const required = new Set(schema.required ?? []);
  for (const key of required) {
    if (!Object.hasOwn(value, key) || value[key] === undefined || value[key] === null) {
      throw new Error(`Paramètre requis manquant pour ${tool.name}: ${key}`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) {
        throw new Error(`Paramètre inconnu pour ${tool.name}: ${key}`);
      }
    }
  }

  for (const [key, raw] of Object.entries(value)) {
    const rule = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
    if (!rule || raw === undefined || raw === null) continue;

    const expected = rule.type;
    if (expected === "string") {
      if (typeof raw !== "string") throw new Error(`Paramètre ${key}: chaîne attendue`);
      if (typeof rule.minLength === "number" && raw.length < rule.minLength) throw new Error(`Paramètre ${key}: trop court`);
      if (typeof rule.maxLength === "number" && raw.length > rule.maxLength) throw new Error(`Paramètre ${key}: trop long`);
      if (Array.isArray(rule.enum) && !rule.enum.includes(raw)) throw new Error(`Paramètre ${key}: valeur interdite`);
      continue;
    }
    if (expected === "integer") {
      if (!Number.isInteger(raw)) throw new Error(`Paramètre ${key}: entier attendu`);
      if (typeof rule.minimum === "number" && (raw as number) < rule.minimum) throw new Error(`Paramètre ${key}: trop petit`);
      if (typeof rule.maximum === "number" && (raw as number) > rule.maximum) throw new Error(`Paramètre ${key}: trop grand`);
      continue;
    }
    if (expected === "number") {
      if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error(`Paramètre ${key}: nombre attendu`);
      continue;
    }
    if (expected === "boolean") {
      if (typeof raw !== "boolean") throw new Error(`Paramètre ${key}: booléen attendu`);
      continue;
    }
    if (expected === "object") {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Paramètre ${key}: objet attendu`);
      continue;
    }
    if (expected === "array") {
      if (!Array.isArray(raw)) throw new Error(`Paramètre ${key}: tableau attendu`);
      const items = rule.items as Record<string, unknown> | undefined;
      if (items?.type === "string" && raw.some(item => typeof item !== "string")) {
        throw new Error(`Paramètre ${key}: tableau de chaînes attendu`);
      }
      continue;
    }
    throw new Error(`Schéma non supporté pour ${tool.name}.${key}`);
  }
}

/** PTC cannot use provider strict mode. Qualify the small JSON Schema subset
 * used by audited readers locally, including nested constraints. The legacy
 * direct validator above retains its established optional-null behavior.
 * Unknown schema keywords fail closed instead of silently losing validation. */
export function validateProgrammaticToolParams(tool: AnyToolDefinition, params: unknown): asserts params is Record<string, unknown> {
  const fail = (): never => { throw new Error("Paramètres programmatiques non conformes"); };
  const plain = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    return Reflect.ownKeys(value).every(key => typeof key === "string"
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
  };
  let nodes = 0;
  const seen = new Set<object>();
  const data = (value: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 12) return fail();
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (value.length > 65_536) return fail();
      return;
    }
    if (typeof value === "number") { if (!Number.isFinite(value)) return fail(); return; }
    if (!value || typeof value !== "object" || isProxy(value) || seen.has(value)) return fail();
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1024
          || Reflect.ownKeys(value).length !== value.length + 1) return fail();
        for (let index = 0; index < value.length; index++) {
          const property = Object.getOwnPropertyDescriptor(value, String(index));
          if (!property?.enumerable || !Object.hasOwn(property, "value")) return fail();
          data(property.value, depth + 1);
        }
      } else {
        if (!plain(value) || Object.keys(value).length > 1024) return fail();
        for (const [key, item] of Object.entries(value)) {
          if (key.length > 1024) return fail();
          data(item, depth + 1);
        }
      }
    } finally { seen.delete(value); }
  };
  if (!plain(params)) return fail();
  data(params, 0);
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > 65_536) return fail();

  const validate = (schema: unknown, value: unknown, depth: number): void => {
    if (depth > 12 || !plain(schema)) return fail();
    const common = ["type", "description", "title", "default", "examples", "enum"];
    const specific: Record<string, string[]> = {
      object: ["properties", "required", "additionalProperties"],
      array: ["items", "minItems", "maxItems", "uniqueItems"],
      string: ["minLength", "maxLength"],
      integer: ["minimum", "maximum"], number: ["minimum", "maximum"], boolean: [], null: [],
    };
    if (typeof schema.type !== "string" || !Object.hasOwn(specific, schema.type)
      || Object.keys(schema).some(key => !common.includes(key) && !specific[schema.type as string].includes(key))) return fail();
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0
      || schema.enum.some(item => item !== null && !["string", "number", "boolean"].includes(typeof item))
      || !schema.enum.some(item => Object.is(item, value)))) return fail();
    const bound = (name: string, actual: number, minimum: boolean): void => {
      if (!Object.hasOwn(schema, name)) return;
      const limit = schema[name];
      if (typeof limit !== "number" || !Number.isFinite(limit)
        || (minimum ? actual < limit : actual > limit)) return fail();
    };
    switch (schema.type) {
      case "object": {
        if (!plain(value) || !plain(schema.properties)
          || (schema.additionalProperties !== false && schema.additionalProperties !== true)) return fail();
        const required = schema.required ?? [];
        if (!Array.isArray(required) || required.some(key => typeof key !== "string"
          || !Object.hasOwn(schema.properties as object, key) || !Object.hasOwn(value, key))) return fail();
        for (const [key, item] of Object.entries(value)) {
          if (Object.hasOwn(schema.properties, key)) validate(schema.properties[key], item, depth + 1);
          else if (!schema.additionalProperties) return fail();
        }
        return;
      }
      case "array":
        if (!Array.isArray(value) || !plain(schema.items)) return fail();
        bound("minItems", value.length, true); bound("maxItems", value.length, false);
        if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") return fail();
        if (schema.uniqueItems === true) {
          const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
            : item !== null && typeof item === "object"
              ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])]))
              : item;
          if (new Set(value.map(item => JSON.stringify(canonical(item)))).size !== value.length) return fail();
        }
        for (const item of value) validate(schema.items, item, depth + 1);
        return;
      case "string":
        if (typeof value !== "string") return fail();
        bound("minLength", [...value].length, true); bound("maxLength", [...value].length, false);
        return;
      case "integer":
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)
          || (schema.type === "integer" && !Number.isSafeInteger(value))) return fail();
        bound("minimum", value, true); bound("maximum", value, false);
        return;
      case "boolean": if (typeof value !== "boolean") return fail(); return;
      case "null": if (value !== null) return fail(); return;
      default: return fail();
    }
  };
  validate(schemaForTool(tool), params, 0);
}
