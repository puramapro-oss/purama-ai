import { supabase } from "../db/supabase.js";
import { createProviderDeadline } from "../tools/provider-http.js";
import { normalizeRoutineInput, normalizeRoutineTimestamp, type Routine, type RoutineChannel, type RoutineInput } from "./contracts.js";
import type { RoutineReport } from "./report.js";

export const ROUTINE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type DeliveryStatus = "pending" | "sending" | "accepted" | "completed" | "failed" | "unknown" | "skipped";
export interface RoutineDelivery {
  channel: RoutineChannel; status: DeliveryStatus; providerId: string | null;
  updatedAt: string; details: Record<string, unknown>;
}
export interface RoutineOccurrence {
  id: string; userId: string; routineId: string; revision: number; slot: string;
  scheduledAt: string; expiresAt: string; status: string; report: RoutineReport;
}

export class RoutineError extends Error {
  constructor(readonly code: string, readonly status = 503, message = "Le service de routines est temporairement indisponible. Actualisez son état avant de réessayer.") {
    super(message); this.name = "RoutineError";
  }
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function routineId(value: unknown): string {
  if (typeof value !== "string" || !ROUTINE_UUID.test(value)) throw new RoutineError("ROUTINE_INVALID", 400, "Identifiant de routine invalide.");
  return value.toLowerCase();
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(row => !record(row))) throw new RoutineError("ROUTINE_UNAVAILABLE");
  return value as Record<string, unknown>[];
}
function timestamp(value: unknown): string {
  if (typeof value !== "string") throw new RoutineError("ROUTINE_UNAVAILABLE");
  // Postgres can return microseconds; preserve the instant at JS precision.
  return normalizeRoutineTimestamp(value.replace(/(\.\d{3})\d+(?=Z|[+-])/, "$1"));
}
export function decodeRoutine(value: unknown, owner?: string): Routine {
  if (!record(value) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new RoutineError("ROUTINE_UNAVAILABLE");
  }
  const userId = routineId(value.user_id);
  if (owner && userId !== owner) throw new RoutineError("ROUTINE_UNAVAILABLE");
  return { id: routineId(value.id), userId, revision: value.revision,
    config: normalizeRoutineInput(value.config), createdAt: timestamp(value.created_at), updatedAt: timestamp(value.updated_at),
    lastOccurrenceAt: value.last_occurrence_at == null ? null : timestamp(value.last_occurrence_at) };
}
export function decodeOccurrence(value: unknown, owner?: string): RoutineOccurrence {
  if (!record(value) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision)
    || value.revision < 1 || typeof value.slot !== "string" || value.slot.length > 200
    || !["pending", "processing", "completed", "partial", "failed", "cancelled", "unknown", "skipped"].includes(String(value.status)) || !record(value.report)
    || typeof value.report.title !== "string" || value.report.title.length > 300
    || typeof value.report.body !== "string" || value.report.body.length > 5000) throw new RoutineError("ROUTINE_UNAVAILABLE");
  const userId = routineId(value.user_id);
  if (owner && userId !== owner) throw new RoutineError("ROUTINE_UNAVAILABLE");
  return { id: routineId(value.id), userId, routineId: routineId(value.routine_id), revision: value.revision,
    slot: value.slot, status: String(value.status), scheduledAt: timestamp(value.scheduled_at), expiresAt: timestamp(value.expires_at),
    report: value.report as unknown as RoutineReport };
}
function decodeDelivery(value: unknown): RoutineDelivery {
  if (!record(value) || !["call", "in_app", "push", "email"].includes(String(value.channel))
    || !["pending", "sending", "accepted", "completed", "failed", "unknown", "skipped"].includes(String(value.status))
    || (value.provider_id !== null && typeof value.provider_id !== "string")) throw new RoutineError("ROUTINE_UNAVAILABLE");
  return { channel: value.channel as RoutineChannel, status: value.status as DeliveryStatus,
    providerId: value.provider_id as string | null, updatedAt: timestamp(value.updated_at), details: record(value.details) ? value.details : {} };
}

