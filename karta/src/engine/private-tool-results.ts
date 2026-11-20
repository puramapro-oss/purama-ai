import { isProxy } from "node:util/types";
import { supabase } from "../db/supabase.js";
import { QUANTUM_LIMITS } from "../quantum/simulator.js";
import { bounded } from "../runtime/lifecycle.js";

export type PrivateToolResultName = "knowledge_search" | "quantum_simulate";
export interface PrivateToolResultSource {
  source: "crossref" | "wikidata";
  native_id: string;
  label: string;
  url: string;
  retrieved_at: string;
}
export interface PrivateToolResultPayload {
  schema_version: 1;
  tool_name: PrivateToolResultName;
  status: "complete" | "empty" | "partial" | "failed";
  summary: string;
  sources: PrivateToolResultSource[];
  details: Record<string, unknown>;
}
export interface PersistPrivateToolResultInput {
  userId: string;
  agentType: string;
  runId: string;
  operationId: string;
  toolName: string;
  result: unknown;
}
export type PersistPrivateToolResultOutcome =
  | { status: "stored"; id: string }
  | { status: "not_applicable" }
  | { status: "unavailable" };

export const PRIVATE_TOOL_RESULT_MAX_BYTES = 65_536;
// Ten provider-bounded notices can contain >128 KiB of UTF-8 metadata before
// preview clipping (BMP text uses up to three bytes per UTF-16 unit). Inspect
// at most 512 KiB of strings/keys; the persisted projection still has a separate
// 64 KiB limit below and in PostgreSQL, including its JSONB rendering overhead.
const MAX_TOOL_SNAPSHOT_BYTES = 524_288;
const INVALID_RESULT = "Résultat privé indisponible : format ou identité non vérifiable.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const names: readonly string[] = ["knowledge_search", "quantum_simulate"];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
const invalid = (): never => { throw new Error(INVALID_RESULT); };

/** Snapshot inert JSON without invoking accessors, proxies or toJSON methods. */
function snapshot(value: unknown): Json {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): Json => {
    if (++nodes > 10_000 || depth > 10) return invalid();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : invalid();
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8");
      if (bytes > MAX_TOOL_SNAPSHOT_BYTES || item.includes("\u0000")) return invalid();
      return item;
    }
    if (typeof item !== "object" || isProxy(item) || seen.has(item)) return invalid();
    seen.add(item);
    try {
      const prototype = Object.getPrototypeOf(item);
      if (Array.isArray(item)) {
        if (prototype !== Array.prototype) return invalid();
        const length = Object.getOwnPropertyDescriptor(item, "length")?.value as unknown;
        if (typeof length !== "number" || !Number.isInteger(length) || length > 2048 ||
            Reflect.ownKeys(item).length !== length + 1) return invalid();
        return Array.from({ length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
          return visit(descriptor.value, depth + 1);
        });
      }
      if (prototype !== Object.prototype && prototype !== null) return invalid();
      const keys = Reflect.ownKeys(item);
      if (keys.length > 2048) return invalid();
      const output: Obj = Object.create(null);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) return invalid();
        bytes += Buffer.byteLength(key, "utf8");
        if (bytes > MAX_TOOL_SNAPSHOT_BYTES) return invalid();
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally { seen.delete(item); }
  };
  return visit(value, 0);
}

function object(value: Json | undefined): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : invalid();
}
function array(value: Json | undefined, max: number): Json[] {
  return Array.isArray(value) && value.length <= max ? value : invalid();
}
function textValue(value: Json | undefined, max = 8192): string {
  return typeof value === "string" && value.length <= max ? value : invalid();
}
function integer(value: Json | undefined, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : invalid();
}
function choice<const T extends string>(value: Json | undefined, values: readonly T[]): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : invalid();
}
function date(value: Json | undefined): string {
  const s = textValue(value, 32);
  const parsed = new Date(s);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === s ? s : invalid();
}
function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let prefix = value.slice(0, limit - 1);
  // Keep the browser's UTF-16 length bound without splitting a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + "…";
}

