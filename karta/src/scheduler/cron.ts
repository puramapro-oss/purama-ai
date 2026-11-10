import cron, { type ScheduledTask } from "node-cron";
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

/** Keep timer stop compatible with node-cron while draining its dispatched work. */
function scheduleDrainable(cronExpr: string, run: (isStopped: () => boolean) => Promise<void>): ScheduledTask {
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();
  const task = cron.schedule(cronExpr, () => {
    if (stopped) return;
    const work = Promise.resolve().then(() => stopped ? undefined : run(() => stopped));
    inFlight.add(work);
    // Attach both handlers without creating a detached rejected finally chain.
    void work.then(() => { inFlight.delete(work); }, () => { inFlight.delete(work); });
    return work;
  });
  const stopTimer = task.stop.bind(task);
  task.stop = () => {
    if (stopping) return stopping;
    // stop() cannot retract a callback already dispatched by the timer. Invalidate
    // it synchronously, and let pending scans observe the same flag before enqueue.
    stopped = true;
    stopping = Promise.allSettled([
      Promise.resolve().then(stopTimer),
      ...inFlight,
    ]).then(results => {
      if (results.some(result => result.status === "rejected")) {
        throw new Error("Arrêt du planificateur non confirmé");
      }
    });
    return stopping;
  };
  return task;
}

export function startSchedulers(): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];
  try {
    // Validate the last expression too, before the first timer can be created.
    if (![...SCHEDULES.map(schedule => schedule.cronExpr), config.dailyReportCron]
      .every(expression => cron.validate(expression))) throw new Error();
    for (const { agentType, cronExpr, label } of SCHEDULES) {
      tasks.push(scheduleDrainable(cronExpr, isStopped => runScheduledCycle(agentType, label, isStopped)));
    }
    tasks.push(scheduleDrainable(config.dailyReportCron, () =>
      runDailyReport().catch((err) => console.error("[scheduler] daily report échoué:", err))));
    return tasks;
  } catch {
    // A construction failure means the runtime never receives this list. Retire
    // every created task here; stop invalidates callbacks synchronously, before
    // even a callback queued during construction can publish work.
    for (const task of tasks) {
      try {
        void Promise.resolve(task.stop()).then(() => task.destroy()).catch(() => {
          console.error("[scheduler] nettoyage du planificateur non confirmé");
        });
      } catch {
        console.error("[scheduler] nettoyage du planificateur non confirmé");
      }
    }
    throw new Error("Planifications KARTA invalides ou indisponibles");
  }
}

async function runScheduledCycle(agentType: AgentType, label: string, isStopped: () => boolean): Promise<void> {
  try {
    if (isStopped()) return;
    const userIds = await listActiveUserIds(agentType);
    // Multiple KARTA instances may fire the same cron. The minute slot makes those
    // deliveries share one durable BullMQ job id instead of executing twice.
    const slot = new Date().toISOString().slice(0, 16);
    for (const userId of userIds) {
      if (isStopped()) return;
      await enqueueAgentCycle(
        { agentType, userId, trigger: { type: "cron", source: label, payload: { slot } } },
        { dedupeKey: `cron|${agentType}|${userId}|${slot}` }
      );
    }
  } catch (error) {
    console.error(`[scheduler] ${label} échoué:`, error instanceof Error ? error.message : error);
  }
}
