import { createHash } from "node:crypto";
import { normalizeIaoReceipt } from "./iaoFacade.js";
import type { IaoEffect, IaoMemoryAction, IaoReceipt, IaoRequest, KartaIaoPort, KartaIaoResult } from "./iaoFacade.js";

export type IaoContextSource = Readonly<{
  text: string;
  sensitivity: "normal" | "personal" | "finance" | "health";
  relevance: number;
  authorized: boolean;
}>;
export type IaoContextPack = Readonly<{ sources: readonly IaoContextSource[] }>;

/** Injected SMARANA boundary. Implementations own policy, consent and persistence. */
export interface SmaranaIaoPort {
  buildContext(input: Readonly<{
    idempotencyKey: string; payloadDigest: string; tenantId: string; actorId: string; conversationId: string; message: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ operationId: string; context: IaoContextPack }>>;
  control(input: Readonly<{
    idempotencyKey: string; payloadDigest: string; tenantId: string; actorId: string; action: IaoMemoryAction; data: Record<string, unknown>;
    signal?: AbortSignal;
  }>): Promise<IaoReceipt>;
}

export interface IaoCompletionPort {
  complete(input: Readonly<{
    requestId: string; idempotencyKey: string; payloadDigest: string; message: string; context: IaoContextPack;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ text: string; modelVersion: string }>>;
}

type Stage = "context" | "completion" | "control";

/** Thin adapter only: KARTA coordinates; SMARANA remembers; the provider computes. */
export class KartaRuntimeIaoPort implements KartaIaoPort {
  constructor(
    private readonly smarana: SmaranaIaoPort,
    private readonly completion: IaoCompletionPort,
    private readonly timeoutMs = 120_000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) throw new Error("Invalid IAO timeout");
  }

  async prepare(request: IaoRequest, signal?: AbortSignal): Promise<KartaIaoResult> {
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", forward, { once: true });
    let stage: Stage = "context";
    try {
      if (request.type === "memory-control") {
        stage = "control";
        return await this.#control(request, controller);
      }
      if (request.type !== "conversation" || request.memoryControl) return blocked("memory-denied:unsupported-request");
      const prepared = await bounded(() => this.smarana.buildContext({
        idempotencyKey: durableRequestKey(request), payloadDigest: smaranaPayloadDigest(request),
        tenantId: request.tenantId, actorId: request.actorId,
        conversationId: request.conversationId, message: request.prompt, signal: controller.signal,
      }), this.timeoutMs, controller);
      assertUuid(prepared.operationId);
      stage = "completion";
      const completion = await bounded(() => this.completion.complete({
        requestId: request.requestId, idempotencyKey: completionIdempotencyKey(request),
        payloadDigest: completionPayloadDigest(request), message: request.prompt, context: prepared.context,
        signal: controller.signal,
      }), this.timeoutMs, controller);
      if (!completion.text.trim() || completion.text.length > 256_000 || !completion.modelVersion.trim()) {
        throw new Error("memory-unavailable:compute-fabric-malformed");
      }
      return {
        kind: "accepted", preview: completion.text,
        evidence: evidence(request.requestId, prepared.operationId),
      };
    } catch (error) {
      return blocked(safeDependency(error), effectAfter(stage, error));
    } finally {
      signal?.removeEventListener("abort", forward);
    }
  }

  async #control(request: IaoRequest, controller: AbortController): Promise<KartaIaoResult> {
    if (!request.memoryControl) return blocked("memory-denied:missing-control");
    const receipt = normalizeIaoReceipt(await bounded(() => this.smarana.control({
      idempotencyKey: durableRequestKey(request), payloadDigest: smaranaPayloadDigest(request),
      tenantId: request.tenantId, actorId: request.actorId,
      action: request.memoryControl!.action, data: request.memoryControl!.data, signal: controller.signal,
    }), this.timeoutMs, controller), request.memoryControl.action);
    return { kind: "accepted", memoryControl: receipt, evidence: evidence(request.requestId, receipt.operationId) };
  }
}

function completionIdempotencyKey(request: Pick<IaoRequest, "tenantId" | "actorId" | "requestId">): string {
  return durableRequestKey(request);
}

function durableRequestKey(request: Pick<IaoRequest, "tenantId" | "actorId" | "requestId">): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([request.tenantId, request.actorId, request.requestId]))
    .digest("hex");
  return `iao:${digest}`;
}

function smaranaPayloadDigest(request: IaoRequest): string {
  return createHash("sha256").update(canonicalize({
    type: request.type,
    conversationId: request.conversationId,
    prompt: request.prompt,
    memoryControl: request.memoryControl,
  })).digest("hex");
}

function completionPayloadDigest(request: Pick<IaoRequest, "type" | "conversationId" | "prompt">): string {
  return createHash("sha256")
    .update(JSON.stringify([request.type, request.conversationId, request.prompt]))
    .digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

const TIMEOUT = "memory-unavailable:timeout";
const CANCELLED = "memory-unavailable:cancelled";

/** Internal evidence that this dependency was never invoked. */
class PreDispatchCancellation extends Error {}

/** Timeout aborts the shared controller so every downstream port sees the same interruption; an aborted signal never dispatches. */
function bounded<T>(start: () => Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  const { signal } = controller;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(new PreDispatchCancellation(CANCELLED)); return; }
    const timer = setTimeout(() => { controller.abort(); reject(new Error(TIMEOUT)); }, timeoutMs);
    let dispatched = false;
    const onAbort = () => {
      clearTimeout(timer);
      reject(dispatched ? new Error(CANCELLED) : new PreDispatchCancellation(CANCELLED));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new PreDispatchCancellation(CANCELLED);
      dispatched = true;
      return start();
    }).then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/** Only an interruption yields effect knowledge; a context build is a read with a durable receipt, never a user-visible effect. */
function effectAfter(stage: Stage, error: unknown): IaoEffect | undefined {
  if (error instanceof PreDispatchCancellation) return "none";
  const message = error instanceof Error ? error.message : "";
  if (message !== TIMEOUT && message !== CANCELLED) return undefined;
  return stage === "context" ? "none" : "uncertain";
}
function evidence(requestId: string, proofId: string) {
  return { source: "karta" as const, requestId, proofId, completedAt: new Date().toISOString() };
}
function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("memory-unavailable:missing-durable-receipt");
  }
}
function safeDependency(error: unknown): string {
  const message = error instanceof Error ? error.message : "memory-unavailable:karta-runtime";
  return message.startsWith("memory-denied:") ? "memory-denied:karta-runtime" : "memory-unavailable:karta-runtime";
}
function blocked(dependency: string, effect?: IaoEffect): KartaIaoResult {
  return {
    kind: "blocked", reason: dependency.startsWith("memory-denied:") ? "KARTA request denied" : "KARTA is unavailable", dependency,
    ...(effect ? { effect } : {}),
  };
}