function projectKnowledge(raw: Obj): PrivateToolResultPayload | null {
  const status = choice(raw.status, ["complete", "empty", "partial", "failed", "not_executed"]);
  if (status === "not_executed") return null;
  const evidence = object(raw.evidence);
  if (evidence.schema_version !== 1 || evidence.scope !== "selected_public_sources" ||
      evidence.content_kind !== "metadata_only" || evidence.verification_status !== "unverified" ||
      evidence.source_text_trust !== "untrusted_data" || evidence.page_read_by_karta !== false ||
      evidence.full_text_retrieved !== false) return invalid();
  const retrievalId = textValue(evidence.retrieval_id, 36);
  if (!UUID.test(retrievalId)) return invalid();
  const selected = array(evidence.selected_sources, 2).map(value => choice(value, ["crossref", "wikidata"]));
  if (selected.length === 0 || new Set(selected).size !== selected.length) return invalid();
  const outcomes = array(evidence.sources, 2).map(value => {
    const source = object(value);
    const name = choice(source.source, selected);
    const sourceStatus = choice(source.status, ["ok", "empty", "busy", "rate_limited", "unavailable", "invalid_response", "timeout"]);
    return {
      source: name, status: sourceStatus,
      result_count: integer(source.result_count, 0, 5),
      duplicate_results_removed: integer(source.duplicate_results_removed, 0, 5),
      retrieved_at: source.retrieved_at === null ? null : date(source.retrieved_at),
      ...(source.retry_after_ms === undefined ? {} : { retry_after_ms: integer(source.retry_after_ms, 0, Number.MAX_SAFE_INTEGER) }),
    };
  });
  if (outcomes.length !== selected.length || new Set(outcomes.map(item => item.source)).size !== selected.length) return invalid();
  const sources: PrivateToolResultSource[] = [];
  let truncated = false;
  const records = array(raw.results, 10).map((value, index) => {
    const hit = object(value);
    const source = choice(hit.source, selected);
    const nativeId = textValue(hit.native_id, 512);
    let url: string;
    if (source === "crossref") {
      // DOI syntax is checked before rebuilding the only allowed destination.
      // eslint-disable-next-line no-control-regex -- reject control characters in identifiers.
      if (!/^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/i.test(nativeId) ||
          hit.canonical_id !== `doi:${nativeId.toLowerCase()}` || hit.metadata_license !== null) return invalid();
      url = `https://doi.org/${nativeId.toLowerCase().split("/").map(encodeURIComponent).join("/")}`;
    } else {
      if (!/^Q[1-9]\d{0,19}$/.test(nativeId) || hit.canonical_id !== `wikidata:${nativeId}` ||
          hit.metadata_license !== "CC0-1.0") return invalid();
      url = `https://www.wikidata.org/wiki/${nativeId}`;
    }
    if (hit.url !== url || hit.content_license !== null) return invalid();
    const title = textValue(hit.title, 4096);
    if (!title.trim()) return invalid();
    const description = textValue(hit.text, 8192);
    const label = clip(title, 256);
    const excerpt = clip(description, 512);
    truncated ||= label !== title || excerpt !== description;
    const ranks = array(hit.provider_ranks, 5).map(value => integer(value, 1, 5));
    if (!ranks.length) return invalid();
    const language = hit.language === null ? null : textValue(hit.language, 32);
    const published = hit.provider_published_date === null ? null : textValue(hit.provider_published_date, 10);
    if (published !== null && !/^\d{4}(?:-\d{2}){0,2}$/.test(published)) return invalid();
    sources.push({ source, native_id: nativeId, label, url, retrieved_at: date(hit.retrieved_at) });
    return {
      source_index: index, excerpt, language, provider_published_date: published,
      metadata_license: hit.metadata_license, content_license: null, provider_ranks: ranks,
    };
  });
  for (const outcome of outcomes) {
    if (sources.filter(source => source.source === outcome.source).length !== outcome.result_count ||
        ((outcome.status === "ok") !== (outcome.result_count > 0)) ||
        ((outcome.status === "ok" || outcome.status === "empty") !== (outcome.retrieved_at !== null)) ||
        sources.some(source => source.source === outcome.source && source.retrieved_at !== outcome.retrieved_at)) return invalid();
  }
  const allAnswered = outcomes.every(outcome => outcome.status === "ok" || outcome.status === "empty");
  const someAnswered = outcomes.some(outcome => outcome.status === "ok" || outcome.status === "empty");
  if (raw.ok !== (status === "complete" || status === "empty") ||
      (status === "complete" && (!allAnswered || !records.length)) ||
      (status === "empty" && (!allAnswered || records.length !== 0)) ||
      (status === "partial" && (allAnswered || !someAnswered)) ||
      (status === "failed" && (someAnswered || records.length !== 0))) return invalid();
  const introduction = status === "complete" ? "Recherche publique complète" : status === "empty" ? "Recherche publique sans résultat"
    : status === "partial" ? "Recherche publique partielle" : "Recherche publique en échec";
  const summary = `${introduction} : ${records.length} notice(s). Métadonnées non vérifiées ; aucun texte intégral lu.\n` +
    outcomes.map(outcome => `${outcome.source} : ${outcome.status} (${outcome.result_count}).`).join("\n") +
    (sources.length ? "\n" + sources.map((source, index) => `[${index + 1}] ${clip(source.label, 180)} — ${source.source}, ${clip(source.native_id, 100)}`).join("\n") : "") +
    (truncated ? "\nCertains libellés ou extraits sont abrégés dans ce résultat conservé." : "");
  return {
    schema_version: 1, tool_name: "knowledge_search", status, summary, sources,
    details: {
      retrieval_id: retrievalId, scope: "selected_public_sources", content_kind: "metadata_only",
      verification_status: "unverified", source_text_trust: "untrusted_data", page_read_by_karta: false,
      full_text_retrieved: false, requested_language: choice(evidence.requested_language, ["fr", "en"]),
      selected_sources: selected, source_outcomes: outcomes, records, metadata_truncated: truncated,
    },
  };
}

