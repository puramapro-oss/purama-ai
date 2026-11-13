import type { IncomingMessage, ServerResponse } from "node:http";
import { isProxy } from "node:util/types";
import { bounded } from "../runtime/lifecycle.js";
import type { ConsultationCatalog, ConsultationHost, ConsultationInput, ConsultationOperation,
  ConsultationPublicPlan, ConsultationPublicResult } from "./consultation-contract.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$(?![\s\S])/;
const REFLECTIONS = ["auto", "standard", "deep", "maximum"];
const SPEEDS = ["standard", "fast", "ultra_fast"];
const MAX_BODY_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 524_288;
const CALL_TIMEOUT_MS = 135_000;
const UNAVAILABLE_CATALOG: ConsultationCatalog = { available: false, reason: "not_configured", models: [], research: { search: false, scrape: false } };
class WireError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const invalid = (): never => { throw new WireError(400, "IAO_INVALID"); };
const upstream = (): never => { throw new WireError(502, "IAO_INVALID_RESPONSE"); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== "string" || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return upstream();
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || isProxy(value) || value.length > max || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) return upstream();
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i) || !("value" in Object.getOwnPropertyDescriptor(value, i)!)) return upstream();
  return value;
}
function string(value: unknown, max: number, nonempty = true): string {
  return typeof value === "string" && value.length <= max && (!nonempty || value.trim().length > 0) ? value : upstream();
}
function identifier(value: unknown): string { const text = string(value, 200); return IDENTIFIER.test(text) ? text : upstream(); }
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T { return typeof value === "string" && choices.includes(value as T) ? value as T : upstream(); }
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : upstream(); }
function integer(value: unknown, min: number, max: number): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : upstream(); }
function strings(value: unknown, count: number, length: number): string[] { return array(value, count).map(item => string(item, length)); }
function exact(row: Record<string, unknown>, keys: string[]): void { if (Object.keys(row).some(key => !keys.includes(key))) invalid(); }

type Action = { action: "catalog" } | { action: "status" | "cancel"; operationId: string } | ({ action: "consult" } & ConsultationInput);
/** Transport-level bounds; capability, budget and disclosure decisions remain with the host. */
export function parseConsultationAction(value: unknown): Action {
  try {
    const row = record(value);
    const action = oneOf(row.action, ["catalog", "consult", "status", "cancel"] as const);
    if (action === "catalog") { exact(row, ["action"]); return { action }; }
    const operationId = string(row.operationId, 36);
    if (!UUID.test(operationId)) return invalid();
    if (action !== "consult") { exact(row, ["action", "operationId"]); return { action, operationId: operationId.toLowerCase() }; }
    exact(row, ["action", "operationId", "question", "preferences", "reviewerModels", "research"]);
    const preferences = record(row.preferences);
    exact(preferences, ["model", "reflection", "speed"]);
    const input: ConsultationInput = { operationId: operationId.toLowerCase(), question: string(row.question, 8000), preferences: {
      model: identifier(preferences.model),
      ...(preferences.reflection === undefined ? {} : { reflection: oneOf(preferences.reflection, ["auto", "standard", "deep", "maximum"] as const) }),
      ...(preferences.speed === undefined ? {} : { speed: oneOf(preferences.speed, ["standard", "fast", "ultra_fast"] as const) }),
    } };
    if (row.reviewerModels !== undefined) {
      input.reviewerModels = array(row.reviewerModels, 3).map(identifier);
      if (new Set(input.reviewerModels).size !== input.reviewerModels.length || input.reviewerModels.includes(input.preferences.model)) return invalid();
    }
    if (row.research !== undefined) {
      const research = record(row.research); exact(research, ["queries", "urls"]);
      input.research = { queries: strings(research.queries, 3, 2000), urls: strings(research.urls, 6, 8192) };
      for (const url of input.research.urls) {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || /\s/.test(url)) return invalid();
      }
    }
    return { action, ...input };
  } catch { return invalid(); }
}

