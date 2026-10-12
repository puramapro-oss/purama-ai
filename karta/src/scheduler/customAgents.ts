import cron from "node-cron";
import { listKartaEnabledCustomAgents } from "../agents/customAgent.js";
import { enqueueAgentCycle } from "../queue/queues.js";
import { createSchedulerLifecycle } from "./cron.js";

interface RegisteredJob {
  task: cron.ScheduledTask;
  cronExpr: string;
}

interface CustomScheduleState {
  lifecycle: ReturnType<typeof createSchedulerLifecycle>;
  jobs: Map<string, RegisteredJob>;
}

/** Refresh is scoped to one owner; shutdown invalidates even an awaited scan. */
export async function refreshCustomAgentSchedules({ lifecycle, jobs }: CustomScheduleState): Promise<void> {
  if (!lifecycle.active) return;
  const agents = await listKartaEnabledCustomAgents();
  if (!lifecycle.active) return;
  const stillValid = new Map(agents.map((a) => [a.id, a]));

  for (const [id, job] of jobs) {
    const agent = stillValid.get(id);
    if (!agent || !agent.schedule_enabled || agent.schedule_cron !== job.cronExpr) {
      lifecycle.forget(job.task);
      jobs.delete(id);
    }
  }
  for (const agent of agents) {
    if (!agent.schedule_enabled || !agent.schedule_cron || jobs.has(agent.id)) continue;
    if (!cron.validate(agent.schedule_cron)) {
      console.error(`[custom-agents] cron invalide pour l'agent ${agent.id} ("${agent.name}") : "${agent.schedule_cron}"`);
      continue;
    }
    const cronExpr = agent.schedule_cron;
    const task = lifecycle.own(cron.schedule(cronExpr, () => {
      void lifecycle.run(() => enqueueAgentCycle({
        agentType: `custom:${agent.id}`,
        userId: agent.user_id,
        trigger: { type: "cron", source: `custom-agent:${agent.name}` },
      })).catch((error: unknown) => console.error(`[custom-agents] enqueue ${agent.id} a échoué:`, error));
    }));
    jobs.set(agent.id, { task, cronExpr });
  }
}

/** Coalesce overlapping refreshes so an old snapshot cannot overwrite a newer one. */
export function startCustomAgentScheduler() {
  const lifecycle = createSchedulerLifecycle();
  const jobs = new Map<string, RegisteredJob>();
  let scan: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (!lifecycle.active) return Promise.resolve();
    if (scan) return scan;
    scan = lifecycle.run(() => refreshCustomAgentSchedules({ lifecycle, jobs }));
    void scan.then(() => { scan = undefined; }, () => { scan = undefined; });
    return scan;
  };
  try {
    lifecycle.own(cron.schedule("*/5 * * * *", () => {
      void refresh().catch((error: unknown) => console.error("[custom-agents] scan échoué:", error));
    }));
    const ready = refresh();
    // The runtime also observes this rejection and rolls back partial registration.
    void ready.catch((error: unknown) => console.error("[custom-agents] scan initial échoué:", error));
    return {
      ready,
      refresh,
      stop(): void {
        try { lifecycle.stop(); } finally { jobs.clear(); }
      },
      drain: () => lifecycle.drain(),
    };
  } catch (error) {
    lifecycle.stop();
    throw error;
  }
}
