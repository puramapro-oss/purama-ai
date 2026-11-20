import { randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";

export type KnowledgeSource = "crossref" | "wikidata";
export type KnowledgeSearchParams = {
  query: string;
  sources: KnowledgeSource[];
  limit?: number;
  language?: "fr" | "en";
};
export type KnowledgeRequest = Readonly<{
  query: string;
  sources: readonly KnowledgeSource[];
  limit: number;
  language: "fr" | "en";
}>;

export type KnowledgeHit = {
  source: KnowledgeSource;
  native_id: string;
  canonical_id: string;
  url: string;
  title: string;
  text: string;
  language: string | null;
  provider_published_date: string | null;
  retrieved_at: string;
  metadata_license: "CC0-1.0" | null;
  content_license: null;
  provider_ranks: number[];
};
type SourceStatus = "ok" | "empty" | "busy" | "rate_limited" | "unavailable" | "invalid_response" | "timeout" | "not_executed";
export type KnowledgeSourceOutcome = {
  source: KnowledgeSource;
  status: SourceStatus;
  result_count: number;
  duplicate_results_removed: number;
  retrieved_at: string | null;
  retry_after_ms?: number;
};
export type KnowledgeSearchResult = {
  ok: boolean;
  status: "complete" | "empty" | "partial" | "failed" | "not_executed";
  message: string;
  evidence: {
    schema_version: 1;
    retrieval_id: string;
    scope: "selected_public_sources";
    content_kind: "metadata_only";
    verification_status: "unverified";
    source_text_trust: "untrusted_data";
    page_read_by_karta: false;
    full_text_retrieved: false;
    requested_language: "fr" | "en";
    selected_sources: readonly KnowledgeSource[];
    sources: KnowledgeSourceOutcome[];
  };
  results: KnowledgeHit[];
};

type SearchOptions = {
  /** Server-owned dependencies for tests; never accepted as tool parameters. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  monotonicNow?: () => number;
  wallNow?: () => number;
};
type Gate = { inFlight: boolean; nextAllowedAt: number };
type SourceResult = { outcome: KnowledgeSourceOutcome; results: KnowledgeHit[] };

const MAX_RESPONSE_BYTES = 524_288;
const TIMEOUT_MS = 15_000;
const MIN_INTERVAL_MS: Record<KnowledgeSource, number> = { crossref: 1_100, wikidata: 500 };
const USER_AGENT = "PURAMA-IAO/1.0 (https://github.com/puramapro-oss/purama-ai)";
const PARAMETER_KEYS = new Set(["query", "sources", "limit", "language"]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !isProxy(value) && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** No getters, symbols, custom prototypes, sparse arrays or caller-owned mutable
 * objects reach an await or a network request. The error never echoes input.
 */
export function copyKnowledgeParams(value: unknown): KnowledgeRequest {
  try {
    if (!plainRecord(value)) throw new Error();
    const snapshot: Record<string, unknown> = Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (keys.length > PARAMETER_KEYS.size) throw new Error();
    for (const key of keys) {
      if (typeof key !== "string" || !PARAMETER_KEYS.has(key)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) throw new Error();
      snapshot[key] = descriptor.value;
    }
    if (typeof snapshot.query !== "string" || !snapshot.query.trim() || snapshot.query.length > 1_000
      // eslint-disable-next-line no-control-regex -- Reject control bytes before forming an external query.
      || /[\u0000-\u001f\u007f]/.test(snapshot.query)) throw new Error();
    const rawSources = snapshot.sources;
    if (!Array.isArray(rawSources) || isProxy(rawSources) || Object.getPrototypeOf(rawSources) !== Array.prototype) throw new Error();
    const length: unknown = Object.getOwnPropertyDescriptor(rawSources, "length")?.value;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > 2
      || Reflect.ownKeys(rawSources).length !== length + 1) throw new Error();
    const sources: KnowledgeSource[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(rawSources, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error();
      const source: unknown = descriptor.value;
      if ((source !== "crossref" && source !== "wikidata") || sources.includes(source)) throw new Error();
      sources.push(source);
    }
    const limit = Object.hasOwn(snapshot, "limit") ? snapshot.limit : 3;
    const language = Object.hasOwn(snapshot, "language") ? snapshot.language : "fr";
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 5
      || (language !== "fr" && language !== "en")) throw new Error();
    return Object.freeze({ query: snapshot.query.trim(), sources: Object.freeze(sources), limit, language });
  } catch {
    throw new Error("Paramètres de recherche de connaissances invalides.");
  }
}

class SourceFailure extends Error {
  constructor(readonly status: "rate_limited" | "unavailable" | "invalid_response" | "timeout", readonly retryAfterMs?: number) {
    super("Recherche de connaissances indisponible.");
  }
}

function failResponse(): never { throw new SourceFailure("invalid_response"); }

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maxLength) return failResponse();
  return value.trim() || null;
}

