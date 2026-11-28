import type { Routine, RoutineChannel } from "./contracts.js";
import { calculateNextOccurrences, routineMayDeliverAt } from "./schedule.js";
import { buildRoutineReport } from "./report.js";
import { createPhoneProvider, PhoneProviderError, type PhoneProvider } from "./phone.js";
import { routineRuntimeConfig, type RoutineRuntimeConfig } from "./runtime.js";
import { deliverRoutineChannel, prepareRoutineDelivery, RoutineTransportNotDeliveredError } from "./transports.js";
import { record, routineId, routineStore, RoutineError, type RoutineDelivery, type RoutineOccurrence, type RoutineStore } from "./store.js";

export interface RoutineProcessorDependencies {
  store: RoutineStore;
  runtime: RoutineRuntimeConfig;
  phone: PhoneProvider;
  globalAllowed(): Promise<boolean>;
  now(): number;
  prepare: typeof prepareRoutineDelivery;
  deliver: typeof deliverRoutineChannel;
}

export function createRoutineProcessor(dependencies: Partial<RoutineProcessorDependencies> = {}) {
  const runtime = dependencies.runtime ?? routineRuntimeConfig();
  const store = dependencies.store ?? routineStore;
  const phone = dependencies.phone ?? createPhoneProvider(runtime.phone);
  const globalAllowed = dependencies.globalAllowed ?? (() => store.globalAllowed());
  const now = dependencies.now ?? Date.now;
  const prepare = dependencies.prepare ?? prepareRoutineDelivery;
  const deliver = dependencies.deliver ?? deliverRoutineChannel;
  const active = async (isActive: () => boolean) => isActive() && runtime.enabled && await globalAllowed() && isActive();

  async function report(routine: Routine, until: number, start?: number) {
    const period = routine.config.schedule.kind === "weekly" ? 7 * 86_400_000 : 86_400_000;
    const last = routine.lastOccurrenceAt ? Date.parse(routine.lastOccurrenceAt) : NaN;
    const beginning = start ?? (Number.isFinite(last) && last < until ? Math.max(last, until - 7 * 86_400_000) : until - period);
    const since = new Date(beginning).toISOString();
    const end = new Date(until).toISOString();
    const source = await store.sourceRuns(routine, since, end);
    return { summary: buildRoutineReport(routine, source.runs, { since, until: end, truncated: source.truncated,
      startExclusive: start === undefined && Number.isFinite(last) && last < until, endExclusive: start !== undefined }), runs: source.runs };
  }

  async function reconcileCall(occurrence: RoutineOccurrence, delivery: RoutineDelivery): Promise<void> {
    if (delivery.channel !== "call" || !["accepted", "unknown"].includes(delivery.status)
      || now() - Date.parse(delivery.updatedAt) < 60_000) return;
    try {
      const receipt = await phone.lookupPhoneCall(delivery.providerId ?? occurrence.id);
      if (receipt.externalId !== occurrence.id || (delivery.providerId && delivery.providerId !== receipt.callId) || receipt.status === "unknown") return;
      await store.finish(occurrence, "call", receipt.status, receipt.callId, {
        answeredBy: receipt.answeredBy ?? "unknown", heardConfirmed: false, reconciled: true,
      });
    } catch { /* A lookup failure never authorizes another outbound call. */ }
    finally { await store.noteCallLookup(occurrence).catch(() => undefined); }
  }

  async function processOccurrence(input: RoutineOccurrence, isActive: () => boolean = () => true): Promise<void> {
    if (!isActive()) return;
    let occurrence = await store.refresh(input);
    let deliveries = await store.deliveries(occurrence);
    for (const delivery of deliveries) {
      if (!isActive()) return;
      await reconcileCall(occurrence, delivery);
    }
    // Derive the state inside one DB lock. A resolved unknown call can release a
    // written fallback; cancellation and a completed fallback stay terminal.
    occurrence = await store.refresh(occurrence);
    if (["completed", "failed", "skipped", "cancelled"].includes(occurrence.status) || !await active(isActive)) return;
    const routine = await store.get(occurrence.userId, occurrence.routineId);
    deliveries = await store.deliveries(occurrence);

    const send = async (channel: RoutineChannel) => {
      const prior = deliveries.find(item => item.channel === channel);
      if (!prior || prior.status !== "pending" || !await active(isActive)) return;
      let contact;
      try { contact = await prepare(channel, occurrence, runtime, store); }
      catch {
        if (!await active(isActive)) return;
        const admission = await store.begin(occurrence, channel);
        if (admission.started) await store.finish(occurrence, channel, "failed", null, { reason: "channel_unavailable", effect: "none" });
        return;
      }
      if (!await active(isActive)) return;
      const admission = await store.begin(occurrence, channel);
      if (!admission.started) return;
      try {
        const latest = await store.get(occurrence.userId, occurrence.routineId);
        if (!await active(isActive) || latest.revision !== occurrence.revision || !routineMayDeliverAt(latest.config, now())) {
          await store.finish(occurrence, channel, "skipped", null, { reason: "consent_changed_before_dispatch", effect: "none" });
          return;
        }
        const receipt = await deliver(channel, occurrence, latest, contact, runtime, store, phone);
        await store.finish(occurrence, channel, receipt.status, receipt.providerId, receipt.details ?? {});
      } catch (error) {
        // A preflight rejection proves no effect. A lost provider/DB reply does
        // not, so an uncertain dispatch is never reset to pending or retried.
        const notSent = error instanceof PhoneProviderError && error.outcome === "not_sent";
        const notDelivered = error instanceof RoutineTransportNotDeliveredError;
        await store.finish(occurrence, channel, notSent || notDelivered ? "failed" : "unknown", null,
          { reason: notSent ? "provider_rejected_before_dispatch" : notDelivered ? "channel_not_delivered" : "delivery_unconfirmed" }).catch(() => undefined);
      }
    };
    if (routine.config.deliveryMode === "parallel") {
      const results = await Promise.allSettled(routine.config.channels.map(send));
      if (results.some(result => result.status === "rejected")) console.error("[routines] Une livraison reste à rapprocher.");
    } else {
      for (const channel of routine.config.channels) {
        if (!isActive()) break;
        deliveries = await store.deliveries(occurrence);
        const current = deliveries.find(item => item.channel === channel);
        if (current?.status === "pending") await send(channel);
        occurrence = await store.refresh(occurrence);
        if (occurrence.status === "completed" || occurrence.status === "cancelled") return;
        const after = (await store.deliveries(occurrence)).find(item => item.channel === channel);
        if (!after || ["sending", "pending", "unknown"].includes(after.status)
          || (channel === "call" && after.status === "accepted")) break;
      }
    }
    await store.refresh(occurrence);
  }

  async function requestNow(routine: Routine, requestId: string, isActive: () => boolean = () => true): Promise<RoutineOccurrence> {
    const slot = `manual:${routineId(requestId)}`;
    // Re-read the durable receipt before rebuilding a report or checking current
    // activation. A retry of the same intent cannot silently acquire new work.
    const existing = await store.occurrenceForSlot(routine.userId, routine.id, slot);
    if (existing) {
      if (existing.revision !== routine.revision) throw new RoutineError("ROUTINE_CONFLICT", 409, "La routine a changé depuis cette demande.");
      return existing;
    }
    if (!await active(isActive)) throw new RoutineError("ROUTINE_DISABLED", 503, "Les routines IAO sont actuellement indisponibles.");
    const instant = now();
    if (!routineMayDeliverAt(routine.config, instant)) throw new RoutineError("ROUTINE_PAUSED", 409, "Cette routine est en pause ou dans ses heures calmes.");
    const { summary } = await report(routine, instant);
    if (!await active(isActive)) throw new RoutineError("ROUTINE_DISABLED", 503, "Les routines IAO sont actuellement indisponibles.");
    return store.claim(routine, slot, new Date(instant).toISOString(), new Date(instant + 30 * 60_000).toISOString(), summary);
  }

  async function tick(scheduledDate: Date, isActive: () => boolean = () => true): Promise<void> {
    if (!isActive() || !runtime.enabled) return;
    const scheduled = scheduledDate.getTime();
    const fresh = () => Number.isFinite(scheduled) && Math.abs(now() - scheduled) <= 120_000;
    if (!fresh()) return;
    for (const occurrence of await store.pending()) {
      if (!isActive()) return;
      await processOccurrence(occurrence, isActive).catch(() => console.error("[routines] Rapprochement non confirmé."));
    }
    let after: string | undefined;
    for (;;) {
      if (!fresh() || !await active(isActive)) return;
      const page = await store.activePage(after);
      for (const routine of page) {
        if (!fresh() || !await active(isActive)) return;
        try {
          const { schedule } = routine.config;
          if (schedule.kind === "event") {
            // Complete, non-overlapping UTC minute windows: several 10-second
            // scheduler ticks cannot notify the same event under two slots.
            const end = Math.floor(scheduled / 60_000) * 60_000;
            const start = end - 60_000;
            const { summary, runs } = await report(routine, end, start);
            const relevant = runs.some(value => {
              if (!record(value) || typeof value.finished_at !== "string") return false;
              const finished = Date.parse(value.finished_at);
              if (finished < start || finished >= end) return false;
              return schedule.event === "completed" ? value.status === "success" && value.mode === "live" && value.claude_mock === false
                : schedule.event === "decision" ? value.status === "awaiting_approval" : ["error", "partial", "blocked"].includes(String(value.status));
            });
            if (!relevant || !routineMayDeliverAt(routine.config, now())) continue;
            if (!fresh() || !await active(isActive)) return;
            const at = new Date(end).toISOString();
            const occurrence = await store.claim(routine, `event:${schedule.event}:${at}`, at,
              new Date(end + 15 * 60_000).toISOString(), summary);
            await processOccurrence(occurrence, isActive);
            continue;
          }
          const due = calculateNextOccurrences(routine.config, scheduled - 60_001, 1)[0];
          if (!due || Date.parse(due) > scheduled || Date.parse(due) <= scheduled - 60_001) continue;
          const { summary } = await report(routine, Date.parse(due));
          if (!fresh() || !await active(isActive)) return;
          const occurrence = await store.claim(routine, `scheduled:${due}`, due,
            new Date(Date.parse(due) + 30 * 60_000).toISOString(), summary);
          if (routine.config.onlyIfNew && occurrence.report.hasNewActivity === false) await store.refresh(occurrence, true);
          else await processOccurrence(occurrence, isActive);
        } catch (error) {
          if (!(error instanceof RoutineError && error.status === 409)) console.error("[routines] Préparation d’un bilan non confirmée.");
        }
      }
      if (page.length < 100) break;
      after = page[page.length - 1].id;
    }
  }
  return { requestNow, processOccurrence, tick, reconcileCall };
}

let currentTick: Promise<void> | undefined;
/** Reuses the existing KARTA scheduler lifecycle; overlapping scans coalesce. */
export function runRoutineTick(date: Date, isActive: () => boolean): Promise<void> {
  if (currentTick) return currentTick;
  const work = createRoutineProcessor().tick(date, isActive);
  currentTick = work;
  void work.finally(() => { if (currentTick === work) currentTick = undefined; }).catch(() => undefined);
  return work;
}
