import { normalizeRoutineInput, normalizeRoutineTimestamp, type RoutineInput } from "../../../karta/src/routines/contracts.ts";
import { readBoundedBytes, RequestBodyError } from "../_shared/request-body.ts";
import { cancelResponseQuietly, createRequestDeadline, RequestDeadlineError } from "../_shared/request-deadline.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/i;
const CHANNELS = ["call", "in_app", "push", "email"] as const;
const OCCURRENCE_STATES = ["pending", "processing", "completed", "cancelled", "skipped", "failed", "partial", "unknown"];
const DELIVERY_STATES = ["pending", "sending", "accepted", "completed", "failed", "unknown", "skipped"];
const MAX_REQUEST_BYTES = 65_536;
// Supports the bounded list of 100 configurations, 20 reports and 50 commands.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TOTAL_TIMEOUT_MS = 10_000;
const CANCEL_WARNING = "Les envois encore en attente sont annulés. Un appel déjà transmis peut continuer.";

export interface RoutineProxyDependencies {
  env(name: string): string | undefined;
  authenticate(token: string, signal: AbortSignal): Promise<{ id: string; is_anonymous?: boolean } | null>;
  rateLimit(key: string, max: number, windowMs: number): { allowed: boolean };
  fetch(input: string, init: RequestInit): Promise<Response>;
}

type Input =
  | { action: "list" | "pause-all" }
  | { action: "preview"; config: RoutineInput }
  | { action: "save"; id: string; expectedRevision: number; config: RoutineInput }
  | { action: "pause"; id: string; expectedRevision: number; pausedUntil: string | null; enabled?: boolean }
  | { action: "run-now"; id: string; expectedRevision: number; requestId: string }
  | { action: "cancel"; occurrenceId: string };

class Invalid extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Invalid();
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || [...value].length > max || (!empty && !value.trim())
    // eslint-disable-next-line no-control-regex -- Public strings must not contain binary/control data.
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    || /[\ud800-\udfff]/u.test(value)) throw new Invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Invalid();
  return value.toLowerCase();
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Invalid();
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Invalid();
  return value as T;
}
function list<T>(value: unknown, max: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Invalid();
  return value.map(parse);
}
function unique<T>(values: T[], key: (value: T) => string): T[] {
  if (new Set(values.map(key)).size !== values.length) throw new Invalid();
  return values;
}

function parseInput(value: unknown): Input {
  const input = record(value);
  const action = choice(input.action, ["list", "preview", "save", "pause", "pause-all", "run-now", "cancel"] as const);
  if (action === "list" || action === "pause-all") {
    exact(input, ["action"]);
    return { action };
  }
  if (action === "preview") {
    exact(input, ["action", "config"]);
    return { action, config: normalizeRoutineInput(input.config) };
  }
  if (action === "cancel") {
    exact(input, ["action", "occurrenceId"]);
    return { action, occurrenceId: uuid(input.occurrenceId) };
  }
  const id = uuid(input.id);
  const expectedRevision = integer(input.expectedRevision, action === "save" ? 0 : 1);
  if (action === "save") {
    exact(input, ["action", "id", "expectedRevision", "config"]);
    return { action, id, expectedRevision, config: normalizeRoutineInput(input.config) };
  }
  if (action === "pause") {
    exact(input, ["action", "id", "expectedRevision", "pausedUntil"], ["enabled"]);
    return { action, id, expectedRevision,
      pausedUntil: input.pausedUntil === null ? null : normalizeRoutineTimestamp(input.pausedUntil),
      ...(Object.hasOwn(input, "enabled") ? { enabled: bool(input.enabled) } : {}) };
  }
  exact(input, ["action", "id", "expectedRevision", "requestId"]);
  return { action, id, expectedRevision, requestId: uuid(input.requestId) };
}

