import { isProxy } from "node:util/types";

/** Provider-reported counters, not a price estimate or a reconciled invoice. */
export interface ModelUsageReceipt {
  readonly version: 1;
  readonly apiFormat: "anthropic_messages";
  readonly routeKind: "anthropic" | "compatible";
  readonly requestedModel: string | null;
  readonly responseModel: string | null;
  readonly responseId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheCreation5mInputTokens: number | null;
  readonly cacheCreation1hInputTokens: number | null;
}

/** Separate bounds and accounting for a multi-response hosted program. A v1
 * receipt always remains a single provider response, never a synthetic sum. */
export const MAX_PROGRAMMATIC_RESPONSES = 8;
export interface ProgrammaticUsageDetails {
  readonly codeExecutionRequests: number | null;
}
export interface ProgrammaticUsageResponse extends ProgrammaticUsageDetails {
  readonly receipt: ModelUsageReceipt;
}
export interface ProgrammaticUsageEnvelope {
  readonly version: 2;
  readonly apiFormat: "anthropic_messages";
  readonly routeKind: "anthropic";
  readonly responses: readonly ProgrammaticUsageResponse[];
}
export type RunModelUsageEnvelope = ModelUsageReceipt | ProgrammaticUsageEnvelope;

/** Read JSON data only: inherited values and accessors are not provider receipts. */
function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    if (Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    // A malformed object must not manufacture usage or interrupt a decision.
    return undefined;
  }
}

function identifier(value: unknown): string | null {
  // Checking forbidden characters also rejects a final newline, which `$` in
  // a JavaScript regular expression would otherwise permit before string end.
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9_.:/-]/.test(value)
    ? value : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : null;
}

/**
 * Keep a bounded, immutable metadata receipt without reading response content,
 * headers or the configured URL into the result. Missing counters stay unknown;
 * an explicitly reported zero remains zero.
 *
 * Cache totals and TTL buckets are independent raw observations. They are not
 * added, repaired or validated as a globally consistent accounting statement.
 */
export function normalizeModelUsage(
  response: unknown,
  requestedModel: string,
  baseURL: string,
): ModelUsageReceipt {
  const usage = ownField(response, "usage");
  const cacheCreation = ownField(usage, "cache_creation");

  return Object.freeze({
    version: 1,
    apiFormat: "anthropic_messages",
    routeKind: baseURL === "https://api.anthropic.com" || baseURL === "https://api.anthropic.com/"
      ? "anthropic" : "compatible",
    requestedModel: identifier(requestedModel),
    responseModel: identifier(ownField(response, "model")),
    responseId: identifier(ownField(response, "id")),
    inputTokens: tokenCount(ownField(usage, "input_tokens")),
    outputTokens: tokenCount(ownField(usage, "output_tokens")),
    cacheReadInputTokens: tokenCount(ownField(usage, "cache_read_input_tokens")),
    cacheCreationInputTokens: tokenCount(ownField(usage, "cache_creation_input_tokens")),
    cacheCreation5mInputTokens: tokenCount(ownField(cacheCreation, "ephemeral_5m_input_tokens")),
    cacheCreation1hInputTokens: tokenCount(ownField(cacheCreation, "ephemeral_1h_input_tokens")),
  });
}

/** Hosted execution requests are additional provider metadata, not dollars or
 * runtime seconds. Missing and malformed counters remain explicitly unknown. */
export function normalizeProgrammaticUsage(response: unknown): ProgrammaticUsageDetails {
  const usage = ownField(response, "usage");
  const serverTools = ownField(usage, "server_tool_use");
  return Object.freeze({ codeExecutionRequests: tokenCount(ownField(serverTools, "code_execution_requests")) });
}

/** Snapshot the complete ordered chain into the existing immutable run log.
 * Only normalized metadata survives; code, prompts and result bodies do not. */
export function programmaticUsageEnvelope(responses: readonly ProgrammaticUsageResponse[]): ProgrammaticUsageEnvelope {
  if (isProxy(responses) || !Array.isArray(responses) || Object.getPrototypeOf(responses) !== Array.prototype
    || responses.length < 1 || responses.length > MAX_PROGRAMMATIC_RESPONSES
    || Reflect.ownKeys(responses).length !== responses.length + 1) {
    throw new Error("Journal de consommation programmatique invalide");
  }
  const snapshot: ProgrammaticUsageResponse[] = [];
  for (let index = 0; index < responses.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(responses, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) || isProxy(descriptor.value)) {
      throw new Error("Journal de consommation programmatique invalide");
    }
    const value: unknown = descriptor.value;
    const receipt = ownField(value, "receipt");
    if (isProxy(receipt) || ownField(receipt, "version") !== 1 || ownField(receipt, "apiFormat") !== "anthropic_messages"
      || ownField(receipt, "routeKind") !== "anthropic") {
      throw new Error("Journal de consommation programmatique invalide");
    }
    const normalized: ModelUsageReceipt = Object.freeze({
      version: 1, apiFormat: "anthropic_messages", routeKind: "anthropic",
      requestedModel: identifier(ownField(receipt, "requestedModel")),
      responseModel: identifier(ownField(receipt, "responseModel")),
      responseId: identifier(ownField(receipt, "responseId")),
      inputTokens: tokenCount(ownField(receipt, "inputTokens")),
      outputTokens: tokenCount(ownField(receipt, "outputTokens")),
      cacheReadInputTokens: tokenCount(ownField(receipt, "cacheReadInputTokens")),
      cacheCreationInputTokens: tokenCount(ownField(receipt, "cacheCreationInputTokens")),
      cacheCreation5mInputTokens: tokenCount(ownField(receipt, "cacheCreation5mInputTokens")),
      cacheCreation1hInputTokens: tokenCount(ownField(receipt, "cacheCreation1hInputTokens")),
    });
    snapshot.push(Object.freeze({ receipt: normalized, codeExecutionRequests: tokenCount(ownField(value, "codeExecutionRequests")) }));
  }
  return Object.freeze({ version: 2, apiFormat: "anthropic_messages", routeKind: "anthropic", responses: Object.freeze(snapshot) });
}
