import { supabase } from "../db/supabase.js";
import { config } from "../config.js";
import type { AgentType } from "./types.js";

export interface NotifyInput {
  userId: string;
  agentType: AgentType;
  title: string;
  body: string;
  actionType?: string;
  actionPayload?: Record<string, unknown>;
  actionUrl?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  channels?: Array<"push" | "email" | "in_app">;
}

/** Borne un fetch de notification. AbortSignal.timeout (et non Promise.race) : annulation
 * RÉELLE de la requête — notify est awaited dans le chemin succès de loop.ts, un fetch pendu
 * (~5min par défaut undici) tenait le verrou anti-double du cycle jusqu'à son TTL (600s).
 * Couvre aussi la lecture du corps : le signal abort fait rejeter response.text(). */
const NOTIFY_TIMEOUT_MS = 15_000;

/**
 * Envoie une notification réelle (in-app + push Web via VAPID + email via Resend selon `channels`).
 * Réutilise `agent-push-send` (edge function partagée par tous les agents Purama — compta, email n8n...)
 * pour l'insert `agent_notifications` + le Web Push, au lieu de dupliquer cette logique : 1 source de
 * vérité pour l'envoi push (gestion des abonnements expirés, VAPID, etc.), déjà en prod.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const channels = input.channels ?? ["in_app"];

  const response = await fetch(`${config.supabaseUrl}/functions/v1/agent-push-send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_id: input.userId,
      agent_type: input.agentType,
      title: input.title,
      body: input.body,
      action_type: input.actionType ?? "info",
      action_payload: input.actionPayload ?? {},
      action_url: input.actionUrl ?? null,
      priority: input.priority ?? "normal",
      channels,
    }),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`notify(${input.agentType}): agent-push-send a répondu ${response.status}: ${text}`);
  }

  if (channels.includes("email")) {
    await sendEmail(input);
  }
}

async function sendEmail(input: NotifyInput): Promise<void> {
  if (!config.resendApiKey) {
    console.warn(`[notify] RESEND_API_KEY absente — email "${input.title}" non envoyé (notif in-app créée)`);
    return;
  }

  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(input.userId);
  if (userError || !userData.user?.email) {
    console.warn(`[notify] impossible de résoudre l'email du user ${input.userId}: ${userError?.message}`);
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.resendFromEmail,
      to: userData.user.email,
      subject: input.title,
      html: `<p>${input.body}</p>`,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[notify] échec envoi Resend (${response.status}): ${text}`);
  }
}