export function projectConsultationCatalog(value: unknown): ConsultationCatalog {
  const row = record(value); const research = record(row.research);
  const models = array(row.models, 32).map(value => {
    const model = record(value);
    const reflections = array(model.reflections, 4).map(value => oneOf(value, REFLECTIONS));
    const speeds = array(model.speeds, 3).map(value => oneOf(value, SPEEDS));
    if (!reflections.length || !speeds.length || new Set(reflections).size !== reflections.length || new Set(speeds).size !== speeds.length) return upstream();
    const profiles = array(model.profiles, 12).map(value => {
      const profile = record(value);
      const reflection = oneOf(profile.reflection, REFLECTIONS); const speed = oneOf(profile.speed, SPEEDS);
      if (!reflections.includes(reflection) || !speeds.includes(speed)) return upstream();
      return { reflection, speed, research: projectResearch(profile.research) };
    });
    if (!profiles.length || new Set(profiles.map(profile => `${profile.reflection}:${profile.speed}`)).size !== profiles.length) return upstream();
    return { model: identifier(model.model), provider: identifier(model.provider), reflections, speeds,
      maxOutputTokens: integer(model.maxOutputTokens, 1024, 65536), profiles };
  });
  if (new Set(models.map(model => model.model)).size !== models.length) return upstream();
  const available = bool(row.available);
  const reason = oneOf(row.reason, ["ready", "not_configured", "simulation_enabled", "account_unavailable", "budget_unavailable", "model_unavailable", "paused", "service_unavailable"] as const);
  if (available !== (reason === "ready") || (available && models.length === 0)) return upstream();
  return { available, reason, models: models as ConsultationCatalog["models"], research: { search: bool(research.search), scrape: bool(research.scrape) } };
}
function projectResearch(value: unknown): ConsultationPublicPlan["research"] {
  const research = record(value);
  return { maxSearches: integer(research.maxSearches, 0, 3), maxPages: integer(research.maxPages, 0, 6),
    maxReviewers: integer(research.maxReviewers, 0, 3), maxRounds: integer(research.maxRounds, 1, 2), concurrency: integer(research.concurrency, 1, 3) };
}
function projectPlan(value: unknown): ConsultationPublicPlan {
  const row = record(value);
  return { model: identifier(row.model), reflection: oneOf(row.reflection, ["standard", "deep", "maximum"] as const),
    speed: oneOf(row.speed, ["standard", "fast", "ultra_fast"] as const), maxOutputTokens: integer(row.maxOutputTokens, 1024, 65536),
    timeoutMs: integer(row.timeoutMs, 1, 120000), research: projectResearch(row.research) };
}
function projectResult(value: unknown): ConsultationPublicResult {
  const row = record(value); let remaining = 32_000;
  const sources = array(row.sources, 32).map(value => {
    const source = record(value); const url = string(source.url, 8192); const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || /\s/.test(url)) return upstream();
    const retrievedAt = string(source.retrievedAt, 40); if (!Number.isFinite(Date.parse(retrievedAt))) return upstream();
    const full = string(source.text, 200_000, false); const text = full.slice(0, Math.min(2000, remaining)); remaining -= text.length;
    return { id: identifier(source.id), provider: identifier(source.provider), retrievedAt, url, title: string(source.title, 4096, false).slice(0, 512), text,
      contentKind: oneOf(source.contentKind, ["search_excerpt", "page_markdown"] as const),
      verificationStatus: oneOf(source.verificationStatus, ["unverified"] as const),
      truncated: bool(source.truncated) || text.length < full.length || (source.title as string).length > 512 };
  });
  const citedSourceIds = strings(row.citedSourceIds, 32, 200); const ids = sources.map(source => source.id);
  if (new Set(ids).size !== ids.length || new Set(citedSourceIds).size !== citedSourceIds.length || citedSourceIds.some(id => !ids.includes(id))) return upstream();
  const status = oneOf(row.status, ["complete", "partial", "failed", "blocked"] as const);
  const answer = row.answer === null ? null : string(row.answer, 32000);
  if ((status === "complete" || status === "partial") !== (answer !== null)) return upstream();
  return { status, reason: oneOf(row.reason, ["completed", "some_calls_unavailable", "synthesis_unavailable", "already_claimed", "interrupted", "accounting_unavailable"] as const),
    plan: projectPlan(row.plan), answer, citedSourceIds, disagreements: strings(row.disagreements, 32, 2000), uncertainties: strings(row.uncertainties, 32, 2000),
    sources, verificationStatus: oneOf(row.verificationStatus, ["unverified"] as const) };
}
export function projectConsultationOperation(value: unknown, operationId: string): ConsultationOperation {
  const row = record(value); if (row.operationId !== operationId) return upstream();
  const status = oneOf(row.status, ["running", "complete", "partial", "failed", "blocked", "cancelled", "reconciliation_required"] as const);
  const result = row.result === null ? null : projectResult(row.result);
  if ((status === "complete" || status === "partial") && result?.status !== status) return upstream();
  return { operationId, status, cancelRequested: bool(row.cancelRequested), result };
}
function json(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESPONSE_BYTES) return upstream();
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" });
  res.end(encoded);
}
async function readBody(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) throw new WireError(415, "IAO_INVALID");
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new WireError(413, "IAO_TOO_LARGE");
  signal.throwIfAborted();
  // Leaving an IncomingMessage async iterator destroys it. That would turn an
  // intentional 413 into a client-disconnect and prevent a useful response.
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let finished = false;
    const cleanup = () => { req.off("data", data); req.off("end", end); req.off("error", fail); signal.removeEventListener("abort", abort); };
    const fail = (error: unknown) => {
      if (finished) return; finished = true; cleanup();
      // Node can emit ECONNRESET after `aborted`; keep that late stream error
      // handled after cancelling this reader and draining a rejected body.
      req.once("error", () => undefined); req.resume(); reject(error);
    };
    const abort = () => fail(new Error("Request interrupted"));
    const data = (chunk: Buffer | string) => {
      if (signal.aborted) { abort(); return; }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
      if (size > MAX_BODY_BYTES) { fail(new WireError(413, "IAO_TOO_LARGE")); return; }
      chunks.push(bytes);
    };
    const end = () => { if (finished) return; finished = true; cleanup(); resolve(chunks); };
    req.on("data", data); req.once("end", end); req.once("error", fail); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { return invalid(); }
}
const ERRORS: Record<string, { status: number; message: string }> = {
  IAO_INVALID: { status: 400, message: "Demande de consultation invalide." },
  IAO_FORBIDDEN: { status: 403, message: "Consultation non autorisée pour ce compte." },
  IAO_CONFLICT: { status: 409, message: "Cet identifiant appartient déjà à une autre demande." },
  IAO_BUDGET: { status: 429, message: "Budget de consultation indisponible." },
  IAO_UNAVAILABLE: { status: 503, message: "Consultation temporairement indisponible." },
};

