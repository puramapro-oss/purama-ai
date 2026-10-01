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
  });

  if (!response.ok) {
    throw new Error(`notify(${input.agentType}): agent-push-send a répondu ${response.status}`);
  }

  const receipt: unknown = await response.json();
  if (!isRecord(receipt) || receipt.ok !== true || !nonEmptyString(receipt.notification_id) || "error" in receipt) {
    throw new Error(`notify(${input.agentType}): enregistrement non confirmé — vérifier avant toute reprise`);
  }
  let pushUnconfirmed = false;
  if (channels.includes("push")) {
    pushUnconfirmed = !Number.isSafeInteger(receipt.push_sent) || (receipt.push_sent as number) <= 0 ||
      !Number.isSafeInteger(receipt.push_failed) || receipt.push_failed !== 0;
  }

  if (channels.includes("email")) {
    await sendEmail(input);
  }
  if (pushUnconfirmed) throw new Error(`notify(${input.agentType}): notification enregistrée, push non confirmé — vérifier sans renvoi automatique`);
}

async function sendEmail(input: NotifyInput): Promise<void> {
  if (!config.resendApiKey) {
    throw new Error("notify: notification enregistrée mais email demandé non envoyé (configuration Resend absente)");
  }

  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(input.userId);
  if (userError || !userData.user?.email) {
    throw new Error("notify: notification enregistrée mais destinataire email non confirmé");
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
      text: input.body,
    }),
  });

  if (!response.ok) {
    throw new Error(`notify: notification enregistrée mais Resend a répondu ${response.status}`);
  }
  const receipt: unknown = await response.json();
  if (!isRecord(receipt) || !nonEmptyString(receipt.id) || "error" in receipt) {
    throw new Error("notify: acceptation de l'email non confirmée — vérifier avant toute reprise");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
