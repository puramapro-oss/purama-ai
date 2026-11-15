import cron from "node-cron";
import { config } from "../config.js";
import { listActiveUserIds } from "../agents/index.js";
import { enqueueAgentCycle } from "../queue/queues.js";
import { runDailyReport } from "./dailyReport.js";
import type { AgentType } from "../engine/types.js";
import type { RuntimeProducer } from "../runtime.js";

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

/** node-cron v3 keeps stopped tasks in a global registry; release ownership too. */
export function stopCronTask(task: cron.ScheduledTask): void {
  task.stop();
  for (const [id, registered] of cron.getTasks()) {
    if (registered === task) cron.getTasks().delete(id);
  }
}

export function createSchedulerLifecycle() {
  let active = true;
  const tasks = new Set<cron.ScheduledTask>();
  const pending = new Set<Promise<void>>();
  const lifecycle = {
    get active() { return active; },
    own(task: cron.ScheduledTask): cron.ScheduledTask {
      tasks.add(task);
      return task;
    },
    forget(task: cron.ScheduledTask): void {
      stopCronTask(task);
      tasks.delete(task);
    },
    run(callback: () => Promise<void>): Promise<void> {
      if (!active) return Promise.resolve();
      const operation = Promise.resolve().then(() => active ? callback() : undefined);
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    },
    stop(): void {
      if (!active) return;
      active = false;
      const errors: unknown[] = [];
      for (const task of tasks) {
        try { stopCronTask(task); } catch (error) { errors.push(error); }
      }
      tasks.clear();
      if (errors.length) throw new AggregateError(errors, "KARTA cron stop failed");
    },
    async drain(): Promise<void> {
      // Producers are already stopped; no callback may join after this snapshot.
      await Promise.allSettled([...pending]);
    },
  };
  return lifecycle;
}

export function startSchedulers(): RuntimeProducer {
  const lifecycle = createSchedulerLifecycle();
  try {
    for (const { agentType, cronExpr, label } of SCHEDULES) {
      lifecycle.own(cron.schedule(cronExpr, () => {
        void lifecycle.run(() => runScheduledCycle(agentType, label, () => lifecycle.active));
      }));
    }
    lifecycle.own(cron.schedule(config.dailyReportCron, () => {
      void lifecycle.run(runDailyReport).catch((error: unknown) =>
        console.error("[scheduler] daily report échoué:", error));
    }));
    return lifecycle;
  } catch (error) {
    lifecycle.stop(); // Includes every task registered before a bad cron expression.
    throw error;
  }
}

async function runScheduledCycle(agentType: AgentType, label: string, active: () => boolean): Promise<void> {
  try {
    const userIds = await listActiveUserIds(agentType);
    for (const userId of userIds) {
      if (!active()) return;
      await enqueueAgentCycle({ agentType, userId, trigger: { type: "cron", source: label } });
    }
  } catch (error) {
    console.error(`[scheduler] ${label} échoué:`, error instanceof Error ? error.message : error);
  }
}
