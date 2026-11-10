import cron, { type ScheduledTask } from "node-cron";
import { listKartaEnabledCustomAgents } from "../agents/customAgent.js";
import { enqueueAgentCycle } from "../queue/queues.js";

interface RegisteredJob {
  task: ScheduledTask;
  cronExpr: string;
}

const registeredJobs = new Map<string, RegisteredJob>();
let generation = 0;
let stopped = false;
let refreshInFlight: Promise<void> | null = null;
let refreshAbort: AbortController | null = null;
const SCAN_TIMEOUT_MS = 30_000;

/** The runtime only needs to stop this group, not operate its private scan timer. */
type SchedulerController = Pick<ScheduledTask, "stop" | "destroy">;
let activeScheduler: SchedulerController | null = null;

function destroyTask(task: ScheduledTask): void {
  // Inline node-cron timers destroy synchronously, but its public contract also
  // permits asynchronous implementations. Never detach a rejected cleanup promise.
  try {
    void Promise.resolve(task.destroy()).catch(() => {
      console.error("[custom-agents] destruction du timer non confirmée");
    });
  } catch {
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
  const agents = await listKartaEnabledCustomAgents(signal);
  if (signal.aborted || stopped || scanGeneration !== generation) return;
  const stillValid = new Map(agents.map((a) => [a.id, a]));

  for (const [id, job] of registeredJobs) {
    const agent = stillValid.get(id);
    const shouldRun = agent && agent.schedule_enabled && agent.schedule_cron === job.cronExpr;
    if (!shouldRun) {
      registeredJobs.delete(id);
      destroyTask(job.task);
    }
  }

  for (const agent of agents) {
    if (!agent.schedule_enabled || !agent.schedule_cron || registeredJobs.has(agent.id)) continue;

    if (!cron.validate(agent.schedule_cron)) {
      console.error("[custom-agents] cron invalide : planification ignorée");
      continue;
    }

    const cronExpr = agent.schedule_cron;
    const task = cron.schedule(cronExpr, async () => {
      // stop/destroy cannot retract an already-dispatched timer callback. Also
      // reject callbacks from removed schedules and previous runtime generations.
      if (stopped || scanGeneration !== generation || registeredJobs.get(agent.id)?.task !== task) return;
      const slot = new Date().toISOString().slice(0, 16);
      try {
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
    registeredJobs.set(agent.id, { task, cronExpr });
  }
}

/** Démarre le scheduler des agents créés : 1er scan immédiat + réévaluation toutes les 5 min. */
export function startCustomAgentScheduler(): SchedulerController {
  if (activeScheduler) return activeScheduler;
  stopped = false;
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
  const stop = () => {
    if (activeScheduler !== controller) return;
    // Invalidate callbacks and outstanding reads before touching timer resources.
    stopped = true;
    generation++;
    activeScheduler = null;
    refreshAbort?.abort();
    refreshAbort = null;
    refreshInFlight = null;
    const retired = [...registeredJobs.values()];
    registeredJobs.clear();
    destroyTask(scanTimer);
    for (const job of retired) destroyTask(job.task);
  };
  const controller: SchedulerController = { stop, destroy: stop };
  activeScheduler = controller;
  void refreshSafely();
  return controller;
}
