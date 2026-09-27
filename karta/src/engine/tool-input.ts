import type { AnyToolDefinition, ToolInputSchema } from "./types.js";

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
    if (!(key in value) || value[key] === undefined || value[key] === null) {
      throw new Error(`Paramètre requis manquant pour ${tool.name}: ${key}`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in schema.properties)) {
        throw new Error(`Paramètre inconnu pour ${tool.name}: ${key}`);
      }
    }
  }

  for (const [key, raw] of Object.entries(value)) {
    const rule = schema.properties[key];
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
