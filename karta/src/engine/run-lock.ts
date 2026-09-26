import { redisConnection } from "../queue/redis.js";

/**
 * Sérialisation opportuniste des patchs d'un MÊME karta_runs (P0 IAO sous-lot 8).
 *
 * patchParentRun (approval.ts) fait un read-modify-write du JSONB tools_used : deux
 * résolutions d'actions du même run finalisées en parallèle peuvent se perdre un patch
 * (lost-update display — le dernier écrivain gagne). Ce verrou Redis court sérialise les
 * patchs d'un même run ; il est VOLONTAIREMENT best-effort :
 * - budget d'attente 2s : au-delà, on procède sans verrou (jamais bloquer un clic humain
 *   sur du display — le pire cas est la race d'avant ce fix, pas un blocage) ;
 * - Redis injoignable → on procède sans verrou (comportement d'avant ce fix) ;
 * - TTL court (10s) : borne un crash entre acquire et release.
 * L'exécution de l'outil, elle, reste exactement-une-fois via claimPendingAction — ce
 * verrou ne protège QUE la cohérence d'affichage du journal parent.
 */

const RUN_LOCK_TTL_MS = 10_000;
const WAIT_POLL_MS = 50;
const WAIT_BUDGET_MS = 2_000;

/** Deadline par opération Redis. Indispensable : la connexion partagée est construite avec
 * maxRetriesPerRequest: null (exigé par BullMQ) — sur connexion perdue, ioredis ne REJETTE
 * pas la commande, il la met en file offline indéfiniment. Sans cette deadline, le budget
 * 2s ne démarrait même pas (il ne compte que les sleeps) et le clic humain pendrait. */
const OP_DEADLINE_MS = 300;

function withRedisDeadline<T>(op: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), OP_DEADLINE_MS);
  });
  // op→null sur rejet : une commande rejetée (et non pendante) doit aussi dégrader, jamais
  // faire échouer le patch parent pour un problème de sérialisation.
  return Promise.race([op.then(
    (v) => v,
    () => null
  ), deadline]).finally(() => clearTimeout(timer));
}

async function tryAcquire(key: string): Promise<boolean> {
  const result = await withRedisDeadline(redisConnection.set(key, "1", "PX", RUN_LOCK_TTL_MS, "NX"));
  return result === "OK"; // null = outage/rejet/occupé → pas acquis
}

export async function withRunSerialization<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const key = `karta:run-lock:${runId}`;
  const deadline = Date.now() + WAIT_BUDGET_MS;
  let acquired = await tryAcquire(key);
  while (!acquired && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    acquired = await tryAcquire(key);
  }
  // acquired=false ici = budget épuisé ou Redis down → best-effort : fn sans verrou.

  try {
    return await fn();
  } finally {
    if (acquired) {
      // Deadline aussi au release : un del pendant ne doit pas faire pendre la réponse après
      // que fn a réussi. Abandon → le TTL (10s) reprend le verrou.
      await withRedisDeadline(redisConnection.del(key));
    }
  }
}
