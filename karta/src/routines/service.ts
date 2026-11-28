import { config as hostConfig } from "../config.js";
import { normalizeRoutineInput, normalizeRoutineTimestamp, ROUTINE_CHANNELS, type Routine, type RoutineInput } from "./contracts.js";
import { calculateNextOccurrences, routineMayDeliverAt } from "./schedule.js";
import { phoneConfigured, routineRuntimeConfig, type RoutineRuntimeConfig } from "./runtime.js";
import { record, routineId, routineStore, RoutineError, type RoutineOccurrence, type RoutineStore } from "./store.js";

export interface RoutineCapabilities {
  routines: boolean;
  calls: boolean;
  verifiedPhone: string | null;
  phoneBlockedReason: string | null;
  voiceCommands: "confirmation_required";
  email: boolean;
  push: boolean;
  agents: Array<{ type: string; name: string }>;
}

export interface RoutineServiceDependencies {
  store: RoutineStore;
  runtime: RoutineRuntimeConfig;
  requestNow(routine: Routine, requestId: string): Promise<RoutineOccurrence | null>;
  now(): number;
  emailConfigured: boolean;
  isActive(): boolean;
}

type Request =
  | { action: "list" | "pause-all" }
  | { action: "preview"; config: RoutineInput }
  | { action: "save"; id: string; expectedRevision: number; config: RoutineInput }
  | { action: "pause"; id: string; expectedRevision: number; pausedUntil: string | null; enabled?: boolean }
  | { action: "run-now"; id: string; expectedRevision: number; requestId: string }
  | { action: "cancel"; occurrenceId: string };

const REQUIRED: Record<Request["action"], string[]> = {
  list: [], preview: ["config"], save: ["id", "expectedRevision", "config"],
  pause: ["id", "expectedRevision", "pausedUntil"], "pause-all": [],
  "run-now": ["id", "expectedRevision", "requestId"], cancel: ["occurrenceId"],
};
const OCCURRENCE_STATES = new Set(["pending", "processing", "completed", "cancelled", "skipped", "failed", "partial", "unknown"]);
const DELIVERY_STATES = new Set(["pending", "sending", "accepted", "completed", "failed", "unknown", "skipped"]);
const COMMAND_STATES = new Set(["pending_confirmation", "submitted", "cancelled"]);
const PREFERENCES = ["email_enabled", "daily_report_enabled", "task_completed_enabled", "question_enabled", "alert_enabled"] as const;
const AGENT_LABELS: Record<string, string> = {
  email: "Courrier", compta: "Comptabilité", legal: "Juridique", partner: "Partenariats",
  "repondeur-intelligent": "Répondeur intelligent", "campagnes-par-courriel": "Campagnes par courriel",
  "pro-de-la-sensibilisation-au-froid": "Prospection", "newsletter-genie": "Newsletter",
  "facture-pro": "Facturation", "rapports-financiers": "Rapports financiers", "chasseur-de-paiements": "Suivi des paiements",
  "crm-intelligent": "CRM", "machine-de-suivi": "Suivi", "maitre-des-publicites": "Publicités",
  "planificateur-d-appels": "Planification d’appels", "reservation-intelligente": "Réservations",
};

function invalid(): never { throw new RoutineError("ROUTINE_INVALID", 400, "Vérifiez les paramètres de la routine."); }
function unavailable(): never { throw new RoutineError("ROUTINE_UNAVAILABLE"); }
function parseConfig(value: unknown): RoutineInput {
  try { return normalizeRoutineInput(value); } catch { return invalid(); }
}
function revision(value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) return invalid();
  return value;
}
function parseRequest(value: unknown): Request {
  if (!record(value) || typeof value.action !== "string" || !Object.hasOwn(REQUIRED, value.action)) return invalid();
  const action = value.action as Request["action"];
  const keys = ["action", ...REQUIRED[action]];
  if (keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key =>
    !keys.includes(key) && !(action === "pause" && key === "enabled"))) return invalid();
  switch (action) {
    case "list": case "pause-all": return { action };
    case "preview": return { action, config: parseConfig(value.config) };
    case "save": return { action, id: routineId(value.id), expectedRevision: revision(value.expectedRevision, 0), config: parseConfig(value.config) };
    case "run-now": return { action, id: routineId(value.id), expectedRevision: revision(value.expectedRevision, 1), requestId: routineId(value.requestId) };
    case "cancel": return { action, occurrenceId: routineId(value.occurrenceId) };
    case "pause": {
      if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") return invalid();
      let pausedUntil: string | null;
      try { pausedUntil = value.pausedUntil === null ? null : normalizeRoutineTimestamp(value.pausedUntil); }
      catch { return invalid(); }
      return { action, id: routineId(value.id), expectedRevision: revision(value.expectedRevision, 1), pausedUntil,
        ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}) };
    }
  }
}

