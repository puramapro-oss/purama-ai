import { createHash } from "node:crypto";

export type IaoStatus = "draft" | "partial" | "verified" | "blocked";
export type IaoMemoryAction = "import" | "update" | "export" | "correct" | "erase-logical" | "erase-physical";

export type IaoSession = Readonly<{
  sessionId: string;
  tenantId: string;
  userId: string;
  appSlug: "purama-ai";
  issuedAt: number;
  expiresAt: number;
}>;

export type IaoServerIdentity = Readonly<{
  tenantId: string;
  actorId: string;
  session: IaoSession;
}>;

export type IaoRequest = Readonly<{
  type: "conversation" | "memory-control";
  requestId: string;
  tenantId: string;
  actorId: string;
  conversationId: string;
  prompt: string;
  identity: IaoServerIdentity;
  memoryControl?: Readonly<{ action: IaoMemoryAction; data: Record<string, unknown> }>;
}>;

export type IaoReceipt = Readonly<{
  action: IaoMemoryAction;
  operationId: string;
  replayed: boolean;
  exported?: readonly unknown[];
}>;

export type KartaEvidence = Readonly<{
  source: "karta";
  requestId: string;
  proofId: string;
  completedAt: string;
}>;

export type KartaIaoResult =
  | Readonly<{ kind: "accepted"; preview?: string; evidence?: KartaEvidence; memoryControl?: IaoReceipt }>
  | Readonly<{ kind: "blocked"; reason: string; dependency?: string }>;

export interface KartaIaoPort {
  prepare(request: IaoRequest): Promise<KartaIaoResult>;
}

export type IaoResponse = {
  identity: "iao";
  requestId: string;
  tenantId: string;
  conversationId: string;
  status: IaoStatus;
  preview?: string;
  proof?: KartaEvidence;
  memoryControl?: IaoReceipt;
  blocked?: { reason: string; dependency: string };
  stale: boolean;
};

type StoredRequest = {
  actorId: string;
  conversationId: string;
  fingerprint: string;
  session: IaoSession;
  response: IaoResponse;
  pending?: Promise<IaoResponse>;
};

export class IaoRequestConflictError extends Error {}
export class IaoRequestNotFoundError extends Error {}

/** Request-scoped IAO identity. KARTA remains the only execution boundary. */
export class IaoFacade {
  readonly #requests = new Map<string, StoredRequest>();
  readonly #latestByConversation = new Map<string, string>();

  constructor(private readonly karta: KartaIaoPort) {}

  async submit(request: IaoRequest): Promise<IaoResponse> {
    assertIdentity(request);
    const key = requestKey(request.tenantId, request.actorId, request.requestId);
    const fingerprint = fingerprintRequest(request);
    const existing = this.#requests.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IaoRequestConflictError("IAO request conflict");
      return replay(await (existing.pending ?? Promise.resolve(existing.response)));
    }

    const response: IaoResponse = {
      identity: "iao", requestId: request.requestId, tenantId: request.tenantId,
      conversationId: request.conversationId, status: "draft", stale: false,
    };
    const stored: StoredRequest = {
      actorId: request.actorId, conversationId: request.conversationId,
      fingerprint, session: request.identity.session, response,
    };
    this.#requests.set(key, stored);
    this.#latestByConversation.set(conversationKey(request.tenantId, request.actorId, request.conversationId), request.requestId);

    stored.pending = this.#prepare(request, stored);
    try { return clone(await stored.pending); }
    finally { stored.pending = undefined; }
  }

  get(tenantId: string, actorId: string, requestId: string): IaoResponse {
    const stored = this.#requests.get(requestKey(tenantId, actorId, requestId));
    if (!stored || stored.actorId !== actorId) throw new IaoRequestNotFoundError("IAO request not found");
    return clone(stored.response);
  }

  recordKartaResult(tenantId: string, actorId: string, requestId: string, result: KartaIaoResult): IaoResponse {
    const stored = this.#requests.get(requestKey(tenantId, actorId, requestId));
    if (!stored) throw new IaoRequestNotFoundError("IAO request not found");
    if (stored.response.status === "verified" || stored.response.status === "blocked") return clone(stored.response);
    stored.response.stale = this.#latestByConversation.get(conversationKey(tenantId, stored.actorId, stored.conversationId)) !== requestId;
    return clone(this.#apply(stored, result));
  }

  async #prepare(request: IaoRequest, stored: StoredRequest): Promise<IaoResponse> {
    try {
      const result = await this.karta.prepare(request);
      stored.response.stale = this.#latestByConversation.get(
        conversationKey(request.tenantId, request.actorId, request.conversationId),
      ) !== request.requestId;
      return this.#apply(stored, result);
    } catch (error) {
      stored.response.stale = this.#latestByConversation.get(
        conversationKey(request.tenantId, request.actorId, request.conversationId),
      ) !== request.requestId;
      return this.#block(stored.response, safeDependency(error));
    }
  }

  #apply(stored: StoredRequest, result: KartaIaoResult): IaoResponse {
    const response = stored.response;
    if (response.status === "verified" || response.status === "blocked") return response;
    if (result.kind === "blocked") return this.#block(response, result.dependency);
    const receipt = result.memoryControl === undefined ? undefined : normalizeIaoReceipt(result.memoryControl);
    assertAccepted(result, response.requestId, stored.session, receipt);
    if (result.preview !== undefined) response.preview = result.preview;
    if (receipt) response.memoryControl = forStorage(receipt);
    if (result.evidence && !response.stale) {
      response.proof = result.evidence;
      response.status = "verified";
    } else if (result.preview !== undefined || result.memoryControl) {
      response.status = "partial";
    }
    return deliver(response, receipt);
  }

  #block(response: IaoResponse, dependency?: string): IaoResponse {
    if (response.status === "verified" || response.status === "blocked") return response;
    const denied = dependency?.startsWith("memory-denied:");
    response.status = "blocked";
    response.blocked = denied
      ? { reason: "KARTA request denied", dependency: "memory-denied:karta-runtime" }
      : { reason: "KARTA is unavailable", dependency: dependency?.startsWith("memory-unavailable:") ? "memory-unavailable:karta-runtime" : "karta-runtime" };
    return response;
  }
}

