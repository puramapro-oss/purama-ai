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

const NOTIFY_DEADLINE_MS = 10_000;

function hasReceipt(value: unknown, idField: string): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const id = receipt[idField];
  return receipt.error == null && typeof id === "string" && id.trim().length > 0;
}

/**
 * Envoie une notification réelle (in-app + push Web via VAPID + email via Resend selon `channels`).
 * Réutilise `agent-push-send` (edge function partagée par tous les agents Purama — compta, email n8n...)
 * pour l'insert `agent_notifications` + le Web Push, au lieu de dupliquer cette logique : 1 source de
 * vérité pour l'envoi push (gestion des abonnements expirés, VAPID, etc.). Un succès confirme
 * l'acceptation par les fournisseurs demandés, jamais la lecture par le destinataire.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const channels: NonNullable<NotifyInput["channels"]> = [...(input.channels ?? ["in_app"])];
  const request = { ...input, channels };
  const controller = new AbortController();
  const expiresAt = Date.now() + NOTIFY_DEADLINE_MS;
  let inAppConfirmed = false;
  const assertActive = () => {
    // Also guard delayed continuations when a transport ignores abort, or the
    // event loop has not yet dispatched the deadline timer.
    if (controller.signal.aborted || Date.now() >= expiresAt) {
      controller.abort();
      throw new Error("Délai de notification dépassé");
    }
  };
  let timer!: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Délai de notification dépassé"));
    }, NOTIFY_DEADLINE_MS);
  });

  const deliver = async () => {
    const body = JSON.stringify({
      user_id: request.userId,
      agent_type: request.agentType,
      title: request.title,
      body: request.body,
      action_type: request.actionType ?? "info",
      action_payload: request.actionPayload ?? {},
      action_url: request.actionUrl ?? null,
      priority: request.priority ?? "normal",
      channels,
    });
    assertActive();
    const response = await fetch(`${config.supabaseUrl}/functions/v1/agent-push-send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });
    assertActive();
    if (!response.ok) throw new Error("Notification non confirmée");
    const receipt: unknown = await response.json();
    assertActive();
    if (!hasReceipt(receipt, "notification_id") || receipt.ok !== true) {
      throw new Error("Reçu de notification absent ou invalide");
    }
    inAppConfirmed = true;

    if (channels.includes("push") && (typeof receipt.push_sent !== "number"
      || !Number.isSafeInteger(receipt.push_sent) || receipt.push_sent < 1 || receipt.push_failed !== 0)) {
      throw new Error("Livraison push non confirmée");
    }
    if (channels.includes("email")) await sendEmail(request, controller.signal, assertActive);
  };

  try {
    // One budget covers both fetches, their response bodies and the auth lookup.
    // A timeout cannot prove non-delivery, so never retry automatically here.
    await Promise.race([deliver(), expired]);
  } catch {
    throw new Error(inAppConfirmed
      ? "Notification enregistrée ; livraison demandée non confirmée : vérifier son état avant toute reprise"
      : "Envoi de notification non confirmé : vérifier son état avant toute reprise");
  } finally {
    clearTimeout(timer);
  }
}

async function sendEmail(input: NotifyInput, signal: AbortSignal, assertActive: () => void): Promise<void> {
  assertActive();
  if (!config.resendApiKey.trim()) throw new Error("Email non configuré");

  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(input.userId);
  // Supabase admin auth exposes no AbortSignal here. If its response arrives
  // after the global deadline, do not start a late email with that response.
  assertActive();
  const email = userData.user?.email;
  if (userError || typeof email !== "string" || !email.trim()) {
    throw new Error("Destinataire email indisponible");
  }

  const body = JSON.stringify({
    from: config.resendFromEmail,
    to: email.trim(),
    subject: input.title.replace(/[\r\n]+/g, " ").slice(0, 998),
    text: input.body,
  });
  assertActive();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body,
    signal,
  });
  assertActive();
  if (!response.ok) throw new Error("Email non confirmé");
  const receipt: unknown = await response.json();
  assertActive();
  if (!hasReceipt(receipt, "id")) throw new Error("Reçu email absent ou invalide");
}
