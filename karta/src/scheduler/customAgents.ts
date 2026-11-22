import cron, { type ScheduledTask } from "node-cron";
import { listKartaEnabledCustomAgents } from "../agents/customAgent.js";
import { enqueueAgentCycle } from "../queue/queues.js";

interface RegisteredJob {
  task: ScheduledTask;
  cronExpr: string;
}

interface SchedulerWork {
  cycles: Set<Promise<void>>;
  cleanups: Set<Promise<void>>;
  cleanupFailed: boolean;
}

function createSchedulerWork(): SchedulerWork {
  return { cycles: new Set(), cleanups: new Set(), cleanupFailed: false };
}

const registeredJobs = new Map<string, RegisteredJob>();
let currentWork = createSchedulerWork();
let generation = 0;
let stopped = false;
let refreshInFlight: Promise<void> | null = null;
let refreshAbort: AbortController | null = null;
const SCAN_TIMEOUT_MS = 30_000;

/** The runtime only needs to stop this group, not operate its private scan timer. */
type SchedulerController = Pick<ScheduledTask, "stop" | "destroy">;
let activeScheduler: SchedulerController | null = null;

function destroyTask(task: ScheduledTask, owner: SchedulerWork): void {
  // Inline node-cron timers destroy synchronously, but its public contract also
  // permits asynchronous implementations. Never detach a rejected cleanup promise.
  try {
    const cleanup = Promise.resolve(task.destroy()).catch(() => {
      owner.cleanupFailed = true;
      console.error("[custom-agents] destruction du timer non confirmée");
    });
    owner.cleanups.add(cleanup);
    void cleanup.then(() => { owner.cleanups.delete(cleanup); });
  } catch {
    owner.cleanupFailed = true;
    console.error("[custom-agents] destruction du timer non confirmée");
  }
}

/**
 * Réévalue les agents créés par les utilisateurs et (dés)enregistre leurs jobs node-cron en
 * conséquence — contrairement aux 16 agents statiques (planifiés 1 fois au démarrage, cf cron.ts),
 * ceux-ci peuvent apparaître, être replanifiés ou désactivés à tout moment depuis l'UI.
 */
export async function refreshCustomAgentSchedules(): Promise<void> {
  if (stopped) return;
  if (refreshInFlight) return refreshInFlight;
  const controller = new AbortController();
  let rejectAborted!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(new Error("Scan des agents expiré ou arrêté"));
    controller.signal.addEventListener("abort", rejectAborted, { once: true });
  });
  const deadline = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  deadline.unref();
  // Abort the real database request and also bound the wait if a client ignores
  // the signal. The scan checks this same signal before changing the registry.
  const scan = Promise.race([refreshSchedules(generation, controller.signal), aborted]);
  refreshInFlight = scan;
  refreshAbort = controller;
  try {
    await scan;
  } finally {
    clearTimeout(deadline);
    controller.signal.removeEventListener("abort", rejectAborted);
    // A stopped generation must not clear the new generation's in-flight scan.
    if (refreshInFlight === scan) refreshInFlight = null;
    if (refreshAbort === controller) refreshAbort = null;
  }
}

