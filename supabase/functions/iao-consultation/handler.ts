import { createRequestDeadline, RequestDeadlineError } from "../_shared/request-deadline.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$(?![\s\S])/;
type Deadline = ReturnType<typeof createRequestDeadline>;
interface Dependencies {
  env(name: string): string | undefined;
  authenticate(token: string, signal: AbortSignal): Promise<{ id: string; is_anonymous?: boolean } | null>;
  rateLimit(key: string, max: number, windowMs: number): { allowed: boolean };
  fetch(input: string, init: RequestInit): Promise<Response>;
}
class Invalid extends Error {}
class TooLarge extends Error {}
function json(body: unknown, status = 200): Response {
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).byteLength > 524_288) throw new TooLarge();
  return new Response(encoded, { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });
}
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void { if (Object.keys(value).some(key => !keys.includes(key))) throw new Invalid(); }
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) throw new Invalid();
  return value;
}
function id(value: unknown): string { const output = text(value, 200); if (!ID.test(output)) throw new Invalid(); return output; }
function uuid(value: unknown): string { const output = text(value, 36); if (!UUID.test(output)) throw new Invalid(); return output.toLowerCase(); }
function list<T>(value: unknown, max: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Invalid(); return value.map(parse);
}
function choice(value: unknown, choices: string[]): string { const output = text(value, 200); if (!choices.includes(output)) throw new Invalid(); return output; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw new Invalid(); return value; }
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Invalid(); return value;
}
function httpsUrl(value: unknown): string {
  const output = text(value, 8192); const parsed = new URL(output);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || /\s/.test(output)) throw new Invalid(); return output;
}
function action(value: unknown): Record<string, unknown> & { action: string; operationId?: string } {
  const input = row(value); const name = choice(input.action, ["catalog", "consult", "status", "cancel"]);
  if (name === "catalog") { exact(input, ["action"]); return { action: name }; }
  const operationId = uuid(input.operationId);
  if (name !== "consult") { exact(input, ["action", "operationId"]); return { action: name, operationId }; }
  exact(input, ["action", "operationId", "question", "preferences", "reviewerModels", "research"]);
  const supplied = row(input.preferences); exact(supplied, ["model", "reflection", "speed"]);
  const preferences = { model: id(supplied.model),
    ...(supplied.reflection === undefined ? {} : { reflection: choice(supplied.reflection, ["auto", "standard", "deep", "maximum"]) }),
    ...(supplied.speed === undefined ? {} : { speed: choice(supplied.speed, ["standard", "fast", "ultra_fast"]) }) };
  const result: Record<string, unknown> & { action: string; operationId: string } = { action: name, operationId, question: text(input.question, 8000), preferences };
  if (input.reviewerModels !== undefined) {
    const reviewers = list(input.reviewerModels, 3, id);
    if (new Set(reviewers).size !== reviewers.length || reviewers.includes(preferences.model)) throw new Invalid();
    result.reviewerModels = reviewers;
  }
  if (input.research !== undefined) {
    const research = row(input.research); exact(research, ["queries", "urls"]);
    result.research = { queries: list(research.queries, 3, value => text(value, 2000)), urls: list(research.urls, 6, httpsUrl) };
  }
  return result;
}
function limits(value: unknown) {
  const input = row(value); return { maxSearches: integer(input.maxSearches, 0, 3), maxPages: integer(input.maxPages, 0, 6),
    maxReviewers: integer(input.maxReviewers, 0, 3), maxRounds: integer(input.maxRounds, 1, 2), concurrency: integer(input.concurrency, 1, 3) };
}
function catalog(value: unknown) {
  const input = row(value); const research = row(input.research);
  const available = bool(input.available);
  const reason = choice(input.reason, ["ready", "not_configured", "simulation_enabled", "account_unavailable", "budget_unavailable", "model_unavailable", "paused", "service_unavailable"]);
  const models = list(input.models, 32, value => {
    const model = row(value);
    const reflections = list(model.reflections, 4, value => choice(value, ["auto", "standard", "deep", "maximum"]));
    const speeds = list(model.speeds, 3, value => choice(value, ["standard", "fast", "ultra_fast"]));
    const profiles = list(model.profiles, 12, value => {
      const profile = row(value); return { reflection: choice(profile.reflection, reflections), speed: choice(profile.speed, speeds), research: limits(profile.research) };
    });
    if (!reflections.length || !speeds.length || !profiles.length || new Set(reflections).size !== reflections.length || new Set(speeds).size !== speeds.length
      || new Set(profiles.map(profile => `${profile.reflection}:${profile.speed}`)).size !== profiles.length) throw new Invalid();
    return { model: id(model.model), provider: id(model.provider), reflections, speeds, maxOutputTokens: integer(model.maxOutputTokens, 1024, 65536), profiles };
  });
  if (available !== (reason === "ready") || (available && !models.length) || new Set(models.map(model => model.model)).size !== models.length) throw new Invalid();
  return { available, reason, models, research: { search: bool(research.search), scrape: bool(research.scrape) } };
}
function result(value: unknown) {
  const input = row(value); const suppliedPlan = row(input.plan);
  const plan = { model: id(suppliedPlan.model), reflection: choice(suppliedPlan.reflection, ["standard", "deep", "maximum"]),
    speed: choice(suppliedPlan.speed, ["standard", "fast", "ultra_fast"]), maxOutputTokens: integer(suppliedPlan.maxOutputTokens, 1024, 65536),
    timeoutMs: integer(suppliedPlan.timeoutMs, 1, 120000), research: limits(suppliedPlan.research) };
  let sourceText = 0;
  const sources = list(input.sources, 32, value => {
    const source = row(value); const retrievedAt = text(source.retrievedAt, 40); if (!Number.isFinite(Date.parse(retrievedAt))) throw new Invalid();
    const snippet = text(source.text, 2000, true); sourceText += snippet.length;
    return { id: id(source.id), provider: id(source.provider), retrievedAt, url: httpsUrl(source.url), title: text(source.title, 512, true), text: snippet,
      contentKind: choice(source.contentKind, ["search_excerpt", "page_markdown"]), verificationStatus: choice(source.verificationStatus, ["unverified"]), truncated: bool(source.truncated) };
  });
  const citedSourceIds = list(input.citedSourceIds, 32, id); const ids = sources.map(source => source.id);
  if (sourceText > 32000 || new Set(ids).size !== ids.length || new Set(citedSourceIds).size !== citedSourceIds.length || citedSourceIds.some(id => !ids.includes(id))) throw new Invalid();
  const status = choice(input.status, ["complete", "partial", "failed", "blocked"]); const answer = input.answer === null ? null : text(input.answer, 32000);
  if ((status === "complete" || status === "partial") !== (answer !== null)) throw new Invalid();
  return { status, reason: choice(input.reason, ["completed", "some_calls_unavailable", "synthesis_unavailable", "already_claimed", "interrupted", "accounting_unavailable"]), plan,
    answer, citedSourceIds, disagreements: list(input.disagreements, 32, value => text(value, 2000)), uncertainties: list(input.uncertainties, 32, value => text(value, 2000)),
    sources, verificationStatus: choice(input.verificationStatus, ["unverified"]) };
}
function operation(value: unknown, operationId: string) {
  const input = row(value); if (uuid(input.operationId) !== operationId) throw new Invalid();
  const status = choice(input.status, ["running", "complete", "partial", "failed", "blocked", "cancelled", "reconciliation_required"]);
  const output = input.result === null ? null : result(input.result);
  if ((status === "complete" || status === "partial") && output?.status !== status) throw new Invalid();
  return { operationId, status, cancelRequested: bool(input.cancelRequested), result: output };
}
async function readJson(message: Request | Response, maxBytes: number, deadline: Deadline): Promise<unknown> {
  const contentType = message.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  const discard = () => { try { void message.body?.cancel().catch(() => {}); } catch { /* best effort */ } };
  if (contentType !== "application/json") { discard(); throw new Invalid(); }
  const length = message.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { discard(); throw new TooLarge(); }
  const reader = message.body?.getReader(); if (!reader) throw new Invalid();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await deadline.wait(() => reader.read()); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > maxBytes) throw new TooLarge(); chunks.push(part.value);
    }
    deadline.check(); const all = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
  } finally { try { void reader.cancel().catch(() => {}); } catch { /* best effort */ } }
}
const ERRORS: Record<string, { status: number; error: string }> = {
  IAO_INVALID: { status: 400, error: "Demande de consultation invalide." }, IAO_FORBIDDEN: { status: 403, error: "Consultation non autorisée pour ce compte." },
  IAO_NOT_FOUND: { status: 404, error: "Consultation introuvable." }, IAO_CONFLICT: { status: 409, error: "Cet identifiant appartient déjà à une autre demande." },
  IAO_TOO_LARGE: { status: 413, error: "Demande trop volumineuse." }, IAO_BUDGET: { status: 429, error: "Budget de consultation indisponible." },
  IAO_UNAVAILABLE: { status: 503, error: "Consultation temporairement indisponible." }, IAO_TIMEOUT: { status: 504, error: "Délai dépassé. Consulte l’état de la demande avant de réessayer." },
};