/** Crossref can publish a year alone; never manufacture January 1st. */
function crossrefDate(value: unknown): string | null {
  if (!plainRecord(value) || !Array.isArray(value["date-parts"])) return null;
  const parts: unknown = value["date-parts"][0];
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 3
    || parts.some(part => typeof part !== "number" || !Number.isInteger(part))) return null;
  const [year, month, day] = parts as number[];
  if (year < 1 || year > 9999 || (month !== undefined && (month < 1 || month > 12))) return null;
  const maxDay = month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (day !== undefined && (day < 1 || day > maxDay)) return null;
  return [String(year).padStart(4, "0"), ...(month === undefined ? [] : [String(month).padStart(2, "0")]),
    ...(day === undefined ? [] : [String(day).padStart(2, "0")])].join("-");
}

function crossrefHits(raw: unknown, request: KnowledgeRequest, retrievedAt: string): KnowledgeHit[] {
  if (!plainRecord(raw) || raw.status !== "ok" || Object.hasOwn(raw, "error") || !plainRecord(raw.message)
    || !Array.isArray(raw.message.items) || raw.message.items.length > request.limit) return failResponse();
  return raw.message.items.map((item: unknown, index: number) => {
    if (!plainRecord(item) || typeof item.DOI !== "string" || item.DOI.length > 512
      // eslint-disable-next-line no-control-regex -- DOI validation precedes URL construction.
      || !/^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/i.test(item.DOI)) return failResponse();
    if (item.title !== undefined && (!Array.isArray(item.title) || item.title.length > 20)) return failResponse();
    const titles = (item.title as unknown[] | undefined)?.map(title => optionalText(title, 4_096));
    const title = titles?.find((text): text is string => text !== null) ?? item.DOI;
    const publisher = optionalText(item.publisher, 1_024);
    const type = optionalText(item.type, 128);
    const doi = item.DOI.toLowerCase();
    return {
      source: "crossref", native_id: item.DOI, canonical_id: `doi:${doi}`,
      url: `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`,
      title, text: [title, publisher, type].filter(text => text !== null).join(" — "), language: null,
      provider_published_date: crossrefDate(item.published), retrieved_at: retrievedAt,
      metadata_license: null, content_license: null, provider_ranks: [index + 1],
    };
  });
}

function wikidataHits(raw: unknown, request: KnowledgeRequest, retrievedAt: string): KnowledgeHit[] {
  if (!plainRecord(raw) || raw.success !== 1 || Object.hasOwn(raw, "error") || !Array.isArray(raw.search) || raw.search.length > request.limit) return failResponse();
  return raw.search.map((item: unknown, index: number) => {
    if (!plainRecord(item) || typeof item.id !== "string" || !/^Q[1-9]\d{0,19}$/.test(item.id)) return failResponse();
    const title = optionalText(item.label, 4_096) ?? item.id;
    const description = optionalText(item.description, 4_096);
    const display = plainRecord(item.display) && plainRecord(item.display.label) ? item.display.label : null;
    const language = display && typeof display.language === "string" && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(display.language)
      && display.language.length <= 32 ? display.language : null;
    return {
      source: "wikidata", native_id: item.id, canonical_id: `wikidata:${item.id}`,
      url: `https://www.wikidata.org/wiki/${item.id}`, title, text: description ?? title, language,
      provider_published_date: null, retrieved_at: retrievedAt,
      metadata_license: "CC0-1.0", content_license: null, provider_ranks: [index + 1],
    };
  });
}

/** Only exact metadata duplicates are grouped; conflicting descriptions or
 * publication dates remain visible even when they share an identifier.
 */
