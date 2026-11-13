import { createHash } from "node:crypto";

export type IaoStatus = "draft" | "partial" | "verified" | "blocked" | "cancelled";
export type IaoMemoryAction = "import" | "update" | "export" | "correct" | "erase-logical" | "erase-physical";
/** What KARTA knows about durable side effects once a request was interrupted (cancel or timeout). */
export type IaoEffect = "none" | "uncertain" | "executed";

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
  | Readonly<{ kind: "blocked"; reason: string; dependency?: string; effect?: IaoEffect }>;

export interface KartaIaoPort {
  prepare(request: IaoRequest, signal?: AbortSignal): Promise<KartaIaoResult>;
}

export type IaoResponse = {
  identity: "iao";
  requestId: string;
  tenantId: string;
  conversationId: string;
  status: IaoStatus;
  updatedAt: string;
  preview?: string;
  proof?: KartaEvidence;
  memoryControl?: IaoReceipt;
  blocked?: { reason: string; dependency: string };
  effect?: IaoEffect;
  stale: boolean;
};

export type IaoFacadeOptions = Readonly<{
  /** Terminal requests stay readable this long before eviction. */
  retentionMs?: number;
  /** Hard bound on retained requests; only terminal ones are evicted. */
  maxRequests?: number;
}>;

type StoredRequest = {
  actorId: string;
  conversationId: string;
  fingerprint: string;
  session: IaoSession;
  response: IaoResponse;
  abort: AbortController;
  pending?: Promise<IaoResponse>;
  terminalAt?: number;
};

export class IaoRequestConflictError extends Error {}
export class IaoRequestNotFoundError extends Error {}

const DEFAULT_RETENTION_MS = 15 * 60_000;
const DEFAULT_MAX_REQUESTS = 10_000;

/** Request-scoped IAO identity. KARTA remains the only execution boundary. */
export class IaoFacade {
  readonly #requests = new Map<string, StoredRequest>();
  readonly #latestByConversation = new Map<string, string>();
  readonly #retentionMs: number;
  readonly #maxRequests: number;
  #lastSweep = 0;

  constructor(private readonly karta: KartaIaoPort, options: IaoFacadeOptions = {}) {
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.#maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    if (!Number.isInteger(this.#retentionMs) || this.#retentionMs < 1_000 || this.#retentionMs > 24 * 60 * 60_000 ||
      !Number.isInteger(this.#maxRequests) || this.#maxRequests < 1 || this.#maxRequests > 1_000_000) {
      throw new Error("Invalid IAO facade options");
    }
  }

  async submit(request: IaoRequest): Promise<IaoResponse> {
    assertIdentity(request);
    this.#sweep();
    const key = requestKey(request.tenantId, request.actorId, request.requestId);
    const fingerprint = fingerprintRequest(request);
    const existing = this.#requests.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IaoRequestConflictError("IAO request conflict");
      return replay(await (existing.pending ?? Promise.resolve(existing.response)));
    }

    const response: IaoResponse = {
      identity: "iao", requestId: request.requestId, tenantId: request.tenantId,
      conversationId: request.conversationId, status: "draft", updatedAt: nowIso(), stale: false,
    };
    const stored: StoredRequest = {
      actorId: request.actorId, conversationId: request.conversationId,
      fingerprint, session: request.identity.session, response, abort: new AbortController(),
    };
    this.#requests.set(key, stored);
    this.#latestByConversation.set(conversationKey(request.tenantId, request.actorId, request.conversationId), request.requestId);

