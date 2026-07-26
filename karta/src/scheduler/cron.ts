import cron from "node-cron";
import { config } from "../config.js";
import { listActiveUserIds } from "../agents/index.js";
import { enqueueAgentCycle } from "../queue/queues.js";
import { runDailyReport } from "./dailyReport.js";
import type { AgentType } from "../engine/types.js";

/** Cadences alignées sur les workflows n8n existants qu'elles remplacent (cf AUDIT-AGENTS.md). */
const SCHEDULES: Array<{ agentType: AgentType; cronExpr: string; label: string }> = [
  { agentType: "email", cronExpr: "*/2 * * * *", label: "Email Agent — Fetch & Process" },
  { agentType: "compta", cronExpr: "0 6 * * *", label: "Compta Agent — Sync & Categorize" },
  { agentType: "legal", cronExpr: "0 5 * * *", label: "Legal Agent — Veille Juridique" },
  { agentType: "partner", cronExpr: "*/30 * * * *", label: "Partner Agent — Outreach Scheduler" },
];

export function startSchedulers(): cron.ScheduledTask[] {
  const tasks = SCHEDULES.map(({ agentType, cronExpr, label }) =>
    cron.schedule(cronExpr, () => void runScheduledCycle(agentType, label))
  );

  tasks.push(
    cron.schedule(config.dailyReportCron, () => {
      void runDailyReport().catch((err) => console.error("[scheduler] daily report échoué:", err));
    })
  );

  return tasks;
}

async function runScheduledCycle(agentType: AgentType, label: string): Promise<void> {
  try {
    const userIds = await listActiveUserIds(agentType);
    for (const userId of userIds) {
      await enqueueAgentCycle({ agentType, userId, trigger: { type: "cron", source: label } });
    }
  } catch (error) {
    console.error(`[scheduler] ${label} échoué:`, error instanceof Error ? error.message : error);
  }
}
