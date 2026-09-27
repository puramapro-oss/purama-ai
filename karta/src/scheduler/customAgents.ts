import cron, { type ScheduledTask } from "node-cron";
import { listKartaEnabledCustomAgents } from "../agents/customAgent.js";
import { enqueueAgentCycle } from "../queue/queues.js";

interface RegisteredJob {
  task: ScheduledTask;
  cronExpr: string;
}

const registeredJobs = new Map<string, RegisteredJob>();

export async function refreshCustomAgentSchedules(): Promise<void> {
  const agents = await listKartaEnabledCustomAgents();
  const stillValid = new Map(agents.map((a) => [a.id, a]));

  for (const [id, job] of registeredJobs) {
    const agent = stillValid.get(id);
    const shouldRun = agent && agent.schedule_enabled && agent.schedule_cron === job.cronExpr;
    if (!shouldRun) {
      job.task.stop();
      registeredJobs.delete(id);
    }
  }

  for (const agent of agents) {
    if (!agent.schedule_enabled || !agent.schedule_cron || registeredJobs.has(agent.id)) continue;

    if (!cron.validate(agent.schedule_cron)) {
      console.error(`[custom-agents] cron invalide pour l'agent ${agent.id} ("${agent.name}") : "${agent.schedule_cron}"`);
      continue;
    }

    const cronExpr = agent.schedule_cron;
    const task = cron.schedule(cronExpr, () => {
      const bucket = new Date().toISOString().slice(0, 16);
      void enqueueAgentCycle(
        {
          agentType: `custom:${agent.id}`,
          userId: agent.user_id,
          trigger: { type: "cron", source: `custom-agent:${agent.name}` },
        },
        { idempotencyKey: `cron:custom:${agent.id}:${bucket}` }
      ).catch((err) => console.error(`[custom-agents] enqueue ${agent.id} a échoué:`, err));
    });
    registeredJobs.set(agent.id, { task, cronExpr });
  }
}

export function startCustomAgentScheduler(): ScheduledTask {
  void refreshCustomAgentSchedules().catch((err) =>
    console.error("[custom-agents] scan initial échoué:", err)
  );
  return cron.schedule("*/5 * * * *", () => void refreshCustomAgentSchedules());
}
