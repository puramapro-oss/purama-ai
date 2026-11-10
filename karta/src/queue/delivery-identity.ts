import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../lib/canonical-json.js";
import type { AgentCycleJobData } from "./queues.js";

/** Server-owned metadata. It never contains the request's raw idempotency key. */
export interface CycleDeliveryMetadata {
  version: 2;
  kind: "dedupe" | "delivery";
  token: string;
  fingerprint: string;
}

export interface CycleDeliveryIdentity {
  kind: "dedupe" | "delivery" | "legacy";
  executionKey: string;
  fingerprint: string;
  /** Older workers persisted queue:<unscoped job id>:<timestamp>. */
  legacyKeyPrefix?: string;
}

export class CycleDeliveryConflictError extends Error {
  constructor(message = "Identité de demande réutilisée avec un contenu différent ou non vérifiable") {
    super(message);
    this.name = "CycleDeliveryConflictError";
  }
}

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const V2_JOB_ID = /^karta-v2-(dedupe|delivery)-[0-9a-f]{64}$/;
const LEGACY_DEDUPE_JOB_ID = /^karta-([0-9a-f]{64})$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

// JSON normalization matches what BullMQ persists (undefined, Date, etc.). The
// copy is made before any await so callers cannot change the queued contract.
function copyContent(data: AgentCycleJobData): AgentCycleJobData {
  try {
    const copy: AgentCycleJobData = JSON.parse(JSON.stringify({
      agentType: data.agentType, userId: data.userId, trigger: data.trigger,
    }));
    if (typeof copy.agentType !== "string" || !copy.agentType
      || typeof copy.userId !== "string" || !copy.userId
      || !copy.trigger || typeof copy.trigger !== "object" || Array.isArray(copy.trigger)
      || typeof copy.trigger.type !== "string" || typeof copy.trigger.source !== "string") {
      throw new CycleDeliveryConflictError();
    }
    return copy;
  } catch {
    throw new CycleDeliveryConflictError("Contenu de demande non vérifiable");
  }
}

function jobIdFor(data: AgentCycleJobData, kind: CycleDeliveryMetadata["kind"], token: string): string {
  const scoped = hash(JSON.stringify([data.userId, data.agentType, token]));
  return `karta-v2-${kind}-${scoped}`;
}

/** API callers receive this server-computed key; browsers must not infer it. */
export function getQueuedExecutionKey(jobId: string | undefined): string | undefined {
  return jobId && V2_JOB_ID.test(jobId) ? `queue:v2:${jobId}` : undefined;
}

export function createCycleDelivery(data: AgentCycleJobData, dedupeKey?: string): {
  data: AgentCycleJobData & { delivery: CycleDeliveryMetadata };
  jobId: string;
  identity: CycleDeliveryIdentity;
} {
  const content = copyContent(data);
  const delivery: CycleDeliveryMetadata = {
    version: 2,
    kind: dedupeKey ? "dedupe" : "delivery",
    token: dedupeKey ? hash(dedupeKey) : randomUUID(),
    fingerprint: hash(canonicalJson(content)),
  };
  const jobId = jobIdFor(content, delivery.kind, delivery.token);
  return {
    data: { ...content, delivery }, jobId,
    identity: {
      kind: delivery.kind,
      executionKey: getQueuedExecutionKey(jobId)!,
      fingerprint: delivery.fingerprint,
      ...(delivery.kind === "dedupe" ? { legacyKeyPrefix: `queue:karta-${delivery.token}:` } : {}),
    },
  };
}

export function resolveCycleDelivery(job: {
  id?: string;
  timestamp: number;
  data: AgentCycleJobData;
}): CycleDeliveryIdentity {
  const content = copyContent(job.data);
  const fingerprint = hash(canonicalJson(content));
  const metadata = job.data.delivery;
  if (metadata !== undefined) {
    if (!metadata || metadata.version !== 2
      || (metadata.kind !== "dedupe" && metadata.kind !== "delivery")
      || typeof metadata.token !== "string"
      || !(metadata.kind === "dedupe" ? HEX_DIGEST : UUID).test(metadata.token)
      || typeof metadata.fingerprint !== "string" || metadata.fingerprint !== fingerprint
      || job.id !== jobIdFor(content, metadata.kind, metadata.token)) {
      throw new CycleDeliveryConflictError();
    }
    return {
      kind: metadata.kind, executionKey: getQueuedExecutionKey(job.id)!, fingerprint,
      ...(metadata.kind === "dedupe" ? { legacyKeyPrefix: `queue:karta-${metadata.token}:` } : {}),
    };
  }

  // Old queued deduplicated deliveries map to the same scoped identity as v2.
  // The guard must first refuse any legacy journal whose content is unprovable.
  const legacyDedupe = job.id?.match(LEGACY_DEDUPE_JOB_ID);
  if (legacyDedupe) {
    const jobId = jobIdFor(content, "dedupe", legacyDedupe[1]);
    return {
      kind: "dedupe", executionKey: getQueuedExecutionKey(jobId)!, fingerprint,
      legacyKeyPrefix: `queue:${job.id}:`,
    };
  }

  // Retain the exact identity of ordinary jobs already in the old queue. A
  // timestamp is only a legacy lookup component, never the identity of a new
  // business request. Missing v2 metadata must not fall through to this path.
  if (!job.id || job.id.startsWith("karta-v2-")
    || !Number.isFinite(job.timestamp) || job.timestamp < 0) throw new CycleDeliveryConflictError();
  return { kind: "legacy", executionKey: `queue:${job.id}:${job.timestamp}`, fingerprint };
}
