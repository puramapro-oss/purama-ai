import type { IncomingMessage, ServerResponse } from "node:http";
import { bounded } from "../runtime/lifecycle.js";
import { parseConsultationAction, projectConsultationCatalog, projectConsultationOperation } from "./consultation.js";
import type { ConsultationInput } from "./consultation-contract.js";
import type { PublicApiGrant, PublicApiRuntime, PublicApiScope } from "./public-api-runtime.js";

const PREFIX = "/v1/iao";
const MAX_BODY_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 524_288;
const ADMISSION_TIMEOUT_MS = 10_000;
// Same execution allowance as the existing Council transport. Admission does
// not borrow this longer budget while credentials or a request body are pending.
const CONSULTATION_TIMEOUT_MS = 135_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/i;

const ERRORS: Record<string, { status: number; message: string }> = {
  IAO_API_INVALID: { status: 400, message: "Demande API invalide." },
  IAO_API_UNAUTHORIZED: { status: 401, message: "Clé API absente ou invalide." },
  IAO_API_FORBIDDEN: { status: 403, message: "Cette clé ne permet pas cette opération." },
  IAO_API_NOT_FOUND: { status: 404, message: "Ressource API introuvable." },
  IAO_API_METHOD: { status: 405, message: "Méthode non autorisée." },
  IAO_API_TOO_LARGE: { status: 413, message: "Corps de demande trop volumineux." },
  IAO_API_MEDIA_TYPE: { status: 415, message: "Le corps doit être au format JSON UTF-8." },
  IAO_API_RATE_LIMIT: { status: 429, message: "Limite de requêtes atteinte." },
  IAO_API_LIMIT: { status: 429, message: "Les ressources autorisées pour cette clé sont insuffisantes." },
  IAO_API_INVALID_RESPONSE: { status: 502, message: "Résultat API temporairement indisponible." },
  IAO_API_UNAVAILABLE: { status: 503, message: "API temporairement indisponible." },
  IAO_API_TIMEOUT: { status: 504, message: "Délai dépassé. Consulte l’état de la demande avant de la relancer." },
  IAO_INVALID: { status: 400, message: "Demande de consultation invalide." },
  IAO_FORBIDDEN: { status: 403, message: "Consultation non autorisée." },
  IAO_CONFLICT: { status: 409, message: "Cet identifiant appartient déjà à une autre demande." },
  IAO_BUDGET: { status: 429, message: "Budget de consultation indisponible." },
  IAO_UNAVAILABLE: { status: 503, message: "Consultation temporairement indisponible." },
};

class PublicTransportError extends Error {
  constructor(readonly code: keyof typeof ERRORS) { super(code); }
}
const invalid = (): never => { throw new PublicTransportError("IAO_API_INVALID"); };
type Route = { action: "catalog"; scope: "catalog" } | { action: "consult"; scope: "create" }
  | { action: "status" | "cancel"; scope: "read" | "cancel"; operationId: string };

/** Reserve the whole public namespace before administrative route handling. */
export function isPublicApiPath(path: string): boolean {
  return path === PREFIX || path.startsWith(`${PREFIX}/`);
}

function route(req: IncomingMessage, res: ServerResponse, url: URL): Route {
  if (url.search || url.hash) return invalid();
  let found: Route;
  let method: "GET" | "POST";
  if (url.pathname === `${PREFIX}/models`) {
    found = { action: "catalog", scope: "catalog" }; method = "GET";
  } else if (url.pathname === `${PREFIX}/consultations`) {
    found = { action: "consult", scope: "create" }; method = "POST";
  } else {
    const match = /^\/v1\/iao\/consultations\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (!match) throw new PublicTransportError("IAO_API_NOT_FOUND");
    if (!UUID.test(match[1])) return invalid();
    const cancel = match[2] !== undefined;
    found = { action: cancel ? "cancel" : "status", scope: cancel ? "cancel" : "read", operationId: match[1].toLowerCase() };
    method = cancel ? "POST" : "GET";
  }
  if (req.method !== method) {
    res.setHeader("Allow", method);
    throw new PublicTransportError("IAO_API_METHOD");
  }
  return found;
}

function headerCount(req: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
  return count;
}

function bearer(req: IncomingMessage): string {
  const authorization = req.headers.authorization;
  if (headerCount(req, "authorization") !== 1 || typeof authorization !== "string" || authorization.length > 160) {
    throw new PublicTransportError("IAO_API_UNAUTHORIZED");
  }
  const match = /^Bearer ([^\s]+)$(?![\s\S])/i.exec(authorization);
  if (!match) throw new PublicTransportError("IAO_API_UNAUTHORIZED");
  // The runtime is the single authority for key format, digest and revocation.
  return match[1];
}

async function readBody(req: IncomingMessage, signal: AbortSignal, jsonBody: boolean): Promise<Buffer> {
  if (headerCount(req, "content-type") > 1 || headerCount(req, "content-length") > 1) return invalid();
  if (jsonBody && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) {
    throw new PublicTransportError("IAO_API_MEDIA_TYPE");
  }
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) return invalid();
  if (length !== undefined && Number(length) > MAX_BODY_BYTES) throw new PublicTransportError("IAO_API_TOO_LARGE");
  if (!jsonBody && length !== undefined && Number(length) > 0) return invalid();
  signal.throwIfAborted();
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const cleanup = () => {
      req.off("data", data); req.off("end", end); req.off("error", fail);
      signal.removeEventListener("abort", aborted);
    };
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true; cleanup();
      // A late ECONNRESET must not become an unhandled stream error after an
      // aborted or oversized body. Drain rejected bytes without retaining them.
      req.once("error", () => undefined); req.resume(); reject(error);
    };
    const aborted = () => fail(new PublicTransportError("IAO_API_UNAVAILABLE"));
    const data = (chunk: Buffer | string) => {
      if (signal.aborted) { aborted(); return; }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) { fail(new PublicTransportError("IAO_API_TOO_LARGE")); return; }
      if (!jsonBody && size > 0) { fail(new PublicTransportError("IAO_API_INVALID")); return; }
      chunks.push(bytes);
    };
    const end = () => {
      if (finished) return;
      finished = true; cleanup(); resolve(Buffer.concat(chunks));
    };
    req.on("data", data); req.once("end", end); req.once("error", fail);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else if (req.readableEnded) end();
  });
}