function publicRoutine(value: Routine, userId: string, expectedId?: string): Routine {
  try {
    if (!value || value.userId !== userId || (expectedId && value.id !== expectedId)) return unavailable();
    return { id: routineId(value.id), userId, revision: revision(value.revision, 1), config: normalizeRoutineInput(value.config),
      createdAt: normalizeRoutineTimestamp(value.createdAt), updatedAt: normalizeRoutineTimestamp(value.updatedAt),
      lastOccurrenceAt: value.lastOccurrenceAt === null ? null : normalizeRoutineTimestamp(value.lastOccurrenceAt) };
  } catch { return unavailable(); }
}
function plainText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max * 2 && [...value].length <= max &&
    // eslint-disable-next-line no-control-regex -- Public text explicitly excludes unsafe controls and unpaired surrogates.
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(value);
}
function publicOccurrence(value: unknown) {
  if (!record(value) || typeof value.status !== "string" || !OCCURRENCE_STATES.has(value.status) ||
    !record(value.report) || !plainText(value.report.title, 300) || !plainText(value.report.body, 5_000) ||
    value.report.title.length > 300 || value.report.body.length > 5_000 || /[\r\n\t]/.test(value.report.title) ||
    !Array.isArray(value.deliveries) || value.deliveries.length > 4) return unavailable();
  const seen = new Set<string>();
  const deliveries = value.deliveries.map(row => {
    if (!record(row) || typeof row.channel !== "string" || !ROUTINE_CHANNELS.some(channel => channel === row.channel) ||
      seen.has(row.channel) || typeof row.status !== "string" || !DELIVERY_STATES.has(row.status)) return unavailable();
    seen.add(row.channel);
    return { channel: row.channel, status: row.status };
  });
  try {
    return { id: routineId(value.id), routineId: routineId(value.routineId), scheduledAt: normalizeRoutineTimestamp(value.scheduledAt),
      status: value.status, report: { title: value.report.title, body: value.report.body }, deliveries };
  } catch { return unavailable(); }
}
function publicCommand(value: unknown) {
  if (!record(value) || !plainText(value.instruction, 4_000) || !value.instruction.trim() ||
    typeof value.status !== "string" || !COMMAND_STATES.has(value.status)) return unavailable();
  try {
    return { id: routineId(value.id), occurrenceId: routineId(value.occurrenceId), instruction: value.instruction,
      status: value.status, createdAt: normalizeRoutineTimestamp(value.createdAt) };
  } catch { return unavailable(); }
}

