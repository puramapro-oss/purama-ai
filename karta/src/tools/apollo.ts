import { config } from "../config.js";
import { validateToolParams } from "../engine/tool-input.js";
import { assertToolResult } from "../engine/tool-result.js";
import type { ToolDefinition } from "../engine/types.js";
import { createProviderDeadline, requestProviderJson } from "./provider-http.js";

const SEARCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const SEARCH_FAILURE = "Recherche Apollo indisponible ou réponse invalide";
type SearchParams = { keywords: string; limit?: number };
type Person = { name: string; email: string | null; organization: string | null };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate a plain data snapshot before the shared schema validator reads it. */
function searchParams(value: unknown): { keywords: string; limit: number } {
  try {
    if (!record(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new Error("Invalid parameter object");
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !Object.hasOwn(apolloSearchPeopleTool.inputSchema!.properties, key)) {
        throw new Error("Invalid parameter key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("Invalid parameter descriptor");
      snapshot[key] = descriptor.value;
    }
    validateToolParams(apolloSearchPeopleTool, snapshot);
    const input = snapshot as SearchParams;
    if (!input.keywords.trim() || snapshot.limit === null) throw new Error("Invalid search parameters");
    return { keywords: input.keywords, limit: input.limit ?? 10 };
  } catch {
    throw new Error("Paramètres de recherche Apollo invalides");
  }
}

function optionalText(value: unknown, maximumLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maximumLength) throw new Error(SEARCH_FAILURE);
  return value;
}

function searchPeople(value: unknown, limit: number): Person[] {
  if (!record(value) || !Array.isArray(value.people)) throw new Error(SEARCH_FAILURE);
  assertToolResult(value);
  return value.people.slice(0, limit).map((person: unknown) => {
    if (!record(person) || typeof person.name !== "string" || !person.name.trim() || person.name.length > 500) {
      throw new Error(SEARCH_FAILURE);
    }
    return {
      name: person.name,
      email: optionalText(person.email, 320),
      organization: optionalText(person.organization_name, 500),
    };
  });
}

/** Prospection Apollo.io — utilisé par l'agent Partenariat pour trouver des prospects réels. */
export const apolloSearchPeopleTool: ToolDefinition<
  SearchParams,
  { people: Person[] }
> = {
  name: "apollo_search_people",
  description: "Recherche des prospects via Apollo.io par mots-clés (niche, secteur).",
  sensitive: false,
  inputSchema: {
    type: "object",
    properties: {
      keywords: { type: "string", minLength: 1, maxLength: 500 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["keywords"],
    additionalProperties: false,
  },
  async execute(params) {
    const input = searchParams(params);
    if (!config.apolloApiKey) throw new Error("APOLLO_API_KEY non configurée côté KARTA");

    const deadline = createProviderDeadline(SEARCH_TIMEOUT_MS, SEARCH_FAILURE);
    try {
      const data = await requestProviderJson("https://api.apollo.io/api/v1/mixed_people/search", {
        method: "POST",
        headers: { "X-Api-Key": config.apolloApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q_keywords: input.keywords, per_page: input.limit }),
      }, deadline, MAX_RESPONSE_BYTES);
      const people = searchPeople(data, input.limit);
      deadline.check();
      return { people };
    } catch {
      throw new Error(SEARCH_FAILURE);
    } finally {
      deadline.close();
    }
  },
};