function groupExactDuplicates(hits: KnowledgeHit[]): KnowledgeHit[] {
  const groups = new Map<string, KnowledgeHit>();
  for (const hit of hits) {
    const key = JSON.stringify([hit.source, hit.canonical_id, hit.title, hit.text, hit.language, hit.provider_published_date]);
    const previous = groups.get(key);
    if (previous) previous.provider_ranks.push(...hit.provider_ranks);
    else groups.set(key, hit);
  }
  return [...groups.values()];
}

function requestUrl(source: KnowledgeSource, request: KnowledgeRequest): URL {
  if (source === "crossref") {
    const url = new URL("https://api.crossref.org/works");
    url.search = new URLSearchParams({ query: request.query, rows: String(request.limit), select: "DOI,title,URL,published,type,publisher" }).toString();
    return url;
  }
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.search = new URLSearchParams({ action: "wbsearchentities", search: request.query, language: request.language,
    uselang: request.language, type: "item", limit: String(request.limit), format: "json", maxlag: "5" }).toString();
  return url;
}

function retryDelay(value: string | null, wallNow: number): number {
  if (value && value.length <= 128) {
    if (/^\d+$/.test(value)) {
      // A huge provider delay conservatively disables this source for this
      // worker's lifetime rather than overflowing a timer or retrying early.
      return Math.min(Number.MAX_SAFE_INTEGER, Number(value) * 1_000);
    }
    const date = new Date(value);
    if (Number.isFinite(date.getTime()) && date.toUTCString() === value) return Math.max(0, date.getTime() - wallNow);
  }
  return 30_000;
}

function cancelBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort, never expose transport errors */ }
}

function assertActive(signal: AbortSignal, expiresAt: number, now: () => number): void {
  if (signal.aborted || now() >= expiresAt) throw new SourceFailure("timeout");
}