function projectQuantum(raw: Obj): PrivateToolResultPayload | null {
  if (raw.karta_execution_mode === "simulation") return null;
  if (raw.karta_execution_mode !== "live" || raw.execution_kind !== "local_simulator" ||
      raw.backend_kind !== "classical_statevector" || raw.physical_quantum_hardware !== false ||
      raw.quantum_advantage_demonstrated !== false || raw.external_api_calls !== 0) return invalid();
  const qubits = integer(raw.qubits, 1, QUANTUM_LIMITS.max_qubits);
  const gateCount = integer(raw.gate_count, 0, QUANTUM_LIMITS.max_gates);
  const shots = integer(raw.shots, 0, QUANTUM_LIMITS.max_shots);
  const seed = integer(raw.seed, 0, 0xffff_ffff);
  const probabilities = array(raw.probabilities, 2 ** QUANTUM_LIMITS.max_qubits).map(value =>
    typeof value === "number" && value >= 0 && value <= 1 ? value : invalid());
  if (probabilities.length !== 2 ** qubits || Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) > 1e-8) return invalid();
  const counts: Record<string, number> = Object.create(null);
  for (const [state, count] of Object.entries(object(raw.counts))) {
    if (state.length !== qubits || !/^[01]+$/.test(state)) return invalid();
    counts[state] = integer(count, 1, shots);
  }
  if (Object.values(counts).reduce((sum, value) => sum + value, 0) !== shots) return invalid();
  if (typeof raw.state_norm_squared !== "number" || Math.abs(raw.state_norm_squared - 1) > 1e-8 ||
      typeof raw.input_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.input_sha256)) return invalid();
  const provenance = object(raw.provenance);
  const expected = {
    implementation: "purama-karta-statevector", implementation_version: "1", arithmetic: "float64_complex",
    initial_state: "all_zero", bit_order: "q0_least_significant", measurement: "final_computational_basis",
    sampling: "mulberry32_noncryptographic", input_hash_format: "sha256_canonical_validated_json_v1",
  };
  if (Object.entries(expected).some(([key, value]) => provenance[key] !== value) ||
      Object.entries(QUANTUM_LIMITS).some(([key, value]) => object(provenance.limits)[key] !== value)) return invalid();
  const ranked = probabilities.map((probability, state) => ({ probability, state })).filter(item => item.probability > 0)
    .sort((left, right) => right.probability - left.probability || left.state - right.state);
  const preview = ranked.slice(0, 16).map(item => `${item.state.toString(2).padStart(qubits, "0")} : p=${item.probability.toPrecision(8)}`).join("\n");
  return {
    schema_version: 1, tool_name: "quantum_simulate", status: "complete", sources: [],
    summary: `Simulation locale sur processeur classique : ${qubits} qubit(s), ${gateCount} porte(s), ${shots} mesure(s) simulée(s). Aucun QPU ni avantage quantique démontré.\n${preview}` +
      (ranked.length > 16 ? `\n16 états affichés sur ${ranked.length} états de probabilité non nulle ; détail complet conservé.` : ""),
    details: {
      execution_kind: "local_simulator", backend_kind: "classical_statevector", physical_quantum_hardware: false,
      quantum_advantage_demonstrated: false, external_api_calls: 0, qubits, gate_count: gateCount, shots, seed,
      probabilities, counts, state_norm_squared: raw.state_norm_squared, input_sha256: raw.input_sha256,
      provenance: { ...expected, limits: { ...QUANTUM_LIMITS } },
    },
  };
}

