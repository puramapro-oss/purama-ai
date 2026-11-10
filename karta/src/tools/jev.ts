import { createHash } from "node:crypto";
import type { ToolDefinition, ToolExecutionContext } from "../engine/types.js";
import { JevTransportError, requestJev } from "../jev/client.js";
import { JEV_MODEL, validateJevRequest, type JevAnswer, type JevRequest, type JevResponse } from "../jev/schema.js";

export const JEV_TOOL_TIMEOUT_MS = 10_000;
export const JEV_SETTLEMENT_TIMEOUT_MS = 2_000;

export interface JevAdmissionRequest {
  readonly userId: string;
  readonly agentType: ToolExecutionContext["agentType"];
  readonly operationId: string;
  readonly model: typeof JEV_MODEL;
  readonly requestHash: string;
  readonly request: Readonly<JevRequest>;
}

export type JevThreshold =
  | { type: "confidence"; minConfidence: number }
  | { type: "noul"; negativeMax: number; positiveMin: number };

/** Created only by the host's authenticated authorization/quota service. */
export interface JevPermit {
  userId: string;
  operationId: string;
  requestHash: string;
  model: typeof JEV_MODEL;
  reservationId: string;
  qualificationRef: string;
  validUntilMs: number;
  /** The host must abort this signal on revocation/cancellation. */
  signal: AbortSignal;
  /** Qualified thresholds for these exact questions; never supplied by the model. */
  thresholds: Record<string, JevThreshold>;
}

export interface JevReceipt {
  providerAttempted: boolean;
  usageKnown: boolean;
  usage?: JevResponse["usage"];
  outcome: "received" | "failed" | "not_dispatched";
}

