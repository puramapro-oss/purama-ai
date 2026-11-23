import type { IncomingMessage, ServerResponse } from "node:http";
import { IaoFacade, IaoRequestConflictError, IaoRequestNotFoundError, type IaoMemoryAction, type IaoRequest, type IaoServerIdentity } from "../iao/iaoFacade.js";

type Json = Record<string, unknown>;
const MAX_PROMPT_CHARS = 32_000;
const ACTIONS = new Set<IaoMemoryAction>(["import", "update", "export", "correct", "erase-logical", "erase-physical"]);
export interface IaoRouteAuthenticator { authenticate(req: IncomingMessage): Promise<IaoServerIdentity>; }
export type IaoRouteRuntime = Readonly<{ facade: IaoFacade; authenticator: IaoRouteAuthenticator }>;
export class IaoAuthenticationError extends Error { constructor() { super("IAO authentication required"); } }
class IaoValidationError extends Error {}

const SUBMIT_PATHS = new Set(["/iao/requests", "/pura/requests"]);
const LOOKUP_PATH = /^\/iao\/requests\/([^/]+)$/;
const CANCEL_PATH = /^\/iao\/requests\/([^/]+)\/cancel$/;

/** Single source of truth for which (method, path) pairs belong to IAO. */
export function isIaoPath(method: string | undefined, pathname: string): boolean {
  return (method === "POST" && (SUBMIT_PATHS.has(pathname) || CANCEL_PATH.test(pathname))) ||
    (method === "GET" && LOOKUP_PATH.test(pathname));
}

export async function handleIaoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: IaoRouteRuntime | undefined,
  readBody: (req: IncomingMessage) => Promise<Json>,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
  lifecycle?: Readonly<{ isActive: () => boolean; canAdmit: () => Promise<boolean> }>,
): Promise<boolean> {
  const admissionDeadline = performance.now() + 15_000;
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!isIaoPath(req.method, url.pathname)) return false;
  // Authenticated previews, receipts and refusals must not survive in HTTP caches.
  res.setHeader("Cache-Control", "no-store");
  const admissionExpired = Symbol("IAO admission expired");
  const assertAdmissionOpen = (): void => {
    if (performance.now() >= admissionDeadline) throw admissionExpired;
  };
  // HTTP/1 pipelined responses share a socket timeout. Admission therefore has
  // its own monotonic deadline, shared by all waits and released before submit.
  const beforeAdmission = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = admissionDeadline - performance.now();
    if (remaining <= 0) throw admissionExpired;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(admissionExpired), remaining);
      });
      // A non-cancellable operation may settle later; its result cannot resume
      // route dispatch after this race has timed out.
      const value = await Promise.race([operation(), expired]);
      assertAdmissionOpen();
      return value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const isActive = (): boolean => {
    // A disconnected client cannot admit new work after a pending readiness,
    // authentication or body read. Already admitted work is still drained.
    if (req.aborted || res.destroyed || res.writableEnded) return false;
    try { return lifecycle ? lifecycle.isActive() === true : true; }
    catch { return false; }
  };
  const canAdmit = async (): Promise<boolean> => {
    try { return isActive() && (!lifecycle || await lifecycle.canAdmit() === true) && isActive(); }
    catch { return false; }
  };
  const unavailable = (): true => {
    if (!res.destroyed && !res.writableEnded) sendJson(res, 503, { error: "IAO runtime unavailable" });
    return true;
  };
  if (!runtime || !isActive()) return unavailable();
  try {
    if (req.method === "POST" && SUBMIT_PATHS.has(url.pathname)) {
      if (!await beforeAdmission(canAdmit) || !isActive()) return unavailable();
      const identity = await beforeAdmission(() => authenticateIdentity(runtime.authenticator, req));
      if (!isActive()) return unavailable();
      const body = await beforeAdmission(() => readBody(req));
      if (!isActive()) return unavailable();
      const request = parseRequest(body, identity);
      // Authentication and body reads can outlive readiness. Admit only after
      // a final dependency probe, then recheck shutdown without another await.
      if (!await beforeAdmission(canAdmit) || !isActive()) return unavailable();
      const executionBudgetMs = runtime.facade.executionBudgetMs(request.type);
      if (executionBudgetMs !== undefined) {
        const currentTimeout = res.socket?.timeout;
        const initialTimeout = currentTimeout !== undefined && Number.isFinite(currentTimeout) && currentTimeout > 0
          ? currentTimeout : 15_000;
        res.setTimeout(Math.max(initialTimeout, executionBudgetMs + 1_000));
      }
      // Port metadata is synchronous code too; shutdown still wins at dispatch.
      if (!isActive()) return unavailable();
      assertAdmissionOpen();
      const response = await runtime.facade.submit(request);
      sendJson(res, response.status === "blocked" ? 503 : 202, response);
      return true;
    }
    const match = url.pathname.match(LOOKUP_PATH);
    if (req.method === "GET" && match) {
      // Retained work remains readable/cancellable during dependency outages.
      const identity = await beforeAdmission(() => authenticateIdentity(runtime.authenticator, req));
      if (!isActive()) return unavailable();
      assertAdmissionOpen();
      sendJson(res, 200, runtime.facade.get(identity.tenantId, identity.actorId, decodeURIComponent(match[1] ?? "")));
      return true;
    }
    const cancel = url.pathname.match(CANCEL_PATH);
    if (req.method === "POST" && cancel) {
      const identity = await beforeAdmission(() => authenticateIdentity(runtime.authenticator, req));
      if (!isActive()) return unavailable();
      assertAdmissionOpen();
      sendJson(res, 200, runtime.facade.cancel(identity.tenantId, identity.actorId, decodeURIComponent(cancel[1] ?? "")));
      return true;
    }
  } catch (error) {
    if (error === admissionExpired) return unavailable();
    sendError(res, error, sendJson);
    return true;
  }
  return false;
}