/** A private product result, never a trace or a memory entry. Unknown tools are ignored. */
export function projectPrivateToolResult(toolName: string, result: unknown): PrivateToolResultPayload | null {
  if (!names.includes(toolName)) return null;
  try {
    const raw = object(snapshot(result));
    const projected = toolName === "knowledge_search" ? projectKnowledge(raw) : projectQuantum(raw);
    // PostgreSQL JSONB renders additional separators. The projected structures
    // have fewer than 3,000 entries; reserve 4 KiB below its 64 KiB text bound.
    if (projected && (projected.summary.length > 4000 ||
        Buffer.byteLength(JSON.stringify(projected), "utf8") > PRIVATE_TOOL_RESULT_MAX_BYTES - 4096)) return invalid();
    return projected;
  } catch { return invalid(); }
}

/**
 * At most two identical RPC attempts within one deadline. A lost reply can be
 * reconciled without running the tool again. No provider/SQL detail escapes.
 */
export async function persistPrivateToolResult(input: PersistPrivateToolResultInput): Promise<PersistPrivateToolResultOutcome> {
  try {
    if (!names.includes(input.toolName) || !input.agentType.startsWith("custom:")) return { status: "not_applicable" };
    const agentId = input.agentType.slice("custom:".length);
    if (![input.userId, input.runId, agentId].every(value => UUID.test(value))) return { status: "unavailable" };
    const runId = input.runId.toLowerCase();
    const operationId = input.operationId.toLowerCase();
    if (operationId !== input.operationId || !(UUID.test(operationId) ||
        operationId.startsWith(runId + ":") && /^(0|[1-9]\d{0,3})$/.test(operationId.slice(runId.length + 1)))) return { status: "unavailable" };
    const payload = projectPrivateToolResult(input.toolName, input.result);
    if (!payload) return { status: "not_applicable" };
    const args = {
      p_user_id: input.userId.toLowerCase(), p_agent_type: `custom:${agentId.toLowerCase()}`,
      p_run_id: runId, p_operation_id: operationId, p_tool_name: input.toolName, p_payload: payload,
    };
    return await bounded(async signal => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await supabase.rpc("karta_store_tool_result", args).abortSignal(signal);
          if (!response.error && typeof response.data === "string" && UUID.test(response.data)) {
            return { status: "stored" as const, id: response.data };
          }
          // A confirmed database refusal is not an uncertain acknowledgement.
          if (response.error?.code === "P0001" || response.error?.code === "42501" || response.error?.code === "42883") break;
        } catch { /* bounded reconciliation of this same server-owned payload */ }
        if (signal.aborted) break;
      }
      return { status: "unavailable" as const };
    }, 5000);
  } catch { return { status: "unavailable" }; }
}
