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
  operationId?: string;
}

function normalizedTitle(value: string): string {
  return value.replace(/[\r\n\u0000]/g, " ").trim().slice(0, 200);
}

function normalizedBody(value: string): string {
  return value.replace(/\u0000/g, "").trim().slice(0, 10_000);
}

export async function notify(input: NotifyInput): Promise<void> {
  if (!config.kartaEdgeToken) {
    throw new Error("KARTA_EDGE_TOKEN absent : notification interne refusée");
  }

  const channels = input.channels ?? ["in_app"];
  const title = normalizedTitle(input.title);
  const body = normalizedBody(input.body);
  if (!title || !body) throw new Error("Notification vide ou invalide");

  const response = await fetch(`${config.supabaseUrl}/functions/v1/agent-push-send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.kartaEdgeToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_id: input.userId,
      agent_type: input.agentType,
      title,
      body,
      action_type: input.actionType ?? "info",
      action_payload: input.actionPayload ?? {},
      action_url: input.actionUrl ?? null,
      priority: input.priority ?? "normal",
      channels,
      operation_id: input.operationId ?? null,
    }),
  });

  if (!response.ok) {
    throw new Error(`notify(${input.agentType}): service de notification indisponible (${response.status})`);
  }

  if (channels.includes("email")) {
    await sendEmail({ ...input, title, body });
  }
}

async function sendEmail(input: NotifyInput): Promise<void> {
  if (!config.resendApiKey) {
    console.warn("[notify] RESEND_API_KEY absente — notification email non envoyée");
    return;
  }

  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(input.userId);
  if (userError || !userData.user?.email) {
    console.warn("[notify] impossible de résoudre l'adresse email du destinataire");
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
      subject: normalizedTitle(input.title),
      // Texte brut : une sortie modèle ne doit jamais devenir du HTML exécutable.
      text: normalizedBody(input.body),
    }),
  });

  if (!response.ok) {
    console.error(`[notify] échec envoi Resend (${response.status})`);
  }
}
