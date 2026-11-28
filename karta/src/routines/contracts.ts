/** Shared, dependency-free contract for the existing IAO client and KARTA host. */
export const ROUTINE_CHANNELS = ["call", "in_app", "push", "email"] as const;
export type RoutineChannel = typeof ROUTINE_CHANNELS[number];
export type Schedule =
  | { kind: "daily"; time: string; timezone: string }
  | { kind: "weekly"; time: string; timezone: string; days: number[] }
  | { kind: "once"; at: string; timezone: string }
  | { kind: "event"; event: "completed" | "blocked" | "decision"; timezone: string };
export type RoutineSchedule = Schedule;
export interface RoutineInput {
  name: string;
  instruction: string;
  enabled: boolean;
  schedule: Schedule;
  channels: RoutineChannel[];
  deliveryMode: "parallel" | "fallback";
  agentTypes: string[];
  length: "express" | "standard" | "detailed";
  quietHours: { start: string; end: string } | null;
  pausedUntil: string | null;
  onlyIfNew: boolean;
  maxCallMinutes: number;
  /** Applied to all reserved calls of this account in the same UTC month. */
  monthlyCallMinutes: number;
}
export interface Routine {
  id: string;
  userId: string;
  revision: number;
  config: RoutineInput;
  createdAt: string;
  updatedAt: string;
  lastOccurrenceAt: string | null;
}
export class RoutineValidationError extends Error {
  readonly code = "ROUTINE_INVALID";
  constructor(message = "Réglage de routine invalide") { super(message); this.name = "RoutineValidationError"; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const AGENTS = new Set([
  "email", "compta", "legal", "partner", "repondeur-intelligent", "campagnes-par-courriel",
  "pro-de-la-sensibilisation-au-froid", "newsletter-genie", "facture-pro", "rapports-financiers",
  "chasseur-de-paiements", "crm-intelligent", "machine-de-suivi", "maitre-des-publicites",
  "planificateur-d-appels", "reservation-intelligente",
]);

function fail(message: string): never { throw new RoutineValidationError(message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("Objet de routine attendu");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail("Champs de routine absents ou non reconnus");
  }
}
function text(value: unknown, max: number, label: string, multiline = false): string {
  if (typeof value !== "string") return fail(`${label} invalide`);
  const result = value.trim();
  // eslint-disable-next-line no-control-regex -- Intentionally reject C0 controls; multiline accepts only tab, CR and LF.
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
  if (!result || [...result].length > max || controls.test(result) || /[\ud800-\udfff]/u.test(result)) {
    return fail(`${label} invalide`);
  }
  return result;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return fail(`${label} doit être un booléen`);
  return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return fail(`${label} hors limites`);
  }
  return value;
}
function time(value: unknown): string {
  if (typeof value !== "string" || !TIME.test(value)) return fail("Heure locale invalide");
  return value;
}

/** Explicit offset is mandatory; Date.parse alone normalizes impossible dates. */
export function normalizeRoutineTimestamp(value: unknown): string {
  if (typeof value !== "string") return fail("Date invalide");
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  if (!match) return fail("Date avec fuseau explicite attendue");
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  if (year < 1970 || year > 2200 || month < 1 || month > 12 || day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      (match[8].slice(1, 3) === "14" && match[8].slice(4) !== "00")) return fail("Date invalide");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return fail("Date invalide");
  return new Date(millis).toISOString();
}
function timezone(value: unknown): string {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) {
    return fail("Fuseau IANA invalide");
  }
  try { return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone; }
  catch { return fail("Fuseau IANA inconnu"); }
}
function schedule(value: unknown): Schedule {
  const row = object(value);
  const zone = timezone(row.timezone);
  if (row.kind === "daily") {
    keys(row, ["kind", "time", "timezone"]);
    return { kind: "daily", time: time(row.time), timezone: zone };
  }
  if (row.kind === "weekly") {
    keys(row, ["kind", "time", "timezone", "days"]);
    if (!Array.isArray(row.days) || row.days.length < 1 || row.days.length > 7) return fail("Jours de semaine invalides");
    const days = row.days.map(day => integer(day, 0, 6, "Jour"));
    if (new Set(days).size !== days.length) return fail("Jour de semaine répété");
    return { kind: "weekly", time: time(row.time), timezone: zone, days: days.sort((a, b) => a - b) };
  }
  if (row.kind === "once") {
    keys(row, ["kind", "at", "timezone"]);
    return { kind: "once", at: normalizeRoutineTimestamp(row.at), timezone: zone };
  }
  if (row.kind === "event") {
    keys(row, ["kind", "event", "timezone"]);
    if (row.event !== "completed" && row.event !== "blocked" && row.event !== "decision") return fail("Événement invalide");
    return { kind: "event", event: row.event, timezone: zone };
  }
  return fail("Type de programmation invalide");
}

export function normalizeRoutineInput(value: unknown): RoutineInput {
  const row = object(value);
  keys(row, ["name", "instruction", "enabled", "schedule", "channels", "deliveryMode", "agentTypes",
    "length", "quietHours", "pausedUntil", "onlyIfNew", "maxCallMinutes", "monthlyCallMinutes"]);
  if (!Array.isArray(row.channels) || row.channels.length < 1 || row.channels.length > ROUTINE_CHANNELS.length ||
      row.channels.some(channel => !ROUTINE_CHANNELS.includes(channel as RoutineChannel)) || new Set(row.channels).size !== row.channels.length) {
    return fail("Canaux de communication invalides");
  }
  if (!Array.isArray(row.agentTypes) || row.agentTypes.length > 32 || row.agentTypes.some(agent =>
    typeof agent !== "string" || (!AGENTS.has(agent) && !(agent.startsWith("custom:") && UUID.test(agent.slice(7)))))) {
    return fail("Projets ou agents invalides");
  }
  if (new Set(row.agentTypes).size !== row.agentTypes.length) return fail("Projet ou agent répété");
  if (row.deliveryMode !== "parallel" && row.deliveryMode !== "fallback") return fail("Mode de livraison invalide");
  if (row.length !== "express" && row.length !== "standard" && row.length !== "detailed") return fail("Longueur de bilan invalide");
  let quietHours: RoutineInput["quietHours"] = null;
  if (row.quietHours !== null) {
    const quiet = object(row.quietHours);
    keys(quiet, ["start", "end"]);
    quietHours = { start: time(quiet.start), end: time(quiet.end) };
    if (quietHours.start === quietHours.end) return fail("Les heures calmes doivent avoir un début et une fin distincts");
  }
  const maxCallMinutes = integer(row.maxCallMinutes, 1, 10, "Durée d'appel");
  const monthlyCallMinutes = integer(row.monthlyCallMinutes, 0, 3000, "Budget mensuel d'appel");
  if (row.channels.includes("call") && monthlyCallMinutes < maxCallMinutes) return fail("Le budget doit couvrir au moins un appel");
  return {
    name: text(row.name, 100, "Nom"), instruction: text(row.instruction, 4000, "Consigne", true),
    enabled: bool(row.enabled, "Activation"), schedule: schedule(row.schedule),
    channels: [...row.channels] as RoutineChannel[], deliveryMode: row.deliveryMode,
    agentTypes: [...row.agentTypes] as string[], length: row.length, quietHours,
    pausedUntil: row.pausedUntil === null ? null : normalizeRoutineTimestamp(row.pausedUntil),
    onlyIfNew: bool(row.onlyIfNew, "Nouveautés uniquement"), maxCallMinutes, monthlyCallMinutes,
  };
}
