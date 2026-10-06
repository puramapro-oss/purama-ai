import type { IncomingMessage, ServerResponse } from "node:http";
import { IaoFacade, IaoRequestConflictError, IaoRequestNotFoundError, type IaoMemoryAction, type IaoRequest, type IaoServerIdentity } from "../iao/iaoFacade.js";

type Json = Record<string, unknown>;
const MAX_PROMPT_CHARS = 32_000;
const ACTIONS = new Set<IaoMemoryAction>(["import", "update", "export", "correct", "erase-logical", "erase-physical"]);
export interface IaoRouteAuthenticator { authenticate(req: IncomingMessage): Promise<IaoServerIdentity>; }
export type IaoRouteRuntime = Readonly<{ facade: IaoFacade; authenticator: IaoRouteAuthenticator }>;
export class IaoAuthenticationError extends Error { constructor() { super("IAO authentication required"); } }
class IaoValidationError extends Error {}

export async function handleIaoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: IaoRouteRuntime | undefined,
  readBody: (req: IncomingMessage) => Promise<Json>,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && (url.pathname === "/iao/requests" || url.pathname === "/pura/requests")) {
    if (!runtime) { sendJson(res, 503, { error: "IAO runtime unavailable" }); return true; }
    try {
      const identity = await runtime.authenticator.authenticate(req);
      const response = await runtime.facade.submit(parseRequest(await readBody(req), identity));
      sendJson(res, response.status === "blocked" ? 503 : 202, response);
    } catch (error) { sendError(res, error, sendJson); }
    return true;
  }
  const match = url.pathname.match(/^\/iao\/requests\/([^/]+)$/);
  if (req.method === "GET" && match) {
    if (!runtime) { sendJson(res, 503, { error: "IAO runtime unavailable" }); return true; }
    try {
      const identity = await runtime.authenticator.authenticate(req);
      sendJson(res, 200, runtime.facade.get(identity.tenantId, identity.actorId, decodeURIComponent(match[1] ?? "")));
    } catch (error) { sendError(res, error, sendJson); }
    return true;
  }
  return false;
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
