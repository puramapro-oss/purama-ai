import cron, { type TaskContext } from "node-cron";
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
type SchedulerController = { stop(): Promise<void>; destroy(): Promise<void> };

function startGuardedSchedule(
  cronExpr: string,
  label: string,
  run: (context: TaskContext, isActive: () => boolean) => Promise<void>,
): SchedulerController {
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();
  const isActive = () => !stopped;
  const task = cron.schedule(cronExpr, (context) => {
    // A callback may already have been dispatched when shutdown retires its timer.
    if (!isActive()) return;
    // Register every dispatched callback before it can start asynchronous work.
    const work = Promise.resolve().then(async () => {
      if (!isActive()) return;
      try {
        await run(context, isActive);
      } catch {
        if (isActive()) console.error(`[scheduler] ${label} : exécution non confirmée`);
      }
    });
    inFlight.add(work);
    void work.then(() => { inFlight.delete(work); }, () => { inFlight.delete(work); });
    // Let node-cron observe actual completion instead of detaching this promise.
    return work;
  });

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    // Invalidate pending reads and between-user continuations before cleanup.
    stopped = true;
    const timerStopped = Promise.resolve().then(() => task.stop());
    // Retire the registry entry even when stop fails. Keep the native methods:
    // node-cron's destroy calls stop internally and must not await this drain.
    const timerDestroyed = timerStopped.catch(() => undefined).then(() => task.destroy());
    stopping = Promise.allSettled([timerStopped, timerDestroyed, ...inFlight]).then(results => {
      if (results.some(result => result.status === "rejected")) {
        console.error(`[scheduler] ${label} : arrêt du planificateur non confirmé`);
        throw new Error("Arrêt du planificateur non confirmé");
      }
    });
    // Awaiting callers still receive the rejection; legacy fire-and-forget
    // shutdown calls must not create an unhandled rejection during cleanup.
    void stopping.catch(() => undefined);
    return stopping;
  };
  return { stop, destroy: stop };
}

export function startSchedulers(): SchedulerController[] {
  const tasks: SchedulerController[] = [];
  try {
    // Validate the daily expression too, before creating the first timer.
    if (![...SCHEDULES.map(schedule => schedule.cronExpr), config.dailyReportCron]
      .every(expression => cron.validate(expression))) throw new Error();
    for (const { agentType, cronExpr, label } of SCHEDULES) {
      tasks.push(startGuardedSchedule(cronExpr, label, (context, isActive) =>
        runScheduledCycle(agentType, label, context, isActive)));
    }
    tasks.push(startGuardedSchedule(config.dailyReportCron, "Rapport quotidien", () => runDailyReport()));
    return tasks;
  } catch {
    // The runtime never receives a partially constructed list. Invalidate all
    // created controllers synchronously; their stop promises own the cleanup.
    for (const task of tasks) void task.stop();
    throw new Error("Planifications KARTA invalides ou indisponibles");
  }
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