    stored.pending = this.#prepare(request, stored);
    try { return clone(await stored.pending); }
    finally { stored.pending = undefined; }
  }

  get(tenantId: string, actorId: string, requestId: string): IaoResponse {
    this.#sweep();
    return clone(this.#lookup(tenantId, actorId, requestId).response);
  }

  /** Idempotent: a terminal request is returned unchanged; a pending one becomes `cancelled` with an uncertain effect. */
  cancel(tenantId: string, actorId: string, requestId: string): IaoResponse {
    this.#sweep();
    const stored = this.#lookup(tenantId, actorId, requestId);
    const response = stored.response;
    if (isTerminal(response)) return clone(response);
    response.status = "cancelled";
    response.effect = "uncertain";
    this.#settle(stored);
    stored.abort.abort();
    return clone(response);
  }

  recordKartaResult(tenantId: string, actorId: string, requestId: string, result: KartaIaoResult): IaoResponse {
    const stored = this.#requests.get(requestKey(tenantId, actorId, requestId));
    if (!stored) throw new IaoRequestNotFoundError("IAO request not found");
    return clone(this.#settleResult(stored, result));
  }

  #lookup(tenantId: string, actorId: string, requestId: string): StoredRequest {
    const stored = this.#requests.get(requestKey(tenantId, actorId, requestId));
    if (!stored || stored.actorId !== actorId) throw new IaoRequestNotFoundError("IAO request not found");
    return stored;
  }

  async #prepare(request: IaoRequest, stored: StoredRequest): Promise<IaoResponse> {
    let result: KartaIaoResult;
    try {
      result = await this.karta.prepare(request, stored.abort.signal);
    } catch (error) {
      result = { kind: "blocked", reason: "KARTA is unavailable", dependency: safeDependency(error) };
    }
    return this.#settleResult(stored, result);
  }

  #settleResult(stored: StoredRequest, result: KartaIaoResult): IaoResponse {
    const response = stored.response;
    if (isTerminal(response)) return this.#late(stored, result);
    response.stale = this.#latestByConversation.get(
      conversationKey(response.tenantId, stored.actorId, stored.conversationId),
    ) !== response.requestId;
    return result.kind === "blocked"
      ? this.#block(stored, result.dependency, result.effect)
      : this.#apply(stored, result);
  }

  /** A result landing after cancellation only refines effect knowledge; the terminal status never changes. */
  #late(stored: StoredRequest, result: KartaIaoResult): IaoResponse {
    const response = stored.response;
    if (response.status !== "cancelled") return response;
    if (result.kind === "blocked") {
      if (result.effect === "none") { response.effect = "none"; touch(response); }
      return response;
    }
    let receipt: IaoReceipt | undefined;
    try { receipt = acceptedReceipt(result, response.requestId, stored.session); }
    catch { return response; }
    if (receipt) response.memoryControl = forStorage(receipt);
    if (result.evidence) { response.proof = result.evidence; response.effect = "executed"; touch(response); }
    return response;
  }

  #apply(stored: StoredRequest, result: Extract<KartaIaoResult, { kind: "accepted" }>): IaoResponse {
    const response = stored.response;
    let receipt: IaoReceipt | undefined;
    try { receipt = acceptedReceipt(result, response.requestId, stored.session); }
    catch (error) { return this.#block(stored, safeDependency(error)); }
    if (result.preview !== undefined) response.preview = result.preview;
    if (receipt) response.memoryControl = forStorage(receipt);
    if (result.evidence && !response.stale) {
      response.proof = result.evidence;
      response.status = "verified";
      this.#settle(stored);
    } else if (result.preview !== undefined || result.memoryControl) {
      response.status = "partial";
      touch(response);
    }
    return deliver(response, receipt);
  }

  #block(stored: StoredRequest, dependency?: string, effect?: IaoEffect): IaoResponse {
    const response = stored.response;
    if (isTerminal(response)) return response;
    const denied = dependency?.startsWith("memory-denied:");
    response.status = "blocked";
    response.blocked = denied
      ? { reason: "KARTA request denied", dependency: "memory-denied:karta-runtime" }
      : { reason: "KARTA is unavailable", dependency: dependency?.startsWith("memory-unavailable:") ? "memory-unavailable:karta-runtime" : "karta-runtime" };
    if (effect) response.effect = effect;
    this.#settle(stored);
    return response;
  }

  #settle(stored: StoredRequest): void {
    stored.terminalAt = Date.now();
    touch(stored.response);
  }

  /** Lazy lease sweep: terminal requests expire after retention; pending ones are never evicted. */
  #sweep(): void {
    const now = Date.now();
    const overCapacity = this.#requests.size > this.#maxRequests;
    if (!overCapacity && now - this.#lastSweep < Math.min(this.#retentionMs / 4, 60_000)) return;
    this.#lastSweep = now;
    for (const [key, stored] of this.#requests) {
      if (stored.pending || stored.terminalAt === undefined) continue;
      const expired = now - stored.terminalAt >= this.#retentionMs;
      if (!expired && this.#requests.size <= this.#maxRequests) continue;
      this.#requests.delete(key);
      const conversation = conversationKey(stored.response.tenantId, stored.actorId, stored.conversationId);
      if (this.#latestByConversation.get(conversation) === stored.response.requestId) this.#latestByConversation.delete(conversation);
    }
  }
}

function isTerminal(response: IaoResponse): boolean {
  return response.status === "verified" || response.status === "blocked" || response.status === "cancelled";
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

/** Normalizes the optional receipt and validates it against the evidence; throws on any inconsistency. */
function acceptedReceipt(
  result: Extract<KartaIaoResult, { kind: "accepted" }>, requestId: string, session: IaoSession,
): IaoReceipt | undefined {
  const receipt = result.memoryControl === undefined ? undefined : normalizeIaoReceipt(result.memoryControl);
  assertAccepted(result, requestId, session, receipt);
  return receipt;
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
function nowIso(): string { return new Date().toISOString(); }
function touch(response: IaoResponse): void { response.updatedAt = nowIso(); }
function clone<T>(value: T): T { return structuredClone(value); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
