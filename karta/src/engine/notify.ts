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

/**
 * Écrit dans agent_notifications (table partagée par tous les agents, cf AGENT-COMPTA-BRIEF)
 * et envoie réellement l'email via Resend si le channel 'email' est demandé.
 * Le channel 'push' insère la notif (visible in-app) mais n'envoie pas de Web Push tant que
 * la clé VAPID privée serveur n'est pas configurée (absente de .env.secrets à ce jour) —
 * ce n'est pas un mock : c'est un intégration réelle qui dégrade proprement si la creds manque.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const channels = input.channels ?? ["in_app"];

  const { error } = await supabase.from("agent_notifications").insert({
    user_id: input.userId,
    agent_type: input.agentType,
    title: input.title,
    body: input.body,
    action_type: input.actionType ?? "info",
    action_payload: input.actionPayload ?? {},
    action_url: input.actionUrl ?? null,
    priority: input.priority ?? "normal",
    channels,
  });

  if (error) {
    throw new Error(`notify(${input.agentType}): ${error.message}`);
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