/** Recheck the target identity for every operation, including lookup/cancel.
 * ONE launch offers are not IAO sessions. Authenticators remain responsible for
 * validating credentials and current revocation against their authority.
 */
async function authenticateIdentity(authenticator: IaoRouteAuthenticator, req: IncomingMessage): Promise<IaoServerIdentity> {
  const identity = await authenticator.authenticate(req);
  const session = identity?.session;
  const now = Date.now();
  if (!isJson(identity) || typeof identity.tenantId !== "string" || !identity.tenantId.trim() ||
    typeof identity.actorId !== "string" || !identity.actorId.trim() || !isJson(session) ||
    session.tenantId !== identity.tenantId || session.userId !== identity.actorId || session.appSlug !== "purama-ai" ||
    typeof session.sessionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session.sessionId) ||
    !Number.isFinite(session.issuedAt) || !Number.isFinite(session.expiresAt) ||
    session.issuedAt > now || session.expiresAt <= now || session.expiresAt - session.issuedAt > 15 * 60_000) {
    throw new IaoAuthenticationError();
  }
  // Snapshot the authenticated claims before awaiting body parsing/dispatch.
  return Object.freeze({ tenantId: identity.tenantId, actorId: identity.actorId, session: Object.freeze({ ...session }) });
}

function parseRequest(body: Json, identity: IaoServerIdentity): IaoRequest {
  const allowed = new Set(["type", "requestId", "conversationId", "prompt", "memoryControl"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new IaoValidationError("Invalid IAO request");
  if (body.type !== "conversation" && body.type !== "memory-control") throw new IaoValidationError("IAO request type is unsupported");
  if (typeof body.requestId !== "string" || typeof body.conversationId !== "string" || typeof body.prompt !== "string" ||
    body.conversationId.length < 1 || body.conversationId.length > 256 || body.prompt.length > MAX_PROMPT_CHARS ||
    (body.type === "conversation" && body.prompt.trim().length === 0)) {
    throw new IaoValidationError("Invalid IAO request");
  }
  let memoryControl: { action: IaoMemoryAction; data: Record<string, unknown> } | undefined;
  if (body.type === "memory-control") {
    if (!isJson(body.memoryControl) || Object.keys(body.memoryControl).some((key) => key !== "action" && key !== "data") ||
      !ACTIONS.has(body.memoryControl.action as IaoMemoryAction) || !isJson(body.memoryControl.data)) {
      throw new IaoValidationError("Invalid IAO memory control");
    }
    memoryControl = { action: body.memoryControl.action as IaoMemoryAction, data: structuredClone(body.memoryControl.data) };
  } else if (body.memoryControl !== undefined) {
    throw new IaoValidationError("Invalid IAO request");
  }
  return {
    type: body.type, requestId: body.requestId, conversationId: body.conversationId, prompt: body.prompt,
    tenantId: identity.tenantId, actorId: identity.actorId, identity, ...(memoryControl ? { memoryControl } : {}),
  };
}
function isJson(value: unknown): value is Json { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sendError(res: ServerResponse, error: unknown, sendJson: (res: ServerResponse, status: number, body: unknown) => void): void {
  if (error instanceof IaoAuthenticationError) sendJson(res, 401, { error: error.message });
  else if (error instanceof IaoRequestNotFoundError) sendJson(res, 404, { error: "IAO request not found" });
  else if (error instanceof IaoRequestConflictError) sendJson(res, 409, { error: "IAO request conflict" });
  else if (error instanceof IaoValidationError) sendJson(res, 400, { error: error.message });
  else sendJson(res, 400, { error: "Invalid IAO request" });
}
