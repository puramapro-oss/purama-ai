import cron, { type ScheduledTask, type TaskContext } from "node-cron";
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

/** Runtime shutdown owns these schedules; restarting a retired timer is not supported. */
type SchedulerController = Pick<ScheduledTask, "stop" | "destroy">;

function startGuardedSchedule(
  cronExpr: string,
  label: string,
  run: (context: TaskContext, isActive: () => boolean) => Promise<void>,
): SchedulerController {
  let stopped = false;
  const isActive = () => !stopped;
  const task = cron.schedule(cronExpr, async (context) => {
    // A callback may already have been dispatched when shutdown retires its timer.
    if (!isActive()) return;
    try {
      // Let node-cron observe actual completion instead of detaching this promise.
      await run(context, isActive);
    } catch {
      if (isActive()) console.error(`[scheduler] ${label} : exécution non confirmée`);
    }
  });

  const stop = () => {
    if (stopped) return;
    // Invalidate pending reads and between-user continuations before cleanup.
    stopped = true;
    try {
      void Promise.resolve(task.destroy()).catch(() => {
        console.error(`[scheduler] ${label} : destruction du timer non confirmée`);
      });
    } catch {
      console.error(`[scheduler] ${label} : destruction du timer non confirmée`);
    }
  };
  return { stop, destroy: stop };
}

export function startSchedulers(): SchedulerController[] {
  const tasks = SCHEDULES.map(({ agentType, cronExpr, label }) =>
    startGuardedSchedule(cronExpr, label, (context, isActive) =>
      runScheduledCycle(agentType, label, context, isActive))
  );

  tasks.push(
    startGuardedSchedule(config.dailyReportCron, "Rapport quotidien", () => runDailyReport())
  );

  return tasks;
}

async function runScheduledCycle(
  agentType: AgentType,
  label: string,
  context: TaskContext,
  isActive: () => boolean,
): Promise<void> {
  // Freeze the scheduled minute before any async work: two instances firing the
  // same tick must retain one delivery identity despite different lookup delays.
  const slot = context.date.toISOString().slice(0, 16);
  const userIds = await listActiveUserIds(agentType);
  for (const userId of userIds) {
    if (!isActive()) return;
    // An already-started queue submission cannot be retracted; never begin the
    // next user's submission after stop(), even when the previous one settles late.
    await enqueueAgentCycle(
      { agentType, userId, trigger: { type: "cron", source: label, payload: { slot } } },
      { dedupeKey: `cron|${agentType}|${userId}|${slot}` }
    );
  }
}