/** Authenticated routes supply the owner; request data never selects an account. */
export function createRoutineService(dependencies: Partial<RoutineServiceDependencies> = {}) {
  const store = dependencies.store ?? routineStore;
  const runtime = dependencies.runtime ?? routineRuntimeConfig();
  const now = dependencies.now ?? Date.now;
  const emailConfigured = dependencies.emailConfigured ?? !!hostConfig.resendApiKey.trim();
  const isActive = dependencies.isActive ?? (() => true);
  const requestNow = dependencies.requestNow ?? (async (routine: Routine, requestId: string) => {
    const { createRoutineProcessor } = await import("./worker.js");
    return createRoutineProcessor({ store, runtime, now }).requestNow(routine, requestId, isActive);
  });

  async function readiness(userId: string) {
    const [contact, preferences] = await Promise.all([store.destination(userId), store.preferences(userId)]);
    if (!contact || (contact.phone !== null && (typeof contact.phone !== "string" || !/^\+[1-9]\d{6,14}$/.test(contact.phone))) ||
      (contact.email !== null && (typeof contact.email !== "string" || !contact.email.trim() || /[\r\n]/.test(contact.email)))) return unavailable();
    if (preferences !== null && (preferences.user_id !== userId || PREFERENCES.some(key =>
      preferences[key] !== undefined && preferences[key] !== null && typeof preferences[key] !== "boolean"))) return unavailable();
    const phoneBlockedReason = !runtime.enabled ? "Les routines IAO sont actuellement désactivées."
      : !phoneConfigured(runtime) || runtime.commandSecret.length < 32 ? "Le service téléphonique doit être configuré."
        : !contact.phone ? "Vérifiez votre numéro de téléphone pour recevoir un appel." : null;
    return { preferences, capabilities: {
      routines: runtime.enabled, calls: phoneBlockedReason === null,
      verifiedPhone: contact.phone === null ? null : `+•• •••• ${contact.phone.slice(-4)}`, phoneBlockedReason,
      voiceCommands: "confirmation_required" as const,
      email: runtime.enabled && emailConfigured && contact.email !== null && preferences?.email_enabled !== false,
      push: runtime.enabled && runtime.pushEnabled,
    } };
  }
  async function assertCanActivate(userId: string, configuration: RoutineInput): Promise<void> {
    if (!runtime.enabled) throw new RoutineError("ROUTINE_DISABLED", 503, "Les routines IAO sont actuellement désactivées.");
    const { capabilities, preferences } = await readiness(userId);
    const preference = configuration.schedule.kind === "event"
      ? { completed: "task_completed_enabled", decision: "question_enabled", blocked: "alert_enabled" }[configuration.schedule.event]
      : "daily_report_enabled";
    if (preferences?.[preference] === false) throw new RoutineError("ROUTINE_PREFERENCE_DISABLED", 400, "Ce type de bilan est désactivé dans vos préférences.");
    if (configuration.channels.some(channel => channel === "call" && !capabilities.calls || channel === "email" && !capabilities.email || channel === "push" && !capabilities.push)) {
      throw new RoutineError("ROUTINE_CHANNEL_UNAVAILABLE", 400, "Un canal choisi est indisponible. Enregistrez en pause ou modifiez les canaux.");
    }
  }
  async function current(userId: string, id: string, expectedRevision: number): Promise<Routine> {
    const routine = publicRoutine(await store.get(userId, id), userId, id);
    if (routine.revision !== expectedRevision) throw new RoutineError("ROUTINE_CONFLICT", 409, "La routine a changé. Actualisez ses réglages.");
    return routine;
  }
  async function saved(userId: string, id: string, expectedRevision: number, configuration: RoutineInput) {
    const result = publicRoutine(await store.save(userId, id, expectedRevision, configuration), userId, id);
    if ((result.revision !== expectedRevision && result.revision !== expectedRevision + 1) ||
      JSON.stringify(result.config) !== JSON.stringify(configuration)) return unavailable();
    return { ok: true as const, routine: result };
  }

  return {
    async handle(trustedUserId: string, body: unknown) {
      const userId = routineId(trustedUserId);
      const request = parseRequest(body);
      switch (request.action) {
        case "list": {
          const [routines, history, commands, available, registry] = await Promise.all([
            store.list(userId), store.history(userId), store.commands(userId), readiness(userId), import("../agents/index.js"),
          ]);
          if (!Array.isArray(routines) || routines.length > 100 || !Array.isArray(history) || history.length > 20 ||
            !Array.isArray(commands) || commands.length > 20) return unavailable();
          const owned = routines.map(row => publicRoutine(row, userId));
          const receipts = history.map(publicOccurrence);
          const captured = commands.map(publicCommand);
          if (new Set(owned.map(row => row.id)).size !== owned.length || new Set(receipts.map(row => row.id)).size !== receipts.length ||
            new Set(captured.map(row => row.id)).size !== captured.length) return unavailable();
          const agents = Object.values(registry.AGENT_REGISTRY).map(agent => ({ type: agent.type, name: AGENT_LABELS[agent.type] ?? agent.type }));
          const capabilities: RoutineCapabilities = { ...available.capabilities, agents };
          return { ok: true as const, routines: owned, history: receipts, commands: captured, capabilities };
        }
        case "preview": return { ok: true as const, occurrences: calculateNextOccurrences(request.config, now(), 3) };
        case "save": {
          if (request.config.enabled) await assertCanActivate(userId, request.config);
          return saved(userId, request.id, request.expectedRevision, request.config);
        }
        case "pause": {
          const previous = await current(userId, request.id, request.expectedRevision);
          const next = parseConfig({ ...previous.config, pausedUntil: request.pausedUntil, enabled: request.enabled ?? previous.config.enabled });
          const previousPause = previous.config.pausedUntil === null ? -Infinity : Date.parse(previous.config.pausedUntil);
          const nextPause = next.pausedUntil === null ? -Infinity : Date.parse(next.pausedUntil);
          // Stopping or extending an existing pause remains possible during an
          // outage. Re-enabling or shortening it must pass fresh readiness.
          if (next.enabled && (!previous.config.enabled || nextPause < previousPause)) await assertCanActivate(userId, next);
          return saved(userId, request.id, request.expectedRevision, next);
        }
        case "pause-all": {
          const updatedCount = await store.pauseAll(userId);
          if (!Number.isSafeInteger(updatedCount) || updatedCount < 0) return unavailable();
          return { ok: true as const, updatedCount };
        }
        case "run-now": {
          if (!runtime.enabled) throw new RoutineError("ROUTINE_DISABLED", 503, "Les routines IAO sont actuellement désactivées.");
          const routine = await current(userId, request.id, request.expectedRevision);
          if (!routineMayDeliverAt(routine.config, now())) throw new RoutineError("ROUTINE_PAUSED", 409, "Cette routine est en pause ou dans ses heures calmes.");
          await assertCanActivate(userId, routine.config);
          if (!isActive()) throw new RoutineError("ROUTINE_DISABLED", 503, "Les routines IAO sont actuellement indisponibles.");
          const occurrence = await requestNow(routine, request.requestId);
          if (occurrence === null) throw new RoutineError("ROUTINE_REJECTED", 409, "La demande n’a pas été admise. Actualisez son état.");
          if (!occurrence || occurrence.userId !== userId || occurrence.routineId !== routine.id ||
            occurrence.revision !== routine.revision || occurrence.slot !== `manual:${request.requestId}`) return unavailable();
          const deliveries = await store.deliveries(occurrence);
          return { ok: true as const, occurrence: publicOccurrence({ ...occurrence, deliveries }) };
        }
        case "cancel": {
          await store.cancel(userId, request.occurrenceId);
          return { ok: true as const, cancelled: true as const, occurrenceId: request.occurrenceId };
        }
      }
    },
  };
}
