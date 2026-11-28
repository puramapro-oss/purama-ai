import { config } from "../config.js";
import { createProviderDeadline, requestProviderJson } from "../tools/provider-http.js";
import type { Routine, RoutineChannel } from "./contracts.js";
import { phoneCommandToken } from "./commands.js";
import type { PhoneProvider } from "./phone.js";
import { phoneConfigured, type RoutineRuntimeConfig } from "./runtime.js";
import { record, RoutineError, type RoutineOccurrence, type RoutineStore } from "./store.js";

export interface DeliveryReceipt {
  status: "accepted" | "completed";
  providerId: string;
  details?: Record<string, unknown>;
}
export interface DeliveryPreparation { phone: string | null; email: string | null }
/** A provider receipt proves that the selected channel reached no destination. */
export class RoutineTransportNotDeliveredError extends Error {
  constructor() { super("Aucun destinataire n’a reçu ce canal."); this.name = "RoutineTransportNotDeliveredError"; }
}

/** Check transport readiness before consuming a durable dispatch attempt. */
export async function prepareRoutineDelivery(channel: RoutineChannel, occurrence: RoutineOccurrence,
  runtime: RoutineRuntimeConfig, store: RoutineStore): Promise<DeliveryPreparation> {
  const contact = channel === "call" || channel === "email" ? await store.destination(occurrence.userId) : { phone: null, email: null };
  if (channel === "call" && (!phoneConfigured(runtime) || runtime.commandSecret.length < 32 || !contact.phone)) {
    throw new RoutineError("ROUTINE_CALL_UNAVAILABLE", 409, "Un numéro vérifié et la configuration téléphonique sont nécessaires.");
  }
  if (channel === "email" && (!config.resendApiKey.trim() || !contact.email)) {
    throw new RoutineError("ROUTINE_EMAIL_UNAVAILABLE", 409, "L’adresse e-mail vérifiée et le service d’envoi sont nécessaires.");
  }
  if (channel === "push" && !runtime.pushEnabled) throw new RoutineError("ROUTINE_PUSH_UNAVAILABLE", 409, "Les notifications push ne sont pas encore disponibles.");
  return contact;
}

/** No retries here: a failed transport can already have produced an effect. */
export async function deliverRoutineChannel(channel: RoutineChannel, occurrence: RoutineOccurrence, routine: Routine,
  contact: DeliveryPreparation, runtime: RoutineRuntimeConfig, store: RoutineStore, phone: PhoneProvider): Promise<DeliveryReceipt> {
  if (channel === "in_app") {
    await store.recordMessage(occurrence);
    return { status: "completed", providerId: occurrence.id, details: { recorded: true, readConfirmed: false } };
  }
  if (channel === "call") {
    if (!contact.phone) throw new Error("Destinataire téléphonique indisponible");
    const expiresAt = new Date(Date.now() + (routine.config.maxCallMinutes + 5) * 60_000).toISOString();
    const receipt = await phone.startPhoneCall({ occurrenceId: occurrence.id, routineId: routine.id,
      phoneNumber: contact.phone, briefing: occurrence.report.body, instruction: routine.config.instruction,
      maxDurationMinutes: routine.config.maxCallMinutes,
      commandContext: { occurrenceId: occurrence.id, expiresAt, token: phoneCommandToken(runtime.commandSecret, occurrence, expiresAt) } });
    if (receipt.externalId !== occurrence.id || receipt.status !== "accepted") throw new Error("Reçu d’appel non confirmé");
    return { status: "accepted", providerId: receipt.callId, details: { heardConfirmed: false } };
  }
  const deadline = createProviderDeadline(10_000, "Livraison non confirmée");
  try {
    if (channel === "email") {
      const receipt = await requestProviderJson("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: config.resendFromEmail, to: contact.email,
          subject: occurrence.report.title.replace(/[\r\n]/g, " "), text: occurrence.report.body }),
      }, deadline, 16_384);
      if (!record(receipt) || typeof receipt.id !== "string" || !receipt.id.trim() || receipt.error != null) throw new Error("Reçu email absent");
      return { status: "accepted", providerId: receipt.id, details: { readConfirmed: false } };
    }
    // Reuse the existing VAPID sender. The visible push carries no project data.
    const receipt = await requestProviderJson(`${config.supabaseUrl}/functions/v1/agent-push-send`, {
      method: "POST", headers: { Authorization: `Bearer ${config.supabaseServiceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: occurrence.userId, agent_type: "iao-routines", title: "Un bilan IAO est prêt",
        body: "Ouvrez IAO pour consulter votre bilan.", action_type: "daily_report", action_payload: { occurrence_id: occurrence.id },
        action_url: "/notification-settings", priority: "normal", channels: ["push"] }),
    }, deadline, 16_384);
    if (!record(receipt) || receipt.ok !== true || typeof receipt.notification_id !== "string" || !receipt.notification_id.trim()) throw new Error("Livraison push non confirmée");
    if (receipt.push_sent === 0 && receipt.push_failed === 0) throw new RoutineTransportNotDeliveredError();
    if (!Number.isSafeInteger(receipt.push_sent) || Number(receipt.push_sent) < 1 || receipt.push_failed !== 0) throw new Error("Livraison push non confirmée");
    return { status: "accepted", providerId: receipt.notification_id, details: { readConfirmed: false, pushAccepted: receipt.push_sent } };
  } finally { deadline.close(); }
}