async function boundedJson(response: Response, signal: AbortSignal, expiresAt: number, now: () => number): Promise<unknown> {
  assertActive(signal, expiresAt, now);
  if (!response.body || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return failResponse();
  const declaredBytes = response.headers.get("content-length");
  if (declaredBytes && /^\d+$/.test(declaredBytes) && Number(declaredBytes) > MAX_RESPONSE_BYTES) return failResponse();
  const reader = response.body.getReader();
  const cancel = () => { try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ } };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      assertActive(signal, expiresAt, now);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) return failResponse();
      chunks.push(new Uint8Array(chunk.value));
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    assertActive(signal, expiresAt, now);
    complete = true;
    return value;
  } catch (error) {
    if (error instanceof SourceFailure) throw error;
    throw new SourceFailure("invalid_response");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

/** One instance per worker. This bounds one process, not a multi-worker quota:
 * production scale needs the existing shared admission layer or one egress worker.
 * There is no request cache, persistent store, hidden retry or unbounded queue.
 */
export function createPublicKnowledgeSearch(options: SearchOptions = {}) {
  const transport = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const now = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new Error("Configuration de recherche invalide.");
  const gates: Record<KnowledgeSource, Gate> = {
    crossref: { inFlight: false, nextAllowedAt: 0 }, wikidata: { inFlight: false, nextAllowedAt: 0 },
  };

  async function retrieve(source: KnowledgeSource, request: KnowledgeRequest): Promise<SourceResult> {
    const gate = gates[source];
    const unavailable = (status: SourceStatus, retryAfterMs?: number): SourceResult => ({ results: [], outcome: {
      source, status, result_count: 0, duplicate_results_removed: 0, retrieved_at: null,
      ...(retryAfterMs === undefined ? {} : { retry_after_ms: Math.max(0, Math.ceil(retryAfterMs)) }),
    } });
    if (gate.inFlight) return unavailable("busy");
    if (now() < gate.nextAllowedAt) return unavailable("rate_limited", gate.nextAllowedAt - now());
    gate.inFlight = true;
    const controller = new AbortController();
    const expiresAt = now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new SourceFailure("timeout")); }, timeoutMs);
    });
    const work = async (): Promise<SourceResult> => {
      try {
        assertActive(controller.signal, expiresAt, now);
        const response = await transport(requestUrl(source, request), { method: "GET", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        });
        try {
          // Provider backoff remains relevant even if this fetch settles after
          // the caller's timeout. Preserve only the admission delay; the deadline
          // below still rejects the result before reading any response body.
          const retry = response.status === 429 || response.status === 503
            ? retryDelay(response.headers.get("retry-after"), wallNow()) : undefined;
          if (retry !== undefined) gate.nextAllowedAt = Math.max(gate.nextAllowedAt, now() + retry);
          assertActive(controller.signal, expiresAt, now);
          if (retry !== undefined) throw new SourceFailure("rate_limited", retry);
          if (!response.ok || response.redirected) throw new SourceFailure("unavailable");
          const raw = await boundedJson(response, controller.signal, expiresAt, now);
          assertActive(controller.signal, expiresAt, now);
          if (source === "wikidata" && plainRecord(raw) && plainRecord(raw.error)
            && (raw.error.code === "maxlag" || raw.error.code === "ratelimited")) {
            const retry = retryDelay(response.headers.get("retry-after"), wallNow());
            gate.nextAllowedAt = Math.max(gate.nextAllowedAt, now() + retry);
            throw new SourceFailure("rate_limited", retry);
          }
          const retrievedAt = new Date(wallNow()).toISOString();
          const hits = source === "crossref" ? crossrefHits(raw, request, retrievedAt) : wikidataHits(raw, request, retrievedAt);
          const results = groupExactDuplicates(hits);
          assertActive(controller.signal, expiresAt, now);
          return { results, outcome: { source, status: results.length ? "ok" : "empty", result_count: results.length,
            duplicate_results_removed: hits.length - results.length, retrieved_at: retrievedAt } };
        } finally { cancelBody(response); }
      } finally {
        // The reservation survives a timeout if the transport ignores abort.
        // Releasing it in the outer Promise.race would allow concurrent calls.
        gate.nextAllowedAt = Math.max(gate.nextAllowedAt, now() + MIN_INTERVAL_MS[source]);
        gate.inFlight = false;
      }
    };
    try {
      const result = await Promise.race([work(), deadline]);
      // Promise adoption can cross the deadline before the timer callback is
      // serviced. Recheck at the actual return boundary, not only in work().
      assertActive(controller.signal, expiresAt, now);
      return result;
    } catch (error) {
      controller.abort();
      if (error instanceof SourceFailure) return unavailable(error.status, error.retryAfterMs);
      return unavailable(now() >= expiresAt ? "timeout" : "unavailable");
    } finally { clearTimeout(timer); }
  }

  return async (params: unknown, mode: "live" | "simulation"): Promise<KnowledgeSearchResult> => {
    const request = copyKnowledgeParams(params);
    const results = mode === "live" ? await Promise.all(request.sources.map(source => retrieve(source, request)))
      : request.sources.map(source => ({ results: [], outcome: {
        source, status: "not_executed" as const, result_count: 0, duplicate_results_removed: 0, retrieved_at: null,
      } }));
    const hits = results.flatMap(result => result.results);
    const completed = results.filter(result => result.outcome.status === "ok" || result.outcome.status === "empty").length;
    const ok = completed === request.sources.length;
    const status: KnowledgeSearchResult["status"] = mode !== "live" ? "not_executed"
      : ok ? (hits.length ? "complete" : "empty") : completed > 0 ? "partial" : "failed";
    const message = status === "not_executed" ? "Recherche non exécutée : aucune requête réseau."
      : status === "partial" ? "PARTIEL : certaines sources sont indisponibles ; les métadonnées reçues restent non vérifiées."
        : status === "failed" ? "Recherche indisponible : aucune source demandée n’a répondu avec des métadonnées valides."
          : status === "empty" ? "Recherche terminée sans résultat dans les sources demandées."
            : "Métadonnées reçues des sources demandées ; contenu non vérifié et aucun texte intégral consulté.";
    return { ok, status, message, results: hits, evidence: {
      schema_version: 1, retrieval_id: randomUUID(), scope: "selected_public_sources", content_kind: "metadata_only",
      verification_status: "unverified", source_text_trust: "untrusted_data", page_read_by_karta: false,
      full_text_retrieved: false, requested_language: request.language, selected_sources: request.sources,
      sources: results.map(result => result.outcome),
    } };
  };
}
