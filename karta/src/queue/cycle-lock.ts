import { randomUUID } from "node:crypto";
import { redisConnection } from "./redis.js";
import type { AgentType } from "../engine/types.js";

/**
 * Verrou anti-double-exécution par (agentType, userId) — voir l'historique complet dans
 * queue/queues.ts. Extrait de queues.ts en propre module (sous-lot 9) pour être testable
 * sans construire la Queue BullMQ, et durci d'un OWNER-TOKEN :
 *
 * Avant : release = DEL inconditionnel — si un cycle dépassait le TTL (600s), son verrou
 * expirait, un successeur l'acquérait, puis le finally du PREMIER cycle détruisait le
 * verrou du successeur → une 3e admission devenait possible. Maintenant : la valeur du
 * verrou est un token unique par acquisition, et le release ne DEL que SI la valeur est
 * ENCORE la sienne (compare-and-del atomique, script Lua). Le release d'un cycle dépassé
 * ne touche plus jamais le verrou d'autrui.
 *
 * Pas de deadline ioredis ici (contrairement à engine/run-lock.ts) : ce verrou vit dans le
 * worker, alimenté par la Queue BullMQ — si Redis est down, plus AUCUN job n'arrive, la
 * pendaison éventuelle d'un acquire est indissociable de l'arrêt de la queue elle-même.
 */

const CYCLE_LOCK_TTL_S = 600;

export interface CycleLockHandle {
  agentType: AgentType;
  userId: string;
  /** Preuve d'ownership — seuls les holders du token peuvent libérer (compare-and-del). */
  token: string;
}

function cycleLockKey(agentType: AgentType, userId: string): string {
  return `karta:cycle-lock:${agentType}:${userId}`;
}

/** SET NX EX atomique — handle si le verrou vient d'être acquis, null s'il est déjà tenu. */
export async function tryAcquireCycleLock(agentType: AgentType, userId: string): Promise<CycleLockHandle | null> {
  const token = randomUUID();
  const result = await redisConnection.set(cycleLockKey(agentType, userId), token, "EX", CYCLE_LOCK_TTL_S, "NX");
  return result === "OK" ? { agentType, userId, token } : null;
}

const RELEASE_IF_OWNER = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Libère le verrou UNIQUEMENT s'il appartient encore au handle (compare-and-del atomique).
 * Non fatale : en cas d'échec Redis, le TTL (600s) borne la panne. */
export async function releaseCycleLock(handle: CycleLockHandle): Promise<void> {
  try {
    await redisConnection.eval(RELEASE_IF_OWNER, 1, cycleLockKey(handle.agentType, handle.userId), handle.token);
  } catch (err) {
    console.error(`[cycle-lock] releaseCycleLock(${handle.agentType}:${handle.userId}) a échoué — TTL de secours actif :`, err);
  }
}