function publicRoutine(value: unknown, ownerId: string) {
  const input = record(value);
  if (uuid(input.userId) !== ownerId) throw new Invalid();
  return { id: uuid(input.id), userId: ownerId, revision: integer(input.revision, 1),
    config: normalizeRoutineInput(input.config), createdAt: normalizeRoutineTimestamp(input.createdAt),
    updatedAt: normalizeRoutineTimestamp(input.updatedAt),
    lastOccurrenceAt: input.lastOccurrenceAt === null ? null : normalizeRoutineTimestamp(input.lastOccurrenceAt) };
}
function publicOccurrence(value: unknown, ownerId: string, detailed: boolean) {
  const input = record(value);
  // KARTA already projects owned history; reject an explicitly foreign owner too.
  if (input.userId !== undefined && uuid(input.userId) !== ownerId) throw new Invalid();
  const suppliedReport = input.report === undefined || input.report === null ? null : record(input.report);
  const report = suppliedReport === null ? null : {
    title: text(suppliedReport.title, 300, true), body: text(suppliedReport.body, 5_000, true),
  };
  const deliveries = unique(list(input.deliveries ?? (detailed ? undefined : []), 4, value => {
    const item = record(value);
    return { channel: choice(item.channel, CHANNELS), status: choice(item.status, DELIVERY_STATES) };
  }), item => item.channel);
  return { id: uuid(input.id), routineId: uuid(input.routineId), scheduledAt: normalizeRoutineTimestamp(input.scheduledAt),
    status: choice(input.status, OCCURRENCE_STATES), report, deliveries };
}
function publicCommand(value: unknown, ownerId: string) {
  const input = record(value);
  if (input.userId !== undefined && uuid(input.userId) !== ownerId) throw new Invalid();
  return { id: uuid(input.id), occurrenceId: uuid(input.occurrenceId), instruction: text(input.instruction, 8_000),
    status: choice(input.status, ["pending_confirmation", "submitted", "cancelled"]),
    createdAt: normalizeRoutineTimestamp(input.createdAt) };
}
function publicResult(value: unknown, input: Input, ownerId: string) {
  const result = record(value);
  if (result.ok !== true) throw new Invalid();
  switch (input.action) {
    case "list": {
      const cap = record(result.capabilities);
      const agents = unique(list(cap.agents, 100, value => {
        const agent = record(value);
        const type = text(agent.type, 100);
        if (!/^[a-z0-9][a-z0-9-]*$(?![\s\S])/.test(type)
          && !(type.startsWith("custom:") && UUID.test(type.slice(7)))) throw new Invalid();
        return { type, name: text(agent.name, 100) };
      }), item => item.type);
      const capabilities = { routines: bool(cap.routines), calls: bool(cap.calls),
        verifiedPhone: cap.verifiedPhone === null ? null : text(cap.verifiedPhone, 64),
        phoneBlockedReason: cap.phoneBlockedReason == null ? null : text(cap.phoneBlockedReason, 300),
        voiceCommands: choice(cap.voiceCommands, ["confirmation_required"]),
        email: bool(cap.email), push: bool(cap.push), agents };
      if (capabilities.calls && !capabilities.verifiedPhone) throw new Invalid();
      return { ok: true,
        routines: unique(list(result.routines, 100, value => publicRoutine(value, ownerId)), item => item.id),
        history: unique(list(result.history, 20, value => publicOccurrence(value, ownerId, true)), item => item.id),
        commands: unique(list(result.commands ?? [], 50, value => publicCommand(value, ownerId)), item => item.id),
        capabilities };
    }
    case "preview": {
      const occurrences = list(result.occurrences, 3, normalizeRoutineTimestamp);
      if (occurrences.some((at, index) => index > 0 && at <= occurrences[index - 1])) throw new Invalid();
      return { ok: true, occurrences };
    }
    case "save":
    case "pause": {
      const routine = publicRoutine(result.routine, ownerId);
      if (routine.id !== input.id || (routine.revision !== input.expectedRevision + 1
        && !(input.expectedRevision > 0 && routine.revision === input.expectedRevision))) throw new Invalid();
      if (input.action === "save" && JSON.stringify(routine.config) !== JSON.stringify(input.config)) throw new Invalid();
      if (input.action === "pause" && (routine.config.pausedUntil !== input.pausedUntil
        || (input.enabled !== undefined && routine.config.enabled !== input.enabled))) throw new Invalid();
      return { ok: true, routine };
    }
    case "pause-all": return { ok: true, updatedCount: integer(result.updatedCount, 0) };
    case "run-now": {
      const occurrence = publicOccurrence(result.occurrence, ownerId, false);
      if (occurrence.routineId !== input.id) throw new Invalid();
      return { ok: true, occurrence };
    }
    case "cancel":
      if (result.cancelled !== true || uuid(result.occurrenceId) !== input.occurrenceId) throw new Invalid();
      return { ok: true, cancelled: true, occurrenceId: input.occurrenceId, warning: CANCEL_WARNING };
  }
}

