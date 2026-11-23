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
    let deadline: StageDeadline | undefined;
    try {
      if (request.type === "memory-control") {
        stage = "control";
        deadline = createStageDeadline(this.timeoutMs);
        const result = await this.#control(request, controller, deadline);
        assertCurrent(deadline, controller);
        return result;
      }
      if (request.type !== "conversation" || request.memoryControl) return blocked("memory-denied:unsupported-request");
      deadline = createStageDeadline(this.timeoutMs);
      const prepared = await bounded(() => this.smarana.buildContext({
        idempotencyKey: durableRequestKey(request), payloadDigest: smaranaPayloadDigest(request),
        tenantId: request.tenantId, actorId: request.actorId,
        conversationId: request.conversationId, message: request.prompt, signal: controller.signal,
      }), deadline, controller);
      assertCurrent(deadline, controller);
      const operationId = prepared.operationId;
      assertUuid(operationId);
      const context = prepared.context;
      assertCurrent(deadline, controller);
      stage = "completion";
      deadline = createStageDeadline(this.timeoutMs);
      const completion = await bounded(() => this.completion.complete({
        requestId: request.requestId, idempotencyKey: completionIdempotencyKey(request),
        payloadDigest: completionPayloadDigest(request), message: request.prompt, context,
        signal: controller.signal,
      }), deadline, controller);
      assertCurrent(deadline, controller);
      const { text, modelVersion } = completion;
      if (!text.trim() || text.length > 256_000 || !modelVersion.trim()) {
        throw new Error("memory-unavailable:compute-fabric-malformed");
      }
      const result: KartaIaoResult = {
        kind: "accepted", preview: text,
        evidence: evidence(request.requestId, operationId),
      };
      assertCurrent(deadline, controller);
      return result;
    } catch (error) {
      // Validation can itself cross the deadline or abort before throwing.
      // Preserve interruption evidence through the public acceptance boundary.
      let failure = error;
      if (deadline) {
        try { assertCurrent(deadline, controller); } catch (interruption) { failure = interruption; }
      }
      return blocked(safeDependency(failure), effectAfter(stage, failure));
    } finally {
      signal?.removeEventListener("abort", forward);
    }
  }

  async #control(request: IaoRequest, controller: AbortController, deadline: StageDeadline): Promise<KartaIaoResult> {
    if (!request.memoryControl) return blocked("memory-denied:missing-control");
    const returned = await bounded(() => this.smarana.control({
      idempotencyKey: durableRequestKey(request), payloadDigest: smaranaPayloadDigest(request),
      tenantId: request.tenantId, actorId: request.actorId,
      action: request.memoryControl!.action, data: request.memoryControl!.data, signal: controller.signal,
    }), deadline, controller);
    assertCurrent(deadline, controller);
    const receipt = normalizeIaoReceipt(returned, request.memoryControl.action);
    const result: KartaIaoResult = { kind: "accepted", memoryControl: receipt, evidence: evidence(request.requestId, receipt.operationId) };
    assertCurrent(deadline, controller);
    return result;
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

/** One absolute budget survives every Promise handoff and local validation of its stage. */
type StageDeadline = {
  readonly expiresAt: number;
  dispatched: boolean;
  interruptionCause?: typeof TIMEOUT | typeof CANCELLED;
};

function createStageDeadline(timeoutMs: number): StageDeadline {
  return { expiresAt: performance.now() + timeoutMs, dispatched: false };
}

function interruption(deadline: StageDeadline, message: typeof TIMEOUT | typeof CANCELLED): Error {
  deadline.interruptionCause ??= message;
  return deadline.dispatched ? new Error(deadline.interruptionCause) : new PreDispatchCancellation(deadline.interruptionCause);
}

function assertCurrent(deadline: StageDeadline, controller: AbortController): void {
  const message = deadline.interruptionCause ??
    (controller.signal.aborted ? CANCELLED : performance.now() >= deadline.expiresAt ? TIMEOUT : undefined);
  if (message) {
    const error = interruption(deadline, message);
    controller.abort();
    throw error;
  }
}

/** Timeout aborts the shared controller so every downstream port sees the same interruption; an aborted signal never dispatches. */
async function bounded<T>(start: () => Promise<T>, deadline: StageDeadline, controller: AbortController): Promise<T> {
  const { signal } = controller;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    assertCurrent(deadline, controller);
    const result = await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(interruption(deadline, CANCELLED));
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        // Record the cause before abort synchronously invokes the listener.
        reject(interruption(deadline, TIMEOUT));
        controller.abort();
      }, Math.max(0, Math.ceil(deadline.expiresAt - performance.now())));
      Promise.resolve().then(() => {
        assertCurrent(deadline, controller);
        deadline.dispatched = true;
        return start();
      }).then(resolve, reject);
    });
    assertCurrent(deadline, controller);
    return result;
  } catch (error) {
    assertCurrent(deadline, controller);
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    // A successful context and the following completion share this controller.
    // Only interruption may abort it; normal cleanup must keep it usable.
  }
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
