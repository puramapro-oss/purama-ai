import { supabase } from "../db/supabase.js";
import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";

interface EmailAgentConfigRow {
  gmail_refresh_token: string | null;
  gmail_access_token: string | null;
  gmail_token_expiry: string | null;
}

/** Rafraîchit et retourne un access token Gmail valide pour ce user, ou null si OAuth jamais complété. */
export async function getGmailAccessToken(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("email_agent_config")
    .select("gmail_refresh_token, gmail_access_token, gmail_token_expiry")
    .eq("user_id", userId)
    .maybeSingle<EmailAgentConfigRow>();

  if (error) throw new Error(`getGmailAccessToken: ${error.message}`);
  if (!data?.gmail_refresh_token) return null;

  const stillValid = data.gmail_token_expiry && new Date(data.gmail_token_expiry).getTime() > Date.now() + 60_000;
  if (stillValid && data.gmail_access_token) return data.gmail_access_token;

  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error("GOOGLE_CLIENT_ID/SECRET non configurés côté KARTA — impossible de rafraîchir le token Gmail");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: data.gmail_refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new Error(`Refresh token Gmail échoué (${response.status}): ${await response.text()}`);
  }

  const refreshed = (await response.json()) as { access_token: string; expires_in: number };

  await supabase
    .from("email_agent_config")
    .update({
      gmail_access_token: refreshed.access_token,
      gmail_token_expiry: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    })
    .eq("user_id", userId);

  return refreshed.access_token;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
}

/** Liste les messages reçus depuis la dernière synchro (utilisé par emailAgent.buildContext). */
export async function listNewGmailMessages(userId: string, lastEmailId: string | null): Promise<GmailMessageSummary[]> {
  const accessToken = await getGmailAccessToken(userId);
  if (!accessToken) return []; // OAuth jamais complété — pas une erreur, juste rien à traiter

  const query = lastEmailId ? `after:${lastEmailId}` : "is:unread";
  const listResponse = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!listResponse.ok) {
    throw new Error(`Gmail list échoué (${listResponse.status}): ${await listResponse.text()}`);
  }

  const list = (await listResponse.json()) as { messages?: Array<{ id: string; threadId: string }> };
  if (!list.messages || list.messages.length === 0) return [];

  const summaries: GmailMessageSummary[] = [];
  for (const m of list.messages) {
    const detailResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!detailResponse.ok) continue;
    const detail = (await detailResponse.json()) as {
      snippet?: string;
      payload?: { headers?: Array<{ name: string; value: string }> };
    };
    const headers = detail.payload?.headers ?? [];
    summaries.push({
      id: m.id,
      threadId: m.threadId,
      from: headers.find((h) => h.name === "From")?.value ?? "inconnu",
      subject: headers.find((h) => h.name === "Subject")?.value ?? "(sans sujet)",
      snippet: detail.snippet ?? "",
    });
  }

  return summaries;
}

/**
 * Contexte "boîte mail" partagé par l'agent cœur Email (Tissma) et l'agent action
 * Répondeur Intelligent (clients) — même mécanique de connexion Gmail (email_agent_config),
 * seul le systemPrompt/persona diffère entre les deux agents.
 */
export async function buildGmailInboxContext(userId: string): Promise<Record<string, unknown>> {
  const { data: emailConfig } = await supabase
    .from("email_agent_config")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (!emailConfig?.is_active) {
    return { newEmails: [], reason: "email_agent_config inactif ou absent (Gmail non connecté)" };
  }

  const newEmails = await listNewGmailMessages(userId, emailConfig.last_email_id ?? null);

  if (newEmails.length > 0) {
    await supabase
      .from("email_agent_config")
      .update({ last_sync_at: new Date().toISOString(), last_email_id: newEmails[0].id })
      .eq("user_id", userId);
  }

  return {
    tone: emailConfig.tone,
    signature: emailConfig.signature,
    excludedEmails: emailConfig.excluded_emails,
    newEmails,
  };
}

export const gmailCreateDraftTool: ToolDefinition<
  { threadId: string; to: string; subject: string; body: string },
  { draftId: string }
> = {
  name: "gmail_create_draft",
  description: "Crée un brouillon de réponse Gmail (n'envoie rien — nécessite validation humaine avant envoi).",
  sensitive: false,
  async execute(params, ctx) {
    const accessToken = await getGmailAccessToken(ctx.userId);
    if (!accessToken) throw new Error("Gmail OAuth non complété pour cet utilisateur");

    const raw = buildRawEmail(params.to, params.subject, params.body);
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { threadId: params.threadId, raw } }),
    });

    if (!response.ok) throw new Error(`Gmail create draft échoué (${response.status}): ${await response.text()}`);
    const created = (await response.json()) as { id: string };
    return { draftId: created.id };
  },
};

export const gmailSendTool: ToolDefinition<{ to: string; subject: string; body: string }, { messageId: string }> = {
  name: "gmail_send",
  description: "Envoie réellement un email au nom de l'utilisateur — action sensible.",
  sensitive: true,
  async execute(params, ctx) {
    await assertUnderDailySendLimit(ctx.userId);

    const accessToken = await getGmailAccessToken(ctx.userId);
    if (!accessToken) throw new Error("Gmail OAuth non complété pour cet utilisateur");

    const raw = buildRawEmail(params.to, params.subject, params.body);
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });

    if (!response.ok) throw new Error(`Gmail send échoué (${response.status}): ${await response.text()}`);
    const sent = (await response.json()) as { id: string };
    return { messageId: sent.id };
  },
};

const DAILY_SEND_LIMIT = 400;

interface DailySendCounter {
  date: string;
  count: number;
}

/**
 * Anti-spam / anti-ban Gmail (cf brief §Sécurité, non négociable) : max 400 envois/jour/compte
 * Gmail. Compteur partagé entre l'agent cœur `email` et l'agent action `repondeur-intelligent`
 * (même compte Gmail réel derrière les deux, cf buildGmailInboxContext) — clé `agent_type='gmail'`
 * volontairement indépendante du type d'agent KARTA qui appelle l'outil.
 */
async function assertUnderDailySendLimit(userId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  const { data } = await supabase
    .from("karta_agent_memory")
    .select("memory_value")
    .eq("user_id", userId)
    .eq("agent_type", "gmail")
    .eq("memory_key", "daily_send_count")
    .maybeSingle();

  const counter = data?.memory_value as DailySendCounter | undefined;
  const count = counter?.date === today ? counter.count : 0;

  if (count >= DAILY_SEND_LIMIT) {
    throw new Error(`Limite quotidienne d'envoi Gmail atteinte (${DAILY_SEND_LIMIT}/jour, anti-ban) — réessaie demain`);
  }

  const { error } = await supabase.from("karta_agent_memory").upsert(
    {
      user_id: userId,
      agent_type: "gmail",
      memory_key: "daily_send_count",
      memory_value: { date: today, count: count + 1 },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,agent_type,memory_key" }
  );
  if (error) throw new Error(`assertUnderDailySendLimit: ${error.message}`);
}

function buildRawEmail(to: string, subject: string, body: string): string {
  const message = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\n");
  return Buffer.from(message).toString("base64url");
}
