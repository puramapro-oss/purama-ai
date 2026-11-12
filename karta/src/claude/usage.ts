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