function assertIdentity(request: IaoRequest): void {
  const now = Date.now();
  const session = request.identity.session;
  if (!isUuid(request.requestId) || !request.tenantId || !request.actorId || !request.conversationId ||
    (request.type === "conversation" && request.prompt.trim().length === 0) ||
    request.tenantId !== request.identity.tenantId || request.actorId !== request.identity.actorId ||
    session.tenantId !== request.tenantId || session.userId !== request.actorId || session.appSlug !== "purama-ai" ||
    !isUuid(session.sessionId) || !Number.isFinite(session.issuedAt) || !Number.isFinite(session.expiresAt) ||
    session.issuedAt > now || session.expiresAt <= now || session.expiresAt - session.issuedAt > 15 * 60_000) {
    throw new Error("Invalid IAO identity");
  }
}

function assertAccepted(
  result: Extract<KartaIaoResult, { kind: "accepted" }>, requestId: string, session: IaoSession,
  receipt?: IaoReceipt,
): void {
  if (receipt && (!result.evidence || result.evidence.proofId !== receipt.operationId)) {
    throw new Error("Invalid KARTA durable action receipt");
  }
  if (!result.evidence) return;
  const completedAt = Date.parse(result.evidence.completedAt);
  if (result.evidence.source !== "karta" || result.evidence.requestId !== requestId || !isUuid(result.evidence.proofId) ||
    !Number.isFinite(completedAt) || new Date(completedAt).toISOString() !== result.evidence.completedAt ||
    completedAt < session.issuedAt || completedAt > session.expiresAt) {
    throw new Error("Invalid KARTA evidence");
  }
}

export function normalizeIaoReceipt(value: unknown, expectedAction?: IaoMemoryAction): IaoReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Invalid KARTA memory receipt");
  }
  const receipt = value as Record<string, unknown>;
  const allowed = new Set(["action", "operationId", "replayed", "exported"]);
  if (!Object.keys(receipt).every((key) => allowed.has(key)) ||
    !isMemoryAction(receipt.action) || (expectedAction !== undefined && receipt.action !== expectedAction) ||
    typeof receipt.operationId !== "string" || !isUuid(receipt.operationId) || typeof receipt.replayed !== "boolean") {
    throw new Error("Invalid KARTA memory receipt");
  }
  if (receipt.exported === undefined) {
    return { action: receipt.action, operationId: receipt.operationId, replayed: receipt.replayed };
  }
  if (receipt.action !== "export" || receipt.replayed || !Array.isArray(receipt.exported) || receipt.exported.length > 1_000) {
    throw new Error("Invalid KARTA memory receipt");
  }
  try {
    const encoded = JSON.stringify(receipt.exported);
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 1024 * 1024) throw new Error("oversized");
    const exported: unknown = JSON.parse(encoded);
    if (!Array.isArray(exported)) throw new Error("invalid");
    return {
      action: receipt.action, operationId: receipt.operationId, replayed: receipt.replayed,
      exported,
    };
  } catch {
    throw new Error("Invalid KARTA memory receipt");
  }
}

function isMemoryAction(value: unknown): value is IaoMemoryAction {
  return value === "import" || value === "update" || value === "export" || value === "correct" ||
    value === "erase-logical" || value === "erase-physical";
}

function fingerprintRequest(request: IaoRequest): string {
  return createHash("sha256").update(canonicalize({
    type: request.type, tenantId: request.tenantId, actorId: request.actorId,
    conversationId: request.conversationId, prompt: request.prompt,
    memoryControl: request.memoryControl,
  })).digest("hex");
}
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}
function requestKey(tenantId: string, actorId: string, requestId: string): string {
  return JSON.stringify([tenantId, actorId, requestId]);
}
function conversationKey(tenantId: string, actorId: string, conversationId: string): string {
  return JSON.stringify([tenantId, actorId, conversationId]);
}
function forStorage(receipt: IaoReceipt): IaoReceipt {
  return { action: receipt.action, operationId: receipt.operationId, replayed: receipt.replayed };
}
function deliver(response: IaoResponse, receipt?: IaoReceipt): IaoResponse {
  const copy = clone(response);
  if (receipt?.exported && copy.memoryControl) copy.memoryControl = { ...copy.memoryControl, exported: structuredClone(receipt.exported) };
  return copy;
}
function replay(response: IaoResponse): IaoResponse {
  const copy = clone(response);
  if (copy.memoryControl) copy.memoryControl = {
    action: copy.memoryControl.action, operationId: copy.memoryControl.operationId, replayed: true,
  };
  return copy;
}
function safeDependency(error: unknown): string {
  const message = error instanceof Error ? error.message : "karta-runtime";
  if (message.startsWith("memory-denied:")) return "memory-denied:karta-runtime";
  if (message.startsWith("memory-unavailable:")) return "memory-unavailable:karta-runtime";
  return "karta-runtime";
}
function clone<T>(value: T): T { return structuredClone(value); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
