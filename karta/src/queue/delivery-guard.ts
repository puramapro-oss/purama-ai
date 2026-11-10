import { supabase } from "../db/supabase.js";
import { CycleDeliveryConflictError, type CycleDeliveryIdentity } from "./delivery-identity.js";
import type { AgentCycleJobData } from "./queues.js";

/**
 * Preflight for legacy migration and useful producer errors. The unique SQL
 * execution claim plus its fingerprint comparison remains the atomic guard.
 * Old and new worker versions must not run concurrently during the rollout.
 */
export async function assertCycleDeliveryCompatible(
  data: AgentCycleJobData, identity: CycleDeliveryIdentity,
): Promise<void> {
  if (identity.kind !== "dedupe") return;
  try {
    if (!identity.legacyKeyPrefix || !/^queue:karta-[0-9a-f]{64}:$/.test(identity.legacyKeyPrefix)) throw new Error();
    const [legacy, current] = await Promise.all([
      supabase.from("karta_runs").select("id")
        .eq("user_id", data.userId).eq("agent_type", data.agentType)
        .like("execution_key", `${identity.legacyKeyPrefix}%`).limit(1),
      supabase.from("karta_runs").select("execution_fingerprint")
        .eq("user_id", data.userId).eq("agent_type", data.agentType)
        .eq("execution_key", identity.executionKey).maybeSingle(),
    ]);
    if (legacy.error || current.error || !Array.isArray(legacy.data) || current.data === undefined) throw new Error();
    if (legacy.data.length > 0) {
      // Legacy journals have no fingerprint of the original payload. A known
      // completed result cannot prove that this caller sent the same content.
      throw new CycleDeliveryConflictError("Demande ancienne déjà réservée : vérifier son résultat avant toute reprise");
    }
    if (current.data && current.data.execution_fingerprint !== identity.fingerprint) {
      throw new CycleDeliveryConflictError();
    }
  } catch (error) {
    if (error instanceof CycleDeliveryConflictError) throw error;
    throw new Error("Vérification de la demande temporairement indisponible");
  }
}
