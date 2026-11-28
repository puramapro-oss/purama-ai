import { createHmac, timingSafeEqual } from "node:crypto";
import { createProviderDeadline, requestProviderJson } from "../tools/provider-http.js";

/** Server-only configuration. No permanent credential is included in call variables. */
export interface PhoneConfig {
  enabled: boolean;
  apiKey: string;
  agentId: string;
  webhookSecret: string;
  webhookUrl: string;
}

export interface PhoneCommandContext {
  occurrenceId: string;
  token: string;
  expiresAt: string;
}

export interface PhoneCallInput {
  occurrenceId: string;
  routineId: string;
  phoneNumber: string;
  briefing: string;
  instruction?: string;
  maxDurationMinutes?: number;
  /** Short-lived capture capability; the host still owns identity and approval. */
  commandContext?: PhoneCommandContext;
}

export type PhoneCallStatus = "accepted" | "completed" | "failed" | "unknown";
export type PhoneAnsweredBy = "human" | "voicemail" | "unknown" | "no-answer";
export interface PhoneCallReceipt {
  callId: string;
  externalId: string;
  status: PhoneCallStatus;
  answeredBy?: PhoneAnsweredBy;
  /** Provider transcript, not an instruction or proof of user authorization. */
  transcript?: string;
  transcriptTruncated?: true;
}

export type PhoneProviderErrorCode =
  | "PHONE_PROVIDER_DISABLED"
  | "PHONE_PROVIDER_UNCONFIGURED"
  | "PHONE_INPUT_INVALID"
  | "PHONE_PROVIDER_UNCONFIRMED";

const ERROR_MESSAGES: Record<PhoneProviderErrorCode, string> = {
  PHONE_PROVIDER_DISABLED: "Les appels téléphoniques sont désactivés.",
  PHONE_PROVIDER_UNCONFIGURED: "La téléphonie doit être configurée avant tout appel.",
  PHONE_INPUT_INVALID: "Les paramètres de l’appel sont invalides.",
  PHONE_PROVIDER_UNCONFIRMED: "Le résultat du fournisseur téléphonique reste à vérifier.",
};

export class PhoneProviderError extends Error {
  readonly code: PhoneProviderErrorCode;
  /** unknown never permits automatic resubmission of an outbound call. */
  readonly outcome: "not_sent" | "unknown";

  constructor(code: PhoneProviderErrorCode, outcome: "not_sent" | "unknown") {
    super(ERROR_MESSAGES[code]);
    this.name = "PhoneProviderError";
    this.code = code;
    this.outcome = outcome;
  }
}

export interface PhoneProvider {
  startPhoneCall(input: PhoneCallInput): Promise<PhoneCallReceipt>;
  lookupPhoneCall(id: string): Promise<PhoneCallReceipt>;
}

const API = "https://api.bland.ai/v1/calls";
export const PHONE_PROVIDER_TIMEOUT_MS = 10_000;
export const PHONE_TRANSCRIPT_MAX_CHARS = 16_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[\x21-\x7e]{1,256}$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const FAILED = new Set(["failed", "busy", "no-answer", "canceled"]);
const PENDING = new Set(["new", "queued", "allocated", "started"]);
const ANSWERED_BY = new Set<PhoneAnsweredBy>(["human", "voicemail", "unknown", "no-answer"]);
const LOOKUP_FIELDS = [
  "call_id", "external_id", "status", "completed", "queue_status", "answered_by", "concatenated_transcript", "metadata",
].join(",");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
}

function assertReady(config: PhoneConfig, readOnly = false): void {
  if (!readOnly && config.enabled !== true) throw new PhoneProviderError("PHONE_PROVIDER_DISABLED", "not_sent");
  let validWebhook = false;
  try {
    const url = new URL(config.webhookUrl);
    validWebhook = url.protocol === "https:" && !url.username && !url.password && !url.hash && config.webhookUrl.length <= 2048;
  } catch { /* An invalid public callback cannot receive a verifiable receipt. */ }
  if (!validText(config.apiKey, 4096) || /[\r\n]/.test(config.apiKey) ||
    !UUID.test(config.agentId) || !validText(config.webhookSecret, 4096) || !validWebhook) {
    throw new PhoneProviderError("PHONE_PROVIDER_UNCONFIGURED", "not_sent");
  }
}

function parseInput(input: PhoneCallInput): PhoneCallInput & { instruction: string; maxDurationMinutes: number } {
  const duration = input?.maxDurationMinutes ?? 2;
  const instruction = input?.instruction ?? "Présente le bilan et recueille les demandes de l’utilisateur sans annoncer leur exécution.";
  if (!input || typeof input.occurrenceId !== "string" || !IDENTIFIER.test(input.occurrenceId) ||
    typeof input.routineId !== "string" || !IDENTIFIER.test(input.routineId) ||
    typeof input.phoneNumber !== "string" || !E164.test(input.phoneNumber) ||
    !validText(input.briefing, 16_000) || !validText(instruction, 8_000) || [...instruction].length > 4_000 ||
    !Number.isSafeInteger(duration) || duration < 1 || duration > 10) {
    throw new PhoneProviderError("PHONE_INPUT_INVALID", "not_sent");
  }
  let commandContext: PhoneCommandContext | undefined;
  if (input.commandContext !== undefined) {
    const context = input.commandContext;
    const expiry = isRecord(context) && typeof context.expiresAt === "string" ? Date.parse(context.expiresAt) : Number.NaN;
    if (!isRecord(context) || context.occurrenceId !== input.occurrenceId ||
      typeof context.token !== "string" || !/^[0-9a-f]{64}$/i.test(context.token) ||
      !Number.isFinite(expiry) || expiry <= Date.now() || new Date(expiry).toISOString() !== context.expiresAt) {
      throw new PhoneProviderError("PHONE_INPUT_INVALID", "not_sent");
    }
    commandContext = { occurrenceId: context.occurrenceId, token: context.token, expiresAt: context.expiresAt };
  }
  // Snapshot before the first await. Another caller cannot change this request.
  return { occurrenceId: input.occurrenceId, routineId: input.routineId, phoneNumber: input.phoneNumber,
    briefing: input.briefing, instruction, maxDurationMinutes: duration, ...(commandContext ? { commandContext } : {}) };
}

