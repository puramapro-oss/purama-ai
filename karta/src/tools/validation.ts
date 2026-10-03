import type { AnyToolDefinition, ToolDefinition, ToolExecutionContext, ToolInputSchema } from "../engine/types.js";

/** One definition supplies both the runtime parser and Claude's JSON schema. */
export interface InputSchema<T> {
  json: Record<string, unknown> | ToolInputSchema;
  parse: (value: unknown, path?: string) => T;
  optional?: boolean;
}

interface ObjectInputSchema<T> extends InputSchema<T> {
  json: ToolInputSchema;
}

export class ToolInputError extends Error {
  constructor(path: string, reason: string) {
    super(`Paramètres invalides (${path}): ${reason}`);
    this.name = "ToolInputError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHour, offsetMinute] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1]
    && Number(hourText) < 24 && Number(minuteText) < 60 && Number(secondText) < 60
    && (offsetHour === undefined || (Number(offsetHour) < 24 && Number(offsetMinute) < 60))
    && Number.isFinite(Date.parse(value));
}

export function stringSchema(options: {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "email" | "date-time";
} = {}): InputSchema<string> {
  const { minLength = 1, maxLength = 100_000, pattern, format } = options;
  const expression = pattern === undefined ? undefined : new RegExp(pattern);
  return {
    json: { type: "string", minLength, maxLength, ...(pattern ? { pattern } : {}), ...(format ? { format } : {}) },
    parse(value, path = "input") {
      if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
        throw new ToolInputError(path, `chaîne attendue, longueur ${minLength}–${maxLength}`);
      }
      if (expression && !expression.test(value)) throw new ToolInputError(path, "format de texte non autorisé");
      if (format === "email" && !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)) {
        throw new ToolInputError(path, "adresse email simple attendue");
      }
      if (format === "date-time" && !validDateTime(value)) {
        throw new ToolInputError(path, "date RFC 3339 réelle avec fuseau horaire attendue");
      }
      return value;
    },
  };
}

export function integerSchema(minimum: number, maximum: number): InputSchema<number> {
  return {
    json: { type: "integer", minimum, maximum },
    parse(value, path = "input") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new ToolInputError(path, `entier entre ${minimum} et ${maximum} attendu`);
      }
      return value;
    },
  };
}

export function enumSchema<const T extends readonly string[]>(values: T): InputSchema<T[number]> {
  return {
    json: { type: "string", enum: [...values] },
    parse(value, path = "input") {
      if (typeof value !== "string" || !values.includes(value)) {
        throw new ToolInputError(path, "valeur non autorisée (liste blanche)");
      }
      return value;
    },
  };
}

export function optionalSchema<T>(schema: InputSchema<T>): InputSchema<T | undefined> {
  return { json: schema.json, optional: true, parse: (value, path) => value === undefined ? undefined : schema.parse(value, path) };
}

export function arraySchema<T>(schema: InputSchema<T>, maxItems: number): InputSchema<T[]> {
  return {
    json: { type: "array", items: schema.json, maxItems },
    parse(value, path = "input") {
      if (!Array.isArray(value) || value.length > maxItems) throw new ToolInputError(path, `tableau de ${maxItems} éléments maximum attendu`);
      return value.map((item, index) => schema.parse(item, `${path}[${index}]`));
    },
  };
}

type Shape = Record<string, InputSchema<unknown>>;
type Parsed<S extends Shape> = { [K in keyof S]: S[K] extends InputSchema<infer T> ? T : never };

export function objectSchema<S extends Shape>(shape: S, check?: (parsed: Parsed<S>) => void): ObjectInputSchema<Parsed<S>> {
  const properties = Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, schema.json]));
  const required = Object.entries(shape).filter(([, schema]) => !schema.optional).map(([key]) => key);
  return {
    json: { type: "object", properties, required, additionalProperties: false },
    parse(value, path = "input") {
      if (!isObject(value)) throw new ToolInputError(path, "objet JSON attendu");
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(shape, key)) throw new ToolInputError(`${path}.${key}`, "champ inconnu");
      }
      const parsed: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(shape)) {
        const item = schema.parse(Object.hasOwn(value, key) ? value[key] : undefined, `${path}.${key}`);
        if (item !== undefined) parsed[key] = item;
      }
      // All shape members were parsed above; the assertion only reconstructs their mapped type.
      const result = parsed as Parsed<S>;
      check?.(result);
      return result;
    },
  };
}

/** Bounded JSON payloads for business rows; this is not a database authorization policy. */
export function jsonRecordSchema(scalarOnly = false): InputSchema<Record<string, unknown>> {
  return {
    json: {
      type: "object", maxProperties: 100, propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      additionalProperties: scalarOnly ? { type: ["string", "number", "boolean"] } : true,
    },
    parse(value, path = "input") {
      if (!isObject(value) || Object.keys(value).length > 100) throw new ToolInputError(path, "objet JSON de 100 champs maximum attendu");
      let nodes = 0;
      let textLength = 0;
      const visit = (item: unknown, itemPath: string, depth: number): unknown => {
        if (++nodes > 10_000 || depth > 10) throw new ToolInputError(itemPath, "structure JSON trop volumineuse ou profonde");
        if (typeof item === "string") {
          textLength += item.length;
          if (textLength > 100_000) throw new ToolInputError(itemPath, "texte JSON trop volumineux");
          return item;
        }
        if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return item;
        if (scalarOnly) throw new ToolInputError(itemPath, "filtre texte, nombre fini ou booléen attendu");
        if (item === null) return null;
        if (Array.isArray(item)) return item.map((entry, index) => visit(entry, `${itemPath}[${index}]`, depth + 1));
        if (isObject(item)) {
          const result: Record<string, unknown> = {};
          const keys = Object.keys(item);
          if (keys.length > 100) throw new ToolInputError(itemPath, "trop de champs JSON");
          for (const key of keys) {
            if (key === "__proto__" || key === "constructor" || key === "prototype") throw new ToolInputError(itemPath, "clé JSON non autorisée");
            result[key] = visit(item[key], `${itemPath}.${key}`, depth + 1);
          }
          return result;
        }
        throw new ToolInputError(itemPath, "valeur JSON attendue");
      };
      const parsed: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) {
          throw new ToolInputError(path, "nom de champ non autorisé");
        }
        parsed[key] = visit(item, `${path}.${key}`, 1);
      }
      return parsed;
    },
  };
}

export function defineTool<Params, Result>(definition: {
  name: string;
  description: string;
  sensitive: boolean;
  input: ObjectInputSchema<Params>;
  execute: (params: Params, ctx: ToolExecutionContext) => Promise<Result>;
}): ToolDefinition<Params, Result> {
  return {
    name: definition.name,
    description: definition.description,
    sensitive: definition.sensitive,
    inputSchema: definition.input.json,
    parseInput: (input) => definition.input.parse(input),
    execute: async (input, ctx) => definition.execute(definition.input.parse(input), ctx),
  };
}

export function validateToolInput(tool: AnyToolDefinition, input: unknown): unknown {
  if (typeof tool.parseInput !== "function" || tool.inputSchema?.type !== "object" || tool.inputSchema.additionalProperties !== false) {
    throw new ToolInputError(tool.name, "outil sans contrat de validation explicite");
  }
  return tool.parseInput(input);
}