/** Called only AFTER the existing administrative authentication. No browser JWT is trusted here. */
export async function handleConsultationRequest(req: IncomingMessage, res: ServerResponse, url: URL,
  createHost: () => Promise<ConsultationHost | null>, ready?: () => Promise<boolean>): Promise<boolean> {
  if (!url.pathname.startsWith("/consultations/")) return false;
  const userId = url.pathname.slice("/consultations/".length);
  if (!UUID.test(userId) || url.search) { json(res, 400, { ok: false, error: "Demande invalide.", code: "IAO_INVALID" }); return true; }
  if (req.method !== "POST") { json(res, 405, { ok: false, error: "Méthode non autorisée.", code: "IAO_METHOD" }); return true; }
  const controller = new AbortController();
  const disconnected = () => controller.abort();
  const closed = () => { if (!res.writableEnded) disconnected(); };
  req.once("aborted", disconnected); res.once("close", closed);
  if (req.aborted || res.destroyed) controller.abort();
  try {
    const bodyExpires = performance.now() + 10_000;
    let raw: unknown;
    try { raw = await bounded(signal => readBody(req, signal), 10_000, controller.signal); }
    catch (error) { if (!controller.signal.aborted && performance.now() >= bodyExpires) throw new WireError(504, "IAO_TIMEOUT"); throw error; }
    const input = parseConsultationAction(raw);
    controller.signal.throwIfAborted();
    const timeoutMs = input.action === "consult" ? CALL_TIMEOUT_MS : 10_000;
    req.setTimeout(timeoutMs + 5000);
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
    try {
      const response = await bounded(async signal => {
        const host = await createHost(); signal.throwIfAborted();
        if (input.action === "catalog") return { ok: true, catalog: projectConsultationCatalog(host ? await host.catalog(userId.toLowerCase(), signal) : UNAVAILABLE_CATALOG) };
        if (!host) throw new WireError(503, "IAO_UNAVAILABLE");
        if (input.action === "consult" && ready && !await ready()) throw new WireError(503, "IAO_UNAVAILABLE");
        signal.throwIfAborted();
        let operation: ConsultationOperation | null;
        if (input.action === "consult") { const { action: _action, ...body } = input; operation = await host.consult(userId.toLowerCase(), body, signal); }
        else operation = await host[input.action](userId.toLowerCase(), input.operationId, signal);
        signal.throwIfAborted();
        if (!operation) throw new WireError(404, "IAO_NOT_FOUND");
        return { ok: true, operation: projectConsultationOperation(operation, input.operationId) };
      }, timeoutMs, controller.signal);
      controller.signal.throwIfAborted();
      json(res, "operation" in response && response.operation?.status === "running" ? 202 : 200, response);
    } catch (error) {
      if (expired) throw new WireError(504, "IAO_TIMEOUT");
      throw error;
    } finally { clearTimeout(timer); }
  } catch (error) {
    if (res.destroyed || res.writableEnded) return true;
    const code = error instanceof WireError ? error.code
      : typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && Object.hasOwn(ERRORS, error.code) ? error.code : "IAO_UNAVAILABLE";
    const known = ERRORS[code];
    const status = error instanceof WireError ? error.status : controller.signal.aborted ? 499 : known?.status ?? 503;
    json(res, status, { ok: false, code, error: known?.message ?? (status === 404 ? "Consultation introuvable." : status === 504 ? "Délai dépassé. Consulte l’état de la demande avant de réessayer." : "Résultat de consultation indisponible.") });
  } finally {
    req.off("aborted", disconnected); res.off("close", closed); controller.abort();
    if (!req.destroyed) req.setTimeout(15_000);
  }
  return true;
}
