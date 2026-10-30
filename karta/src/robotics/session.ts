import { getRobotTarget } from "./catalog.js";

export const SESSION_LIMITS = Object.freeze({ steps: 24, textCharacters: 2_000, durationMs: 300_000 });
export type SessionStep =
  | { id: string; kind: "speech"; text: string; durationMs: number; required: boolean }
  | { id: string; kind: "gesture"; gesture: "greeting" | "attention"; durationMs: number; required: boolean }
  | { id: string; kind: "pause"; durationMs: number; required: boolean };

export interface SessionRequest {
  version: 1;
  sessionId: string;
  targetId: string;
  expiresAt: number;
  steps: SessionStep[];
}

export interface SessionPlan {
  ok: boolean;
  execution: "not_executed";
  hardwareControlAvailable: false;
  status: "simulation_ready" | "blocked";
  targetId: string;
  sessionId: string;
  totalDurationMs: number;
  steps: Array<{ id: string; kind: SessionStep["kind"]; startsAtMs: number; endsAtMs: number }>;
  blockers: Array<{ code: string; detail: string }>;
}

export class RobotSessionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RobotSessionError";
  }
}

function object(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new RobotSessionError("INVALID_REQUEST", `${label} doit être un objet JSON.`);
  }
  const record = value as Record<string, unknown>;
  if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new RobotSessionError("UNKNOWN_FIELD", `${label} contient un champ non autorisé.`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(record))) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RobotSessionError("INVALID_REQUEST", `${label} doit contenir uniquement des données JSON.`);
    }
  }
  return record;
}

export function parseCatalogRequest(input: unknown): { targetId?: string } {
  const data = object(input, ["targetId"], "catalogue (targetId optionnel)");
  if (data.targetId === undefined) return {};
  return { targetId: identifier(data.targetId, "targetId") };
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) {
    throw new RobotSessionError("INVALID_REQUEST", `${label} invalide.`);
  }
  return value;
}

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RobotSessionError("INVALID_REQUEST", `${label} hors limites.`);
  }
  return value;
}

/** Runtime validation; trusted owner/mode come from KARTA, never from this payload. */
export function parseSessionRequest(input: unknown, now = Date.now()): SessionRequest {
  if (!Number.isSafeInteger(now) || now < 0) throw new RobotSessionError("INVALID_CLOCK", "Horloge invalide.");
  const data = object(input, ["version", "sessionId", "targetId", "expiresAt", "steps"], "session");
  if (data.version !== 1) throw new RobotSessionError("UNSUPPORTED_VERSION", "Version de séance non prise en charge.");
  const expiresAt = boundedInteger(data.expiresAt, 0, Number.MAX_SAFE_INTEGER, "expiresAt");
  if (expiresAt <= now || expiresAt - now > SESSION_LIMITS.durationMs) {
    throw new RobotSessionError("EXPIRED_REQUEST", "La séance doit expirer dans les cinq prochaines minutes.");
  }
  if (!Array.isArray(data.steps) || data.steps.length === 0 || data.steps.length > SESSION_LIMITS.steps) {
    throw new RobotSessionError("INVALID_REQUEST", "La séance doit contenir entre 1 et 24 étapes.");
  }
  for (let index = 0; index < data.steps.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(data.steps, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw new RobotSessionError("INVALID_REQUEST", "Les étapes doivent former un tableau JSON sans trou ni accesseur.");
    }
  }
  const seen = new Set<string>();
  let total = 0;
  const steps = data.steps.map((raw): SessionStep => {
    const step = object(raw, ["id", "kind", "text", "gesture", "durationMs", "required"], "étape");
    const id = identifier(step.id, "step.id");
    if (seen.has(id)) throw new RobotSessionError("DUPLICATE_STEP", "Identifiants d'étapes dupliqués.");
    seen.add(id);
    const durationMs = boundedInteger(step.durationMs, 1, 60_000, "durationMs");
    total += durationMs;
    if (total > SESSION_LIMITS.durationMs) throw new RobotSessionError("DURATION_LIMIT", "Séance limitée à cinq minutes.");
    if (step.required !== undefined && typeof step.required !== "boolean") {
      throw new RobotSessionError("INVALID_REQUEST", "required doit être un booléen.");
    }
    const required = step.required ?? true;
    if (step.kind === "speech") {
      if ("gesture" in step || typeof step.text !== "string" || !step.text.trim()
        || step.text.length > SESSION_LIMITS.textCharacters) {
        throw new RobotSessionError("INVALID_REQUEST", "Texte de parole invalide ou trop long.");
      }
      return { id, kind: "speech", text: step.text, durationMs, required };
    }
    if (step.kind === "gesture") {
      if ("text" in step || !["greeting", "attention"].includes(step.gesture as string)) {
        throw new RobotSessionError("UNSUPPORTED_GESTURE", "Geste absent du simulateur.");
      }
      return { id, kind: "gesture", gesture: step.gesture as "greeting" | "attention", durationMs, required };
    }
    if (step.kind === "pause" && !("text" in step) && !("gesture" in step)) {
      return { id, kind: "pause", durationMs, required };
    }
    throw new RobotSessionError("UNSUPPORTED_ACTION", "Action absente du contrat de séance.");
  });
  return {
    version: 1, sessionId: identifier(data.sessionId, "sessionId"),
    targetId: identifier(data.targetId, "targetId"), expiresAt, steps,
  };
}

/** Planning is pure: it cannot pair a device, play sound, or send motor commands. */
export function planRobotSession(input: unknown, now = Date.now()): SessionPlan {
  const request = parseSessionRequest(input, now);
  const target = getRobotTarget(request.targetId);
  const blockers: SessionPlan["blockers"] = [];
  if (!target) blockers.push({ code: "UNKNOWN_TARGET", detail: "Modèle absent du catalogue." });
  else if (target.stage !== "simulator") blockers.push({
    code: "CONNECTOR_NOT_IMPLEMENTED",
    detail: `${target.manufacturer} ${target.model} : aucune commande matérielle implémentée ou validée.`,
  });
  let offset = 0;
  const steps = request.steps.map((step) => {
    const startsAtMs = offset;
    offset += step.durationMs;
    return { id: step.id, kind: step.kind, startsAtMs, endsAtMs: offset };
  });
  return {
    ok: blockers.length === 0, execution: "not_executed", hardwareControlAvailable: false,
    status: blockers.length ? "blocked" : "simulation_ready", targetId: request.targetId,
    sessionId: request.sessionId, totalDurationMs: offset, steps, blockers,
  };
}