function unconfirmed(): never {
  throw new PhoneProviderError("PHONE_PROVIDER_UNCONFIRMED", "unknown");
}

function normalizeLookup(body: unknown, requestedId: string): PhoneCallReceipt {
  if (!isRecord(body) || typeof body.call_id !== "string" || !UUID.test(body.call_id) ||
    typeof body.external_id !== "string" || !IDENTIFIER.test(body.external_id) ||
    (body.call_id !== requestedId && body.external_id !== requestedId)) return unconfirmed();
  // A conflicting metadata association must not resolve another occurrence.
  if (isRecord(body.metadata) && body.metadata.occurrence_id !== undefined &&
    body.metadata.occurrence_id !== body.external_id) return unconfirmed();
  let status: PhoneCallStatus = "unknown";
  if (body.status === "completed" && body.completed !== false) status = "completed";
  else if (typeof body.status === "string" && FAILED.has(body.status)) status = "failed";
  else if ((body.status === undefined || body.status === null) && body.completed !== true &&
    typeof body.queue_status === "string" && PENDING.has(body.queue_status)) status = "accepted";
  const receipt: PhoneCallReceipt = { callId: body.call_id, externalId: body.external_id, status };
  if (typeof body.answered_by === "string") {
    receipt.answeredBy = ANSWERED_BY.has(body.answered_by as PhoneAnsweredBy) ? body.answered_by as PhoneAnsweredBy : "unknown";
  }
  if (typeof body.concatenated_transcript === "string" && body.concatenated_transcript.length > 0) {
    receipt.transcript = body.concatenated_transcript.slice(0, PHONE_TRANSCRIPT_MAX_CHARS);
    if (body.concatenated_transcript.length > PHONE_TRANSCRIPT_MAX_CHARS) receipt.transcriptTruncated = true;
  }
  return receipt;
}

/**
 * HTTP-only adapter; KARTA owns scheduling, durable dispatch claims and consent.
 * Bland external_id is a lookup key, not an idempotency guarantee. Every POST
 * after a transport error may duplicate a real call and must be reconciled first.
 */
export function createPhoneProvider(configuration: PhoneConfig): PhoneProvider {
  const config = Object.freeze({ ...configuration });
  const headers = () => ({ authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" });
  return {
    async startPhoneCall(candidate: PhoneCallInput): Promise<PhoneCallReceipt> {
      assertReady(config);
      const input = parseInput(candidate);
      const deadline = createProviderDeadline(PHONE_PROVIDER_TIMEOUT_MS, "Délai de vérification téléphonique dépassé");
      try {
        const result = await requestProviderJson(API, {
          method: "POST", headers: headers(),
          body: JSON.stringify({
            phone_number: input.phoneNumber,
            agent_id: config.agentId,
            agent_version: "production",
            language: "fr",
            max_duration: input.maxDurationMinutes,
            record: false,
            block_interruptions: false,
            voicemail: { action: "hangup" },
            external_id: input.occurrenceId,
            metadata: { occurrence_id: input.occurrenceId, routine_id: input.routineId },
            request_data: { briefing: input.briefing, occurrence_id: input.occurrenceId,
              routine_id: input.routineId, instruction: input.instruction,
              ...(input.commandContext ? {
                command_occurrence_id: input.commandContext.occurrenceId,
                command_token: input.commandContext.token,
                command_expires_at: input.commandContext.expiresAt,
              } : {}),
            },
            webhook: config.webhookUrl,
          }),
        }, deadline, 16 * 1024);
        if (!isRecord(result) || result.status !== "success" || typeof result.call_id !== "string" ||
          !UUID.test(result.call_id) || (result.external_id !== undefined && result.external_id !== input.occurrenceId)) return unconfirmed();
        return { callId: result.call_id, externalId: input.occurrenceId, status: "accepted" };
      } catch { return unconfirmed(); }
      finally { deadline.close(); }
    },
    async lookupPhoneCall(id: string): Promise<PhoneCallReceipt> {
      // Stopping new calls must not prevent reconciliation of a prior effect.
      assertReady(config, true);
      if (typeof id !== "string" || !IDENTIFIER.test(id)) throw new PhoneProviderError("PHONE_INPUT_INVALID", "not_sent");
      const deadline = createProviderDeadline(PHONE_PROVIDER_TIMEOUT_MS, "Délai de vérification téléphonique dépassé");
      try {
        const url = `${API}/${encodeURIComponent(id)}?fields=${encodeURIComponent(LOOKUP_FIELDS)}`;
        const result = await requestProviderJson(url, { method: "GET", headers: headers() }, deadline, 256 * 1024);
        return normalizeLookup(result, id);
      } catch { return unconfirmed(); }
      finally { deadline.close(); }
    },
  };
}

/** Signature only. The HTTP boundary owns body limits; the store owns replay protection. */
export function verifyPhoneWebhook(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!Buffer.isBuffer(raw) || typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature) ||
    !validText(secret, 4096)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(expected, received);
}