async function refreshSchedules(scanGeneration: number, signal: AbortSignal): Promise<void> {
  const owner = currentWork;
  const agents = await listKartaEnabledCustomAgents(signal);
  if (signal.aborted || stopped || scanGeneration !== generation) return;
  const stillValid = new Map(agents.map((a) => [a.id, a]));

  for (const [id, job] of registeredJobs) {
    const agent = stillValid.get(id);
    const shouldRun = agent && agent.schedule_enabled && agent.schedule_cron === job.cronExpr;
    if (!shouldRun) {
      registeredJobs.delete(id);
      destroyTask(job.task, owner);
    }
  }

  for (const agent of agents) {
    if (!agent.schedule_enabled || !agent.schedule_cron || registeredJobs.has(agent.id)) continue;

    if (!cron.validate(agent.schedule_cron)) {
      console.error("[custom-agents] cron invalide : planification ignorée");
      continue;
    }

    const cronExpr = agent.schedule_cron;
    const slotEnd = cronExpr.trim().split(/\s+/).length === 6 ? 19 : 16;
    const task = cron.schedule(cronExpr, (context) => {
      // stop/destroy cannot retract an already-dispatched timer callback. Also
      // reject callbacks from removed schedules and previous runtime generations.
      if (stopped || scanGeneration !== generation || registeredJobs.get(agent.id)?.task !== task) return;
      // Register before running the callback so shutdown can drain every admitted
      // producer, even when its timer was replaced by a later database scan.
      const cycle = Promise.resolve().then(async () => {
        if (stopped || scanGeneration !== generation || registeredJobs.get(agent.id)?.task !== task) return;
        try {
          // Delayed callbacks and separate instances share the scheduled instant,
          // not their local wall clock. Preserve minute keys for five-field cron,
          // and retain seconds for six-field cron so distinct ticks never merge.
          const slot = context.date.toISOString().slice(0, slotEnd);
          await enqueueAgentCycle(
            {
              agentType: `custom:${agent.id}`,
              userId: agent.user_id,
              trigger: { type: "cron", source: `custom-agent:${agent.name}`, payload: { slot } },
            },
            { dedupeKey: `cron|custom:${agent.id}|${agent.user_id}|${slot}` }
          );
        } catch {
          console.error("[custom-agents] mise en file non confirmée : vérifier la demande avant toute reprise");
        }
      });
      owner.cycles.add(cycle);
      void cycle.then(() => { owner.cycles.delete(cycle); }, () => { owner.cycles.delete(cycle); });
      return cycle;
    });
    registeredJobs.set(agent.id, { task, cronExpr });
  }
}

/** Démarre le scheduler des agents créés : 1er scan immédiat + réévaluation toutes les 5 min. */
export function startCustomAgentScheduler(): SchedulerController {
  if (activeScheduler) return activeScheduler;
  if (stopped) currentWork = createSchedulerWork();
  stopped = false;
  const owner = currentWork;
  const schedulerGeneration = generation;
  const refreshSafely = async () => {
    if (stopped || schedulerGeneration !== generation) return;
    try {
      await refreshCustomAgentSchedules();
    } catch {
      if (stopped || schedulerGeneration !== generation) return;
      console.error("[custom-agents] scan échoué : nouvelle tentative au prochain passage");
    }
  };
  const scanTimer = cron.schedule("*/5 * * * *", refreshSafely);
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    if (activeScheduler !== controller) return Promise.resolve();
    // Invalidate callbacks and outstanding reads before touching timer resources.
    stopped = true;
    generation++;
    activeScheduler = null;
    const retiringScan = refreshInFlight;
    refreshAbort?.abort();
    refreshAbort = null;
    refreshInFlight = null;
    const retired = [...registeredJobs.values()];
    registeredJobs.clear();
    destroyTask(scanTimer, owner);
    for (const job of retired) destroyTask(job.task, owner);
    // The scan's abort is an expected retirement, while a failed timer cleanup
    // must be observable by the runtime. Its global deadline bounds stalled work.
    stopping = Promise.allSettled([
      ...owner.cycles, ...owner.cleanups,
      ...(retiringScan ? [retiringScan.catch(() => undefined)] : []),
    ]).then(results => {
      if (owner.cleanupFailed || results.some(result => result.status === "rejected")) {
        throw new Error("Arrêt du planificateur personnalisé non confirmé");
      }
    });
    // Fire-and-forget callers remain safe; callers awaiting stop still receive
    // its failure. Each controller drains only its own runtime generation.
    void stopping.catch(() => undefined);
    return stopping;
  };
  const controller: SchedulerController = { stop, destroy: stop };
  activeScheduler = controller;
  void refreshSafely();
  return controller;
}