/** The only public ingress. Identity and internal credentials are derived here, never from JSON. */
export function createIaoConsultationHandler(deps: Dependencies) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return json({ ok: false, code: "IAO_METHOD", error: "Méthode non autorisée." }, 405);
    const controller = new AbortController(); const cancel = () => controller.abort();
    req.signal.addEventListener("abort", cancel, { once: true }); if (req.signal.aborted) cancel();
    const deadline = createRequestDeadline(145_000, controller.signal);
    try {
      deadline.check();
      const authorization = req.headers.get("Authorization") ?? "";
      const token = authorization.length <= 8192 ? /^Bearer ([^\s]+)$(?![\s\S])/i.exec(authorization)?.[1] : undefined;
      if (!token) return json({ ok: false, code: "IAO_AUTH", error: "Connexion requise." }, 401);
      const authDeadline = createRequestDeadline(10_000, controller.signal);
      let user: Awaited<ReturnType<Dependencies["authenticate"]>>;
      try { user = await authDeadline.wait(() => deps.authenticate(token, controller.signal)); }
      finally { authDeadline.close(); }
      deadline.check();
      if (!user || user.is_anonymous === true || !UUID.test(user.id)) return json({ ok: false, code: "IAO_AUTH", error: "Connexion requise." }, 401);
      const bodyDeadline = createRequestDeadline(10_000, controller.signal);
      let input: ReturnType<typeof action>;
      try { input = action(await bodyDeadline.wait(() => readJson(req, 65_536, bodyDeadline))); }
      catch (error) {
        if (error instanceof RequestDeadlineError || controller.signal.aborted) throw error;
        return json({ ok: false, code: error instanceof TooLarge ? "IAO_TOO_LARGE" : "IAO_INVALID", error: "Demande de consultation invalide." }, error instanceof TooLarge ? 413 : 400);
      } finally { bodyDeadline.close(); }
      deadline.check();
      const userId = user.id.toLowerCase(); const mutation = input.action === "consult";
      // Reading a busy operation cannot consume the separate cancellation slot.
      const channel = mutation ? "consult" : input.action === "cancel" ? "cancel" : "read";
      if (!deps.rateLimit(`iao-consultation:${channel}:${userId}`, mutation ? 10 : 120, mutation ? 3_600_000 : 60_000).allowed) {
        return json({ ok: false, code: "IAO_RATE_LIMIT", error: "Trop de demandes. Réessaie dans un moment." }, 429);
      }
      const endpoint = deps.env("KARTA_INTERNAL_URL"); const key = deps.env("KARTA_ADMIN_TOKEN");
      if (!endpoint || endpoint.length > 2048 || !key || key.length > 8192 || /\s/.test(key)) return json({ ok: false, code: "IAO_UNAVAILABLE", error: ERRORS.IAO_UNAVAILABLE.error }, 503);
      let target: URL;
      try {
        target = new URL(endpoint);
        if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Invalid();
        target.pathname = `${target.pathname.replace(/\/+$/, "")}/consultations/${userId}`;
      } catch { return json({ ok: false, code: "IAO_UNAVAILABLE", error: ERRORS.IAO_UNAVAILABLE.error }, 503); }
      const networkDeadline = createRequestDeadline(mutation ? 140_000 : 15_000, controller.signal);
      try {
        let late: Response | undefined;
        const dispose = () => { try { void late?.body?.cancel().catch(() => {}); } catch { /* best effort */ } };
        controller.signal.addEventListener("abort", dispose, { once: true });
        let response: Response;
        try {
          response = await deadline.wait(() => networkDeadline.wait(() => deps.fetch(target.toString(), {
            method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify(input), redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
          }).then(response => { late = response; if (controller.signal.aborted) dispose(); return response; })));
        } catch (error) { dispose(); throw error; }
        finally { controller.signal.removeEventListener("abort", dispose); }
        deadline.check(); if (response.redirected) { try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ } throw new Invalid(); }
        const received = await deadline.wait(() => readJson(response, 524_288, networkDeadline));
        deadline.check();
        if (!response.ok) {
          const data = row(received); const code = typeof data.code === "string" && Object.hasOwn(ERRORS, data.code) ? data.code : "IAO_UNAVAILABLE";
          const error = ERRORS[code];
          return error.status === response.status ? json({ ok: false, code, error: error.error }, error.status)
            : json({ ok: false, code: "IAO_UNAVAILABLE", error: ERRORS.IAO_UNAVAILABLE.error }, 503);
        }
        if (![200, 202].includes(response.status)) throw new Invalid();
        const data = row(received); if (data.ok !== true) throw new Invalid();
        return input.action === "catalog" ? json({ ok: true, catalog: catalog(data.catalog) })
          : json({ ok: true, operation: operation(data.operation, input.operationId!) }, response.status);
      } finally { networkDeadline.close(); }
    } catch (error) {
      if (req.signal.aborted) return json({ ok: false, code: "IAO_CANCELLED", error: "Demande interrompue. Consulte son état avant de réessayer." }, 499);
      if (error instanceof RequestDeadlineError) return json({ ok: false, code: "IAO_TIMEOUT", error: ERRORS.IAO_TIMEOUT.error }, 504);
      return json({ ok: false, code: "IAO_UNAVAILABLE", error: ERRORS.IAO_UNAVAILABLE.error }, 503);
    } finally { controller.abort(); deadline.close(); req.signal.removeEventListener("abort", cancel); }
  };
}