/** One bounded DB operation; no mutation is retried with another identity. */
async function database(operation: (signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }>): Promise<unknown> {
  const deadline = createProviderDeadline(7_000, "Résultat de stockage non confirmé");
  try {
    const result = await deadline.wait(() => operation(deadline.signal));
    if (result.error) {
      const code = record(result.error) ? result.error.code : undefined;
      if (typeof code === "string" && /^PIR|^PRT|^P0R/.test(code)) throw new RoutineError("ROUTINE_CONFLICT", 409, "La routine a changé ou ne permet plus cette action. Actualisez son état.");
      throw new RoutineError("ROUTINE_UNAVAILABLE");
    }
    return result.data;
  } catch (error) {
    if (error instanceof RoutineError) throw error;
    throw new RoutineError("ROUTINE_UNAVAILABLE");
  } finally { deadline.close(); }
}
export async function routineRpc(name: string, params: Record<string, unknown>): Promise<unknown> {
  return database(signal => supabase.rpc(name, params).abortSignal(signal));
}
const ROUTINE_FIELDS = "id,user_id,revision,config,created_at,updated_at,last_occurrence_at";
const OCCURRENCE_FIELDS = "id,user_id,routine_id,revision,slot,scheduled_at,expires_at,status,report";

export const routineStore = {
  async globalAllowed(): Promise<boolean> {
    const value = await database(signal => supabase.from("karta_global_state").select("kill_switch")
      .eq("id", "global").abortSignal(signal).single());
    return record(value) && value.kill_switch === false;
  },
  async list(userId: string): Promise<Routine[]> {
    const data = await database(signal => supabase.from("iao_routines").select(ROUTINE_FIELDS).eq("user_id", routineId(userId))
      .order("created_at", { ascending: false }).limit(101).abortSignal(signal));
    if (rows(data).length > 100) throw new RoutineError("ROUTINE_LIMIT", 409, "La liste des routines dépasse la limite disponible.");
    return rows(data).map(row => decodeRoutine(row, userId));
  },
  async get(userId: string, id: string): Promise<Routine> {
    const data = await database(signal => supabase.from("iao_routines").select(ROUTINE_FIELDS)
      .eq("user_id", routineId(userId)).eq("id", routineId(id)).abortSignal(signal).maybeSingle());
    if (data === null) throw new RoutineError("ROUTINE_NOT_FOUND", 404, "Routine introuvable.");
    return decodeRoutine(data, userId);
  },
  async activePage(after?: string): Promise<Routine[]> {
    let query = supabase.from("iao_routines").select(ROUTINE_FIELDS).eq("config->>enabled", "true").order("id").limit(100);
    if (after) query = query.gt("id", routineId(after));
    const data = await database(signal => query.abortSignal(signal));
    return rows(data).map(row => decodeRoutine(row));
  },
  async save(userId: string, id: string, revision: number, config: RoutineInput): Promise<Routine> {
    const result = await routineRpc("iao_save_routine", { p_user_id: routineId(userId), p_routine_id: routineId(id),
      p_expected_revision: revision, p_config: config });
    return decodeRoutine(result, userId);
  },
  async pauseAll(userId: string): Promise<number> {
    const result = await routineRpc("iao_pause_all_routines", { p_user_id: routineId(userId) });
    if (!record(result) || !Number.isSafeInteger(result.updatedCount) || Number(result.updatedCount) < 0) throw new RoutineError("ROUTINE_UNAVAILABLE");
    return Number(result.updatedCount);
  },
  async sourceRuns(routine: Routine, since: string, until: string): Promise<{ runs: unknown[]; truncated: boolean }> {
    let query = supabase.from("karta_runs")
      .select("id,user_id,agent_type,status,mode,claude_mock,started_at,finished_at,result_summary")
      .eq("user_id", routine.userId).lte("started_at", until)
      .or(`started_at.gte.${since},finished_at.gte.${since}`).order("started_at", { ascending: false }).limit(501);
    if (routine.config.agentTypes.length) query = query.in("agent_type", routine.config.agentTypes);
    const data = rows(await database(signal => query.abortSignal(signal)));
    if (data.some(row => row.user_id !== routine.userId)) throw new RoutineError("ROUTINE_UNAVAILABLE");
    return { runs: data.slice(0, 500), truncated: data.length > 500 };
  },
  async occurrence(userId: string, id: string): Promise<RoutineOccurrence> {
    const data = await database(signal => supabase.from("iao_routine_occurrences").select(OCCURRENCE_FIELDS)
      .eq("id", routineId(id)).eq("user_id", routineId(userId)).abortSignal(signal).maybeSingle());
    if (!data) throw new RoutineError("ROUTINE_NOT_FOUND", 404, "Bilan introuvable.");
    return decodeOccurrence(data, userId);
  },
  async occurrenceById(id: string): Promise<RoutineOccurrence | null> {
    const data = await database(signal => supabase.from("iao_routine_occurrences").select(OCCURRENCE_FIELDS)
      .eq("id", routineId(id)).abortSignal(signal).maybeSingle());
    return data ? decodeOccurrence(data) : null;
  },
  async occurrenceForSlot(userId: string, routine: string, slot: string): Promise<RoutineOccurrence | null> {
    const data = await database(signal => supabase.from("iao_routine_occurrences").select(OCCURRENCE_FIELDS)
      .eq("user_id", routineId(userId)).eq("routine_id", routineId(routine)).eq("slot", slot).abortSignal(signal).maybeSingle());
    return data ? decodeOccurrence(data, userId) : null;
  },
  async claim(routine: Routine, slot: string, scheduledAt: string, expiresAt: string, report: RoutineReport): Promise<RoutineOccurrence> {
    const data = await routineRpc("iao_claim_routine_occurrence", { p_user_id: routine.userId, p_routine_id: routine.id,
      p_revision: routine.revision, p_slot: slot, p_scheduled_at: scheduledAt, p_expires_at: expiresAt, p_report: report });
    if (!record(data) || typeof data.claimed !== "boolean") throw new RoutineError("ROUTINE_UNAVAILABLE");
    if (data.occurrence === null) throw new RoutineError("ROUTINE_NOT_ADMITTED", 409,
      "Cette demande ne peut plus être transmise : vérifiez la pause, les heures calmes et l’état de la routine.");
    if (data.claimed === false && data.reason === "occurrence_conflict") throw new RoutineError("ROUTINE_CONFLICT", 409,
      "Cette demande possède déjà une autre version enregistrée. Actualisez son état.");
    return decodeOccurrence(data.occurrence, routine.userId);
  },
  async pending(): Promise<RoutineOccurrence[]> {
    // Keep an admission lane for fresh work even when many old calls remain
    // unresolved. Cancelled occurrences can still contain an external call.
    const [fresh, unresolved] = await Promise.all([
      database(signal => supabase.from("iao_routine_occurrences").select(OCCURRENCE_FIELDS)
        .in("status", ["pending", "processing"]).order("updated_at").limit(50).abortSignal(signal)),
      database(signal => supabase.from("iao_routine_deliveries")
        .select(`occurrence:iao_routine_occurrences!inner(${OCCURRENCE_FIELDS})`)
        .eq("channel", "call").in("status", ["accepted", "unknown"]).order("updated_at").limit(50).abortSignal(signal)),
    ]);
    const occurrences = [...rows(fresh).map(row => decodeOccurrence(row)), ...rows(unresolved).map(row => decodeOccurrence(row.occurrence))];
    return [...new Map(occurrences.map(item => [item.id, item])).values()];
  },
  async noteCallLookup(occurrence: RoutineOccurrence): Promise<void> {
    // Timestamp only: rotate the bounded reconciliation scan without changing
    // a provider receipt or turning an uncertain effect into a retry.
    await database(signal => supabase.from("iao_routine_deliveries").update({ updated_at: new Date().toISOString() })
      .eq("occurrence_id", occurrence.id).eq("user_id", occurrence.userId).eq("channel", "call")
      .in("status", ["accepted", "unknown"]).abortSignal(signal));
  },
  async deliveries(occurrence: RoutineOccurrence): Promise<RoutineDelivery[]> {
    const data = await database(signal => supabase.from("iao_routine_deliveries").select("channel,status,provider_id,updated_at,details")
      .eq("occurrence_id", occurrence.id).eq("user_id", occurrence.userId).abortSignal(signal));
    return rows(data).map(decodeDelivery);
  },
  async begin(occurrence: RoutineOccurrence, channel: RoutineChannel): Promise<{ started: boolean; reason: string }> {
    const data = await routineRpc("iao_begin_routine_delivery", { p_user_id: occurrence.userId, p_occurrence_id: occurrence.id, p_channel: channel });
    if (!record(data) || typeof data.started !== "boolean") throw new RoutineError("ROUTINE_UNAVAILABLE");
    return { started: data.started, reason: typeof data.reason === "string" ? data.reason : "unavailable" };
  },
  async finish(occurrence: RoutineOccurrence, channel: RoutineChannel, status: Exclude<DeliveryStatus, "pending" | "sending">,
    providerId: string | null = null, details: Record<string, unknown> = {}): Promise<boolean> {
    const result = await routineRpc("iao_finish_routine_delivery", { p_user_id: occurrence.userId, p_occurrence_id: occurrence.id,
      p_channel: channel, p_status: status, p_provider_id: providerId, p_details: details });
    if (!record(result) || typeof result.updated !== "boolean") throw new RoutineError("ROUTINE_UNAVAILABLE");
    return result.updated;
  },
  async refresh(occurrence: RoutineOccurrence, skip = false): Promise<RoutineOccurrence> {
    const result = await routineRpc("iao_refresh_routine_occurrence", { p_user_id: occurrence.userId, p_occurrence_id: occurrence.id, p_skip: skip });
    return decodeOccurrence(result, occurrence.userId);
  },
  async cancel(userId: string, id: string): Promise<void> {
    const result = await routineRpc("iao_cancel_routine_occurrence", { p_user_id: routineId(userId), p_occurrence_id: routineId(id) });
    if (!record(result) || typeof result.cancelled !== "boolean") throw new RoutineError("ROUTINE_UNAVAILABLE");
    if (!result.cancelled) throw new RoutineError("ROUTINE_NOT_FOUND", 404, "Bilan introuvable.");
  },
  async history(userId: string) {
    const data = rows(await database(signal => supabase.from("iao_routine_occurrences").select(OCCURRENCE_FIELDS)
      .eq("user_id", routineId(userId)).order("scheduled_at", { ascending: false }).limit(20).abortSignal(signal)));
    return Promise.all(data.map(async row => {
      const occurrence = decodeOccurrence(row, userId);
      return { id: occurrence.id, routineId: occurrence.routineId, scheduledAt: occurrence.scheduledAt, status: occurrence.status,
        report: { title: occurrence.report.title, body: occurrence.report.body },
        deliveries: (await this.deliveries(occurrence)).map(({ channel, status }) => ({ channel, status })) };
    }));
  },
  async preferences(userId: string): Promise<Record<string, unknown> | null> {
    const data = await database(signal => supabase.from("notification_preferences")
      .select("user_id,email_enabled,daily_report_enabled,task_completed_enabled,question_enabled,alert_enabled")
      .eq("user_id", routineId(userId)).abortSignal(signal).maybeSingle());
    if (data === null) return null;
    if (!record(data) || data.user_id !== userId) throw new RoutineError("ROUTINE_UNAVAILABLE");
    return data;
  },
  async destination(userId: string): Promise<{ phone: string | null; email: string | null }> {
    const deadline = createProviderDeadline(7_000, "Identité de contact indisponible");
    try {
      const { data, error } = await deadline.wait(() => supabase.auth.admin.getUserById(routineId(userId)));
      const user = data.user;
      if (error || !user || user.id !== userId) throw new RoutineError("ROUTINE_IDENTITY_UNAVAILABLE");
      const raw = user.phone?.startsWith("+") ? user.phone : `+${user.phone ?? ""}`;
      return { phone: user.phone_confirmed_at && /^\+[1-9]\d{6,14}$/.test(raw) ? raw : null,
        email: user.email_confirmed_at && typeof user.email === "string" && !/[\r\n]/.test(user.email) ? user.email : null };
    } finally { deadline.close(); }
  },
  async recordMessage(occurrence: RoutineOccurrence): Promise<void> {
    const result = await routineRpc("iao_record_routine_message", { p_user_id: occurrence.userId, p_occurrence_id: occurrence.id,
      p_title: occurrence.report.title, p_message: occurrence.report.body, p_action_url: "/notification-settings" });
    if (!record(result) || result.ok !== true || result.notification_id !== occurrence.id) throw new RoutineError("ROUTINE_MESSAGE_UNCONFIRMED");
  },
  async recordCommand(occurrence: RoutineOccurrence, requestKey: string, instruction: string): Promise<unknown> {
    return routineRpc("iao_record_routine_command", { p_user_id: occurrence.userId, p_occurrence_id: occurrence.id,
      p_request_key: requestKey, p_instruction: instruction });
  },
  async commands(userId: string): Promise<Record<string, unknown>[]> {
    const data = rows(await database(signal => supabase.from("iao_routine_commands")
      .select("id,user_id,occurrence_id,instruction,status,created_at").eq("user_id", routineId(userId))
      .eq("status", "pending_confirmation").order("created_at", { ascending: false }).limit(20).abortSignal(signal)));
    if (data.some(row => row.user_id !== userId)) throw new RoutineError("ROUTINE_UNAVAILABLE");
    return data.map(row => ({ id: routineId(row.id), occurrenceId: routineId(row.occurrence_id), instruction: row.instruction,
      status: row.status, createdAt: timestamp(row.created_at) }));
  },
};
export type RoutineStore = typeof routineStore;