function consultationInput(raw: Buffer): ConsultationInput {
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.hasOwn(body, "action")) return invalid();
    const input = parseConsultationAction({ ...body, action: "consult" });
    if (input.action !== "consult") return invalid();
    const { action: _action, ...request } = input;
    return request;
  } catch { return invalid(); }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESPONSE_BYTES) throw new PublicTransportError("IAO_API_INVALID_RESPONSE");
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" });
  res.end(encoded);
}

async function within<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, parent: AbortSignal): Promise<T> {
  const expiresAt = performance.now() + ms;
  try { return await bounded(work, ms, parent); }
  catch (error) {
    if (!parent.aborted && performance.now() >= expiresAt) throw new PublicTransportError("IAO_API_TIMEOUT");
    throw error;
  }
}

function errorCode(error: unknown): string {
  try {
    if (error && typeof error === "object") {
      const code = Object.getOwnPropertyDescriptor(error, "code");
      if (code && "value" in code && typeof code.value === "string" && Object.hasOwn(ERRORS, code.value)) return code.value;
    }
  } catch { /* Arbitrary runtime errors never supply response content. */ }
  return "IAO_API_UNAVAILABLE";
}

/** Service-key transport. No administrative credential, owner supplied in the
 * body, provider response metadata or private grant is exposed to callers. */
export async function handlePublicApiRequest(req: IncomingMessage, res: ServerResponse, url: URL,
  runtime: PublicApiRuntime | undefined, ready: () => Promise<boolean>, lifetime?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const disconnected = () => controller.abort();
  const closed = () => { if (!res.writableEnded) disconnected(); };
  req.once("aborted", disconnected); res.once("close", closed);
  lifetime?.addEventListener("abort", disconnected, { once: true });
  if (req.aborted || res.destroyed || lifetime?.aborted) controller.abort();
  const current = () => {
    if (controller.signal.aborted || lifetime?.aborted || req.aborted || res.destroyed) throw new PublicTransportError("IAO_API_UNAVAILABLE");
  };
  try {
    current();
    if (!runtime) throw new PublicTransportError("IAO_API_UNAVAILABLE");
    const target = route(req, res, url);
    const key = bearer(req);
    const admitted = await within(async signal => {
      const grant: PublicApiGrant = await runtime.authenticate(key, target.scope as PublicApiScope, signal);
      signal.throwIfAborted(); current();
      if (!grant || typeof grant !== "object") throw new PublicTransportError("IAO_API_UNAVAILABLE");
      const raw = await readBody(req, signal, target.action === "consult");
      signal.throwIfAborted(); current();
      const input = target.action === "consult" ? consultationInput(raw) : undefined;
      // Reading and cancellation remain available during dependency degradation.
      // Only creation requires a fresh readiness result after body admission.
      if (target.action === "consult" && !await ready()) throw new PublicTransportError("IAO_API_UNAVAILABLE");
      signal.throwIfAborted(); current();
      return { grant, input };
    }, ADMISSION_TIMEOUT_MS, controller.signal);
    current();
    const timeoutMs = target.action === "consult" ? CONSULTATION_TIMEOUT_MS : ADMISSION_TIMEOUT_MS;
    req.setTimeout(timeoutMs + 5000);
    const response = await within(async signal => {
      current(); signal.throwIfAborted();
      if (target.action === "catalog") {
        const result = await runtime.catalog(key, admitted.grant, signal);
        signal.throwIfAborted(); current();
        try { return { ok: true as const, catalog: projectConsultationCatalog(result) }; }
        catch { throw new PublicTransportError("IAO_API_INVALID_RESPONSE"); }
      }
      const operationId = target.action === "consult" ? admitted.input!.operationId : target.operationId;
      const result = await runtime.operation(key, admitted.grant, operationId, target.action, admitted.input, signal);
      signal.throwIfAborted(); current();
      if (!result) throw new PublicTransportError("IAO_API_NOT_FOUND");
      try {
        const projected = projectConsultationOperation(result, operationId);
        // Cancellation authority does not grant permission to read an answer.
        // Preserve the true state, including an already completed operation,
        // while returning only the acknowledgement needed by a cancel client.
        if (target.action === "cancel") {
          const { operationId: id, status, cancelRequested } = projected;
          return { ok: true as const, operation: { operationId: id, status, cancelRequested } };
        }
        return { ok: true as const, operation: projected };
      }
      catch { throw new PublicTransportError("IAO_API_INVALID_RESPONSE"); }
    }, timeoutMs, controller.signal);
    current();
    send(res, "operation" in response && response.operation?.status === "running" ? 202 : 200, response);
  } catch (error) {
    if (res.destroyed || res.writableEnded) return;
    const code = controller.signal.aborted ? "IAO_API_UNAVAILABLE" : errorCode(error);
    const known = ERRORS[code];
    if (!req.complete) { res.setHeader("Connection", "close"); req.resume(); }
    send(res, known.status, { ok: false, code, error: known.message });
  } finally {
    req.off("aborted", disconnected); res.off("close", closed);
    lifetime?.removeEventListener("abort", disconnected); controller.abort();
    if (!req.destroyed) req.setTimeout(15_000);
  }
}
