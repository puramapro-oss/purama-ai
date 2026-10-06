import { createHash } from "node:crypto";
import type { IaoMemoryAction, IaoReceipt, IaoRequest, KartaIaoPort, KartaIaoResult } from "./iaoFacade.js";

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
    idempotencyKey: string; tenantId: string; actorId: string; conversationId: string; message: string;
  }>): Promise<Readonly<{ operationId: string; context: IaoContextPack }>>;
  control(input: Readonly<{
    idempotencyKey: string; tenantId: string; actorId: string; action: IaoMemoryAction; data: Record<string, unknown>;
  }>): Promise<IaoReceipt>;
}

export interface IaoCompletionPort {
  complete(input: Readonly<{
    requestId: string; idempotencyKey: string; message: string; context: IaoContextPack;
  }>): Promise<Readonly<{ text: string; modelVersion: string }>>;
}

/** Thin adapter only: KARTA coordinates; SMARANA remembers; the provider computes. */
export class KartaRuntimeIaoPort implements KartaIaoPort {
  constructor(
    private readonly smarana: SmaranaIaoPort,
    private readonly completion: IaoCompletionPort,
    private readonly timeoutMs = 120_000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) throw new Error("Invalid IAO timeout");
  }

  async prepare(request: IaoRequest): Promise<KartaIaoResult> {
    try {
      if (request.type === "memory-control") return await this.#control(request);
      if (request.type !== "conversation" || request.memoryControl) return blocked("memory-denied:unsupported-request");
      const prepared = await bounded(this.smarana.buildContext({
        idempotencyKey: request.requestId, tenantId: request.tenantId, actorId: request.actorId,
        conversationId: request.conversationId, message: request.prompt,
      }), this.timeoutMs);
      assertUuid(prepared.operationId);
      const completion = await bounded(this.completion.complete({
        requestId: request.requestId, idempotencyKey: completionIdempotencyKey(request),
        message: request.prompt, context: prepared.context,
      }), this.timeoutMs);
      if (!completion.text.trim() || completion.text.length > 256_000 || !completion.modelVersion.trim()) {
        throw new Error("memory-unavailable:compute-fabric-malformed");
      }
      return {
        kind: "accepted", preview: completion.text,
        evidence: evidence(request.requestId, prepared.operationId),
      };
    } catch (error) {
      return blocked(safeDependency(error));
    }
  }

  async #control(request: IaoRequest): Promise<KartaIaoResult> {
    if (!request.memoryControl) return blocked("memory-denied:missing-control");
    const receipt = await bounded(this.smarana.control({
      idempotencyKey: request.requestId, tenantId: request.tenantId, actorId: request.actorId,
      action: request.memoryControl.action, data: request.memoryControl.data,
    }), this.timeoutMs);
    assertUuid(receipt.operationId);
    if (receipt.action !== request.memoryControl.action) throw new Error("memory-unavailable:receipt-mismatch");
    return { kind: "accepted", memoryControl: receipt, evidence: evidence(request.requestId, receipt.operationId) };
  }
}

function completionIdempotencyKey(request: Pick<IaoRequest, "tenantId" | "actorId" | "requestId">): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([request.tenantId, request.actorId, request.requestId]))
    .digest("hex");
  return `iao:${digest}`;
}

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("memory-unavailable:timeout")), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
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
function blocked(dependency: string): KartaIaoResult {
  return { kind: "blocked", reason: dependency.startsWith("memory-denied:") ? "KARTA request denied" : "KARTA is unavailable", dependency };
}