function trustedOrigin(deps: RoutineProxyDependencies): string {
  // Same deployment settings and production default as social-connect.
  const configured = deps.env("CORS_ALLOWED_ORIGIN");
  const source = configured ?? deps.env("APP_URL") ?? "https://purama-ai.purama.dev";
  if (source.length > 2048 || /\s/.test(source)) throw new Invalid();
  const url = new URL(source);
  if (url.protocol !== "https:" || url.username || url.password
    || (configured !== undefined && source !== url.origin)) throw new Invalid();
  return url.origin;
}

/** One bounded UTF-8 stream, including a stalled read and declared-length mismatches. */
async function readJson(message: Request | Response, maxBytes: number, deadline: number, signal: AbortSignal) {
  const contentType = message.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    cancelResponseQuietly(message.body);
    throw new Invalid();
  }
  const bytes = await readBoundedBytes({ body: message.body, headers: message.headers, signal }, {
    maxBytes, deadline,
    // fetch may decompress an upstream entity, whose Content-Length is then compressed.
    matchContentLength: message instanceof Request || !message.headers.has("Content-Encoding"),
  });
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(decoded) as unknown;
}

/** Authenticated public ingress: a browser cannot supply an owner or an internal credential. */
export function createIaoRoutinesHandler(deps: RoutineProxyDependencies) {
  return async (request: Request): Promise<Response> => {
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private", "Vary": "Origin, Authorization",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    const error = (status: number, code: string, message: string) => json({ ok: false, code, error: message }, status);
    let allowedOrigin: string;
    try { allowedOrigin = trustedOrigin(deps); }
    catch { return error(503, "ROUTINE_UNAVAILABLE", "Les routines sont temporairement indisponibles."); }
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== allowedOrigin) return error(403, "ROUTINE_ORIGIN", "Origine non autorisée.");
    if (origin === allowedOrigin) headers.set("Access-Control-Allow-Origin", origin);
    if (request.method === "OPTIONS") {
      const requestedMethod = request.headers.get("Access-Control-Request-Method");
      if (requestedMethod && requestedMethod !== "POST") {
        headers.set("Allow", "POST, OPTIONS");
        return error(405, "ROUTINE_METHOD", "Méthode non autorisée.");
      }
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") {
      headers.set("Allow", "POST, OPTIONS");
      return error(405, "ROUTINE_METHOD", "Méthode non autorisée.");
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const endsAt = performance.now() + TOTAL_TIMEOUT_MS;
    const deadline = createRequestDeadline(TOTAL_TIMEOUT_MS, controller.signal);
    let relayed = false;
    let unclaimed: Response | undefined;
    let finished = false;
    const discardResponse = () => { cancelResponseQuietly(unclaimed?.body); unclaimed = undefined; };
    try {
      deadline.check();
      const authorization = request.headers.get("Authorization") ?? "";
      const token = authorization.length <= 8192 ? /^Bearer ([^\s]+)$(?![\s\S])/i.exec(authorization)?.[1] : undefined;
      if (!token) return error(401, "ROUTINE_AUTH", "Connexion requise.");
      const authenticate = async () => {
        const authDeadline = createRequestDeadline(3_000, controller.signal);
        try { return await deadline.wait(() => authDeadline.wait(() => deps.authenticate(token, controller.signal))); }
        finally { authDeadline.close(); }
      };
      const user = await authenticate();
      deadline.check();
      if (!user || user.is_anonymous === true || typeof user.id !== "string" || !UUID.test(user.id)) {
        return error(401, "ROUTINE_AUTH", "Connexion requise.");
      }
      const ownerId = user.id.toLowerCase();
      let input: Input;
      try {
        input = parseInput(await deadline.wait(() => readJson(request, MAX_REQUEST_BYTES,
          Math.min(endsAt, performance.now() + 3_000), controller.signal)));
      } catch (reason) {
        if (reason instanceof RequestDeadlineError || controller.signal.aborted
          || (reason instanceof RequestBodyError && reason.status === 408)) throw reason;
        return error(reason instanceof RequestBodyError && reason.status === 413 ? 413 : 400,
          "ROUTINE_INVALID", "Vérifiez les réglages de la routine.");
      }
      deadline.check();
      const mutation = input.action !== "list" && input.action !== "preview";
      const bucket = input.action === "run-now" ? "run"
        : ["cancel", "pause", "pause-all"].includes(input.action) ? "stop" : mutation ? "write" : "read";
      if (!deps.rateLimit(`iao-routines:${bucket}:${ownerId}`,
        bucket === "run" ? 10 : bucket === "write" ? 60 : 120,
        bucket === "run" ? 3_600_000 : 60_000).allowed) {
        return error(429, "ROUTINE_RATE_LIMIT", "Trop de demandes. Patientez avant de réessayer.");
      }
      const endpoint = deps.env("KARTA_INTERNAL_URL");
      const key = deps.env("KARTA_ADMIN_TOKEN");
      if (!endpoint || endpoint.length > 2048 || !key || key.length > 8192 || /\s/.test(key)) {
        return error(503, "ROUTINE_UNAVAILABLE", "Les routines sont temporairement indisponibles.");
      }
      let target: URL;
      try {
        target = new URL(endpoint);
        if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Invalid();
        target.pathname = `${target.pathname.replace(/\/+$/, "")}/routines/${ownerId}`;
      } catch { return error(503, "ROUTINE_UNAVAILABLE", "Les routines sont temporairement indisponibles."); }

      // Parsing, rate limiting and configuration may take time. Revalidate the
      // original bearer immediately before every mutation; never pick a new token.
      if (mutation) {
        const current = await authenticate();
        if (!current || current.is_anonymous === true || typeof current.id !== "string"
          || !UUID.test(current.id) || current.id.toLowerCase() !== ownerId) {
          return error(401, "ROUTINE_AUTH", "Votre session a changé. Reconnectez-vous.");
        }
      }
      deadline.check();
      const response = await deadline.wait(() => {
        relayed = true;
        return deps.fetch(target.toString(), { method: "POST", body: JSON.stringify(input),
          headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
          redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
        }).then(response => {
          unclaimed = response;
          if (finished || controller.signal.aborted || performance.now() >= endsAt) discardResponse();
          return response;
        });
      });
      deadline.check();
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Invalid();
      if (!response.ok) {
        discardResponse();
        const failures: Record<number, [string, string]> = {
          400: ["ROUTINE_INVALID", "Vérifiez les réglages de la routine."],
          403: ["ROUTINE_FORBIDDEN", "Cette opération n’est pas autorisée pour votre compte."],
          404: ["ROUTINE_NOT_FOUND", "Cette routine ou ce bilan est introuvable."],
          409: ["ROUTINE_CONFLICT", "La routine a changé ou ne permet plus cette action. Actualisez son état."],
          413: ["ROUTINE_TOO_LARGE", "La demande est trop volumineuse."],
          429: ["ROUTINE_RATE_LIMIT", "La limite de demandes ou d’appels est atteinte. Consultez vos réglages."],
          503: ["ROUTINE_UNAVAILABLE", "Les routines sont temporairement indisponibles. Actualisez leur état avant de réessayer."],
        };
        const safe = failures[response.status];
        return safe ? error(response.status, safe[0], safe[1])
          : error(502, "ROUTINE_UNCONFIRMED", "Résultat non confirmé. Consultez l’historique avant de réessayer.");
      }
      if (response.status !== 200 && response.status !== 202) throw new Invalid();
      const received = await deadline.wait(() => readJson(response, MAX_RESPONSE_BYTES, endsAt, controller.signal));
      unclaimed = undefined;
      const result = publicResult(received, input, ownerId);
      deadline.check();
      return json(result, response.status);
    } catch (reason) {
      if (request.signal.aborted) return error(499, "ROUTINE_CANCELLED", "Demande interrompue. Consultez son état avant de réessayer.");
      if (reason instanceof RequestDeadlineError || (reason instanceof RequestBodyError && reason.status === 408)) {
        return error(504, "ROUTINE_TIMEOUT", "Délai dépassé. Consultez l’historique avant de réessayer.");
      }
      return relayed
        ? error(502, "ROUTINE_UNCONFIRMED", "Résultat non confirmé. Consultez l’historique avant de réessayer.")
        : error(503, "ROUTINE_UNAVAILABLE", "Les routines sont temporairement indisponibles.");
    } finally {
      finished = true;
      discardResponse();
      controller.abort();
      deadline.close();
      request.signal.removeEventListener("abort", abort);
    }
  };
}
