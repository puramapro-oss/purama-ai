import { parseSessionRequest, RobotSessionError, SESSION_LIMITS, type SessionRequest, type SessionStep } from "./session.js";

export const ROUTINE_FORMAT = "purama.robot.routine";
export const ROUTINE_FILE_MAX_BYTES = 512_000;

/** Portable intentions, never a connection token or a robot program. */
export interface RobotRoutine {
  format: typeof ROUTINE_FORMAT;
  version: 1;
  name: string;
  steps: SessionStep[];
}

export function parseRobotRoutine(input: unknown): RobotRoutine {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new RobotSessionError("INVALID_ROUTINE", "La routine doit être un objet JSON.");
  }
  const allowed = ["format", "version", "name", "steps"];
  if (Reflect.ownKeys(input).some(key => typeof key !== "string" || !allowed.includes(key))) {
    throw new RobotSessionError("UNKNOWN_FIELD", "La routine contient un champ non autorisé.");
  }
  if (Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !descriptor.enumerable || !("value" in descriptor))) {
    throw new RobotSessionError("INVALID_ROUTINE", "La routine doit contenir uniquement des données JSON.");
  }
  const data = input as Record<string, unknown>;
  if (data.format !== ROUTINE_FORMAT || data.version !== 1) {
    throw new RobotSessionError("UNSUPPORTED_VERSION", "Format ou version de routine non pris en charge.");
  }
  if (typeof data.name !== "string" || !data.name.trim() || data.name.length > 120) {
    throw new RobotSessionError("INVALID_ROUTINE", "Donnez à la routine un nom de 1 à 120 caractères.");
  }
  // Reuse the session contract without baking an expiry or target into the file.
  const session = parseSessionRequest({
    version: 1, sessionId: "routine-validation", targetId: "purama-simulator",
    expiresAt: SESSION_LIMITS.durationMs, steps: data.steps,
  }, 0);
  return { format: ROUTINE_FORMAT, version: 1, name: data.name.trim(), steps: session.steps };
}

export function parseRobotRoutineJson(text: string): RobotRoutine {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > ROUTINE_FILE_MAX_BYTES) {
    throw new RobotSessionError("ROUTINE_FILE_TOO_LARGE", "Fichier trop volumineux : limite de 512 000 octets.");
  }
  let input: unknown;
  try {
    input = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new RobotSessionError("INVALID_JSON", "Ce fichier ne contient pas un JSON valide.");
  }
  return parseRobotRoutine(input);
}

export function serializeRobotRoutine(input: unknown): string {
  const text = `${JSON.stringify(parseRobotRoutine(input), null, 2)}\n`;
  // Keep exported files inside the same contract as imported files.
  if (new TextEncoder().encode(text).byteLength > ROUTINE_FILE_MAX_BYTES) {
    throw new RobotSessionError("ROUTINE_FILE_TOO_LARGE", "Fichier trop volumineux : limite de 512 000 octets.");
  }
  return text;
}

/** A caller chooses the target explicitly. Planning still gates every physical target. */
export function prepareRobotRoutine(input: unknown, options: { sessionId: string; targetId: string; now?: number }): SessionRequest {
  const routine = parseRobotRoutine(input);
  const now = options.now ?? Date.now();
  return parseSessionRequest({
    version: 1, sessionId: options.sessionId, targetId: options.targetId,
    expiresAt: now + SESSION_LIMITS.durationMs, steps: routine.steps,
  }, now);
}
