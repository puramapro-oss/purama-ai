export type ToolJsonSchema =
  | {
      type: "object";
      properties: Record<string, ToolJsonSchema>;
      required?: string[];
      additionalProperties?: boolean;
    }
  | {
      type: "string";
      minLength?: number;
      maxLength?: number;
      enum?: string[];
      format?: "email" | "date-time" | "uuid";
    }
  | {
      type: "number" | "integer";
      minimum?: number;
      maximum?: number;
    }
  | {
      type: "boolean";
    }
  | {
      type: "array";
      items: ToolJsonSchema;
      minItems?: number;
      maxItems?: number;
    };

export function validateToolParams(schema: ToolJsonSchema, input: unknown, path = "params"): void {
  if (schema.type === "object") {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${path}: objet attendu`);
    const value = input as Record<string, unknown>;
    const required = new Set(schema.required ?? []);
    for (const key of required) if (!(key in value)) throw new Error(`${path}.${key}: champ requis`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in schema.properties)) throw new Error(`${path}.${key}: champ inconnu`);
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (value[key] !== undefined) validateToolParams(child, value[key], `${path}.${key}`);
    }
    return;
  }

  if (schema.type === "string") {
    if (typeof input !== "string") throw new Error(`${path}: chaîne attendue`);
    if (schema.minLength !== undefined && input.length < schema.minLength) throw new Error(`${path}: trop court`);
    if (schema.maxLength !== undefined && input.length > schema.maxLength) throw new Error(`${path}: trop long`);
    if (schema.enum && !schema.enum.includes(input)) throw new Error(`${path}: valeur interdite`);
    if (/[\u0000]/.test(input)) throw new Error(`${path}: caractère interdit`);
    if (schema.format === "email" && !/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(input)) {
      throw new Error(`${path}: email invalide`);
    }
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(input))) throw new Error(`${path}: date invalide`);
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
      throw new Error(`${path}: UUID invalide`);
    }
    return;
  }

  if (schema.type === "number" || schema.type === "integer") {
    if (typeof input !== "number" || !Number.isFinite(input) || (schema.type === "integer" && !Number.isSafeInteger(input))) {
      throw new Error(`${path}: nombre invalide`);
    }
    if (schema.minimum !== undefined && input < schema.minimum) throw new Error(`${path}: trop petit`);
    if (schema.maximum !== undefined && input > schema.maximum) throw new Error(`${path}: trop grand`);
    return;
  }

  if (schema.type === "boolean") {
    if (typeof input !== "boolean") throw new Error(`${path}: booléen attendu`);
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(input)) throw new Error(`${path}: tableau attendu`);
    if (schema.minItems !== undefined && input.length < schema.minItems) throw new Error(`${path}: tableau trop court`);
    if (schema.maxItems !== undefined && input.length > schema.maxItems) throw new Error(`${path}: tableau trop long`);
    input.forEach((item, index) => validateToolParams(schema.items, item, `${path}[${index}]`));
  }
}
