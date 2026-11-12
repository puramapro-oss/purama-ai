import type { ToolInputSchema } from "../engine/types.js";
import { listRobotTargets } from "./catalog.js";
import { SESSION_LIMITS } from "./session.js";

const identifier = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$", maxLength: 80 };
const targetId = { type: "string", enum: listRobotTargets().map((target) => target.id) };
const commonStep = {
  id: identifier,
  durationMs: { type: "integer", minimum: 1, maximum: 60_000, description: "Durée prévue uniquement, aucune attente réelle." },
  required: { type: "boolean", default: true },
};

export const robotCatalogInputSchema: ToolInputSchema = {
  type: "object", additionalProperties: false,
  properties: { targetId },
};

export const robotSessionInputSchema: ToolInputSchema = {
  type: "object", additionalProperties: false,
  required: ["version", "sessionId", "targetId", "expiresAt", "steps"],
  properties: {
    version: { type: "integer", const: 1 },
    sessionId: { ...identifier, description: "Identifiant unique de séance, identique pour un rejeu du même contenu." },
    targetId,
    expiresAt: {
      type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
      description: "Epoch UTC en millisecondes, strictement dans le futur et au plus cinq minutes après l'heure serveur. Utiliser par exemple serverTimeEpochMs + 60000, fourni dans le contexte de décision.",
    },
    steps: {
      type: "array", minItems: 1, maxItems: SESSION_LIMITS.steps,
      description: "Étapes ordonnées, identifiants uniques, durée totale au plus 300000 ms. La validation serveur reste obligatoire.",
      items: { oneOf: [
        {
          type: "object", additionalProperties: false, required: ["id", "kind", "text", "durationMs"],
          properties: { ...commonStep, kind: { const: "speech" }, text: { type: "string", minLength: 1, maxLength: SESSION_LIMITS.textCharacters, pattern: "\\S" } },
        },
        {
          type: "object", additionalProperties: false, required: ["id", "kind", "gesture", "durationMs"],
          properties: { ...commonStep, kind: { const: "gesture" }, gesture: { type: "string", enum: ["greeting", "attention"] } },
        },
        {
          type: "object", additionalProperties: false, required: ["id", "kind", "durationMs"],
          properties: { ...commonStep, kind: { const: "pause" } },
        },
      ] },
    },
  },
};

export const robotSimulationInputSchema: ToolInputSchema = {
  ...robotSessionInputSchema,
  properties: { ...robotSessionInputSchema.properties, targetId: { type: "string", const: "purama-simulator" } },
};
