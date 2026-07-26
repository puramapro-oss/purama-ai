import cron from "node-cron";
import { config } from "../config.js";
import { listActiveUserIds } from "../agents/index.js";
import { enqueueAgentCycle } from "../queue/queues.js";
import { runDailyReport } from "./dailyReport.js";
import type { AgentType } from "../engine/types.js";

/** Cadences alignées sur les workflows n8n existants qu'elles remplacent (cf AUDIT-AGENTS.md). */
const CORE_SCHEDULES: Array<{ agentType: AgentType; cronExpr: string; label: string }> = [
  { agentType: "email", cronExpr: "*/2 * * * *", label: "Email Agent — Fetch & Process" },
  { agentType: "compta", cronExpr: "0 6 * * *", label: "Compta Agent — Sync & Categorize" },
  { agentType: "legal", cronExpr: "0 5 * * *", label: "Legal Agent — Veille Juridique" },
  { agentType: "partner", cronExpr: "*/30 * * * *", label: "Partner Agent — Outreach Scheduler" },
];

/** Les 12 agents "action" (Phase 2, multi-tenant) — cadence adaptée à leur nature :
 * réactifs aux données (factures, leads) en continu, pilotés par brief (memory) au quotidien. */
const ACTION_SCHEDULES: Array<{ agentType: AgentType; cronExpr: string; label: string }> = [
  { agentType: "repondeur-intelligent", cronExpr: "*/5 * * * *", label: "Répondeur Intelligent" },
  { agentType: "crm-intelligent", cronExpr: "*/30 * * * *", label: "CRM Intelligent" },
  { agentType: "machine-de-suivi", cronExpr: "*/30 * * * *", label: "Machine de Suivi" },
  { agentType: "facture-pro", cronExpr: "0 7 * * *", label: "Facture Pro" },
  { agentType: "chasseur-de-paiements", cronExpr: "0 8 * * *", label: "Chasseur de Paiements" },
  { agentType: "rapports-financiers", cronExpr: "0 6 * * 1", label: "Rapports Financiers" }, // hebdo, lundi 6h
  { agentType: "campagnes-par-courriel", cronExpr: "0 9 * * *", label: "Campagnes par E-mail" },
  { agentType: "pro-de-la-sensibilisation-au-froid", cronExpr: "0 9 * * *", label: "Cold Outreach" },
  { agentType: "newsletter-genie", cronExpr: "0 8 * * 1", label: "Newsletter Génie" }, // hebdo, lundi 8h
  { agentType: "maitre-des-publicites", cronExpr: "0 8 * * 1", label: "Maître des Publicités" }, // hebdo
  { agentType: "planificateur-d-appels", cronExpr: "*/15 * * * *", label: "Planificateur d'Appels" },
  { agentType: "reservation-intelligente", cronExpr: "*/15 * * * *", label: "Réservation Intelligente" },
];

const SCHEDULES = [...CORE_SCHEDULES, ...ACTION_SCHEDULES];

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