export interface JevToolOptions {
  enabled?: boolean;
  apiKey?: string;
  /** Must validate the tenant, permitted data, exact qualified questions and reserve
   * budget atomically. A late/cancelled admission must expire or undo its own lease. */
  authorizeAndReserve?: (request: Readonly<JevAdmissionRequest>, signal: AbortSignal) => Promise<JevPermit | null>;
  /** Reconcile once with the canonical ledger. Unknown usage must not be treated as
   * zero or released automatically. Must honor the supplied cleanup deadline. */
  settle?: (request: Readonly<JevAdmissionRequest>, permit: JevPermit, receipt: Readonly<JevReceipt>, signal: AbortSignal) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type JevFailureReason = "disabled" | "not_configured" | "simulation" | "invalid_request" |
  "invalid_context" | "not_authorized" | "invalid_permit" | "authorization_expired" |
  "admission_unavailable" | "deadline" | "cancelled" | "authentication" | "credits" |
  "rate_limit" | "provider_unavailable" | "invalid_response" | "accounting_unconfirmed";

export type JevToolResult =
  | { ok: false; status: "unavailable"; reason: JevFailureReason; providerAttempted: boolean; usageKnown: boolean }
  | { ok: true; status: "judgment_received"; model: typeof JEV_MODEL; usage: JevResponse["usage"];
      decisions: Record<string, { status: "candidate" | "abstain"; answer: JevAnswer }> };

function unavailable(reason: JevFailureReason, providerAttempted = false, usageKnown = false): JevToolResult {
  return { ok: false, status: "unavailable", reason, providerAttempted, usageKnown };
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validPermit(permit: JevPermit, admission: JevAdmissionRequest): boolean {
  if (!permit || permit.userId !== admission.userId || permit.operationId !== admission.operationId ||
      permit.requestHash !== admission.requestHash || permit.model !== JEV_MODEL ||
      typeof permit.reservationId !== "string" || !permit.reservationId.trim() || permit.reservationId.length > 200 ||
      typeof permit.qualificationRef !== "string" || !permit.qualificationRef.trim() || permit.qualificationRef.length > 200 ||
      !Number.isSafeInteger(permit.validUntilMs) || !(permit.signal instanceof AbortSignal) ||
      !permit.thresholds || typeof permit.thresholds !== "object" || Array.isArray(permit.thresholds)) return false;
  const keys = Object.keys(admission.request.questions);
  if (Object.keys(permit.thresholds).length !== keys.length) return false;
  return keys.every(key => {
    if (!Object.hasOwn(permit.thresholds, key)) return false;
    const threshold = permit.thresholds[key];
    if (!threshold || typeof threshold !== "object") return false;
    if (admission.request.questions[key].type === "noul") {
      return threshold.type === "noul" && probability(threshold.negativeMax) && probability(threshold.positiveMin) &&
        threshold.negativeMax < threshold.positiveMin;
    }
    return threshold.type === "confidence" && probability(threshold.minConfidence);
  });
}

/** Stops awaiting uncooperative callbacks as well as signalling their cancellation. */
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The work may have synchronously triggered revocation before this call.
    // Consume its rejection even though the cancellation takes precedence.
    void work.catch(() => undefined);
    signal.throwIfAborted();
  }
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Jev operation cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function decisionsFor(response: JevResponse, permit: JevPermit): Extract<JevToolResult, { ok: true }> {
  const decisions: Extract<JevToolResult, { ok: true }>["decisions"] = {};
  for (const [key, answer] of Object.entries(response.answers)) {
    const threshold = permit.thresholds[key];
    const accepted = answer.type === "noul" && threshold.type === "noul"
      ? answer.noul <= threshold.negativeMax || answer.noul >= threshold.positiveMin
      : answer.type !== "noul" && threshold.type === "confidence" && answer.confidence >= threshold.minConfidence;
    decisions[key] = { status: accepted ? "candidate" : "abstain", answer };
  }
  return { ok: true, status: "judgment_received", model: JEV_MODEL, usage: response.usage, decisions };
}

/**
 * Optional KARTA factory. No global agent registration, environment lookup, new router
 * or ledger. Host callbacks are mandatory; strings/flags in model arguments never grant
 * permission. Typed judgments remain data and are never executed as actions here.
 */
export function createJevJudgmentTool(options: JevToolOptions = {}): ToolDefinition<JevRequest, JevToolResult> {
  const { enabled = false, apiKey, authorizeAndReserve, settle, fetchImpl, now = Date.now } = options;
  return {
    name: "jev_judgment",
    description: "Propose des jugements structurés Jev sur du texte autorisé : choix, score ou oui/non. Peut s'abstenir. Ne prouve pas leur exactitude et n'autorise ni dépense ni action métier.",
    sensitive: true,
    tracePolicy: "metadata_only",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", minLength: 1, maxLength: 32768 },
        questions: { type: "object", minProperties: 1, maxProperties: 16, description: "Questions Jev : type noul/choice/score, instructions et critères. Le serveur valide le contrat complet et sa qualification." },
      },
      required: ["state", "questions"],
      additionalProperties: false,
    },
    async execute(params, ctx) {
      if (enabled !== true) return unavailable("disabled");
      // eslint-disable-next-line no-control-regex -- Reject whitespace and control bytes in provider credentials.
      if (typeof apiKey !== "string" || !apiKey.trim() || /[\u0000-\u0020\u007f]/u.test(apiKey) ||
          typeof authorizeAndReserve !== "function" || typeof settle !== "function" || typeof now !== "function") {
        return unavailable("not_configured");
      }
      if (ctx?.mode === "simulation") return unavailable("simulation");
      if (ctx?.mode !== "live" || typeof ctx.userId !== "string" || !ctx.userId.trim() || ctx.userId.length > 200 ||
          typeof ctx.agentType !== "string" || !ctx.agentType || typeof ctx.operationId !== "string" ||
          !ctx.operationId.trim() || ctx.operationId.length > 200) return unavailable("invalid_context");

      let request: JevRequest;
      try { request = freezeJson(validateJevRequest(params)); }
      catch { return unavailable("invalid_request"); }
      const admission: Readonly<JevAdmissionRequest> = Object.freeze({
        userId: ctx.userId, agentType: ctx.agentType, operationId: ctx.operationId, model: JEV_MODEL, request,
        requestHash: createHash("sha256").update(JSON.stringify({ model: JEV_MODEL, ...request })).digest("hex"),
      });
      const controller = new AbortController();
      let deadlineReached = false;
      const timer = setTimeout(() => { deadlineReached = true; controller.abort(); }, JEV_TOOL_TIMEOUT_MS);
      let leaseTimer: ReturnType<typeof setTimeout> | undefined;
      let permit: JevPermit | undefined;
      let providerAttempted = false;
      let response: JevResponse | undefined;
      let result: JevToolResult = unavailable("admission_unavailable");
      try {
        const supplied = await bounded(Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return authorizeAndReserve(admission, controller.signal);
        }), controller.signal);
        controller.signal.throwIfAborted();
        if (!supplied) result = unavailable("not_authorized");
        else if (!validPermit(supplied, admission)) result = unavailable("invalid_permit");
        else {
          // Copy trusted policy values before awaited network work; retain only its signal.
          permit = Object.freeze({ ...supplied, thresholds: freezeJson(structuredClone(supplied.thresholds)) });
          const remaining = permit.validUntilMs - now();
          if (!Number.isFinite(remaining) || remaining <= 0) result = unavailable("authorization_expired");
          else {
            leaseTimer = setTimeout(() => controller.abort(), Math.min(remaining, JEV_TOOL_TIMEOUT_MS));
            const signal = AbortSignal.any([controller.signal, permit.signal]);
            signal.throwIfAborted();
            providerAttempted = true;
            response = await bounded(requestJev(request, { apiKey, signal, fetchImpl }), signal);
            signal.throwIfAborted();
            const completedAt = now();
            result = !Number.isFinite(completedAt) || completedAt >= permit.validUntilMs
              ? unavailable("authorization_expired", true, true) : decisionsFor(response, permit);
          }
        }
      } catch (error) {
        if (error instanceof JevTransportError) providerAttempted = error.attempted;
        const reason: JevFailureReason = deadlineReached ? "deadline" : controller.signal.aborted || permit?.signal.aborted
          ? "cancelled" : error instanceof JevTransportError ? error.code : permit ? "provider_unavailable" : "admission_unavailable";
        result = unavailable(reason, providerAttempted, Boolean(response));
      } finally {
        clearTimeout(timer);
        clearTimeout(leaseTimer);
      }

      if (permit) {
        const cleanup = new AbortController();
        const cleanupTimer = setTimeout(() => cleanup.abort(), JEV_SETTLEMENT_TIMEOUT_MS);
        const receipt: Readonly<JevReceipt> = Object.freeze({
          providerAttempted, usageKnown: Boolean(response), ...(response ? { usage: Object.freeze({ ...response.usage }) } : {}),
          outcome: response ? "received" : providerAttempted ? "failed" : "not_dispatched",
        });
        try {
          await bounded(Promise.resolve().then(() => settle(admission, permit!, receipt, cleanup.signal)), cleanup.signal);
        } catch { result = unavailable("accounting_unconfirmed", providerAttempted, Boolean(response)); }
        finally { clearTimeout(cleanupTimer); }
      }
      // Reconciliation is awaited too: a revoked/expired lease must not expose a
      // still-actionable candidate merely because the provider finished earlier.
      if (result.ok && permit) {
        try {
          const finishedAt = now();
          if (permit.signal.aborted) result = unavailable("cancelled", providerAttempted, Boolean(response));
          else if (!Number.isFinite(finishedAt) || finishedAt >= permit.validUntilMs) {
            result = unavailable("authorization_expired", providerAttempted, Boolean(response));
          }
        } catch { result = unavailable("invalid_permit", providerAttempted, Boolean(response)); }
      }
      return result;
    },
  };
}
