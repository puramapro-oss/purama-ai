import { supabase } from "../db/supabase.js";
import { config } from "../config.js";
import { decryptGmailToken, encryptGmailToken } from "../lib/gmail-token-crypto.js";
import type { ToolDefinition } from "../engine/types.js";

interface EmailAgentConfigRow {
  gmail_refresh_token: string | null;
  gmail_access_token: string | null;
  gmail_token_expiry: string | null;
}

const GMAIL_LIST_LIMIT = 50;
const SYNC_OVERLAP_MS = 2 * 60 * 1000;
const DAILY_SEND_LIMIT = 400;
const HEADER_BREAK = /[\r\n]/;

function assertHeader(name: string, value: string, maxLength: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || HEADER_BREAK.test(value)) {
    throw new Error(`${name} invalide`);
  }
}

function assertEmailAddress(value: string): void {
  assertHeader("Adresse email", value, 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error("Adresse email invalide");
  }
}

function assertMessageInput(to: string, subject: string, body: string): void {
  assertEmailAddress(to);
  assertHeader("Sujet", subject, 998);
  if (typeof body !== "string" || body.length > 2_000_000) {
    throw new Error("Corps du message invalide");
  }
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
  if (stillValid && data.gmail_access_token) return decryptGmailToken(data.gmail_access_token);

  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error("GOOGLE_CLIENT_ID/SECRET non configurés côté KARTA — impossible de rafraîchir le token Gmail");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: decryptGmailToken(data.gmail_refresh_token),
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new Error(`Refresh token Gmail échoué (${response.status}): ${await response.text()}`);
  }

  const refreshed = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (
    typeof refreshed.access_token !== "string" ||
    refreshed.access_token.length === 0 ||
    typeof refreshed.expires_in !== "number" ||
    !Number.isFinite(refreshed.expires_in) ||
    refreshed.expires_in <= 0
  ) {
    throw new Error("Réponse OAuth Gmail invalide");
  }

  const { error: updateError } = await supabase
    .from("email_agent_config")
    .update({
      gmail_access_token: encryptGmailToken(refreshed.access_token),
      gmail_token_expiry: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    })
    .eq("user_id", userId);

  if (updateError) throw new Error(`Mise à jour du token Gmail échouée: ${updateError.message}`);
  return refreshed.access_token;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
}

/**
 * Liste les messages arrivés depuis la dernière synchronisation.
 * Gmail "after:" attend une date/timestamp, jamais un message id. Un léger chevauchement
 * évite de perdre un message situé exactement à la frontière temporelle.
 */
export async function listNewGmailMessages(userId: string, lastSyncAt: string | null): Promise<GmailMessageSummary[]> {
  const accessToken = await getGmailAccessToken(userId);
  if (!accessToken) return [];

  let query = "is:unread";
  if (lastSyncAt) {
    const millis = new Date(lastSyncAt).getTime();
    if (Number.isFinite(millis)) {
      query = `after:${Math.max(0, Math.floor((millis - SYNC_OVERLAP_MS) / 1000))}`;
    }
  }

  const listResponse = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${GMAIL_LIST_LIMIT}&q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!listResponse.ok) {
    throw new Error(`Gmail list échoué (${listResponse.status}): ${await listResponse.text()}`);
  }

  const list = (await listResponse.json()) as { messages?: Array<{ id?: unknown; threadId?: unknown }> };
  const rawMessages = list.messages ?? [];
  const seen = new Set<string>();
  const messages: Array<{ id: string; threadId: string }> = [];
  for (const m of rawMessages) {
    if (typeof m.id !== "string" || typeof m.threadId !== "string" || !m.id || !m.threadId) {
      throw new Error("Réponse Gmail list invalide");
    }
    if (!seen.has(m.id)) {
      seen.add(m.id);
      messages.push({ id: m.id, threadId: m.threadId });
    }
  }

  const summaries: GmailMessageSummary[] = [];
  for (const m of messages) {
    const detailResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!detailResponse.ok) {
      throw new Error(`Gmail message ${m.id} illisible (${detailResponse.status})`);
    }
    const detail = (await detailResponse.json()) as {
      snippet?: unknown;
      payload?: { headers?: Array<{ name?: unknown; value?: unknown }> };
    };
    const headers = detail.payload?.headers ?? [];
    const headerValue = (name: string) => {
      const entry = headers.find((h) => h.name === name);
      return typeof entry?.value === "string" ? entry.value : undefined;
    };
    summaries.push({
      id: m.id,
      threadId: m.threadId,
      from: headerValue("From") ?? "inconnu",
      subject: headerValue("Subject") ?? "(sans sujet)",
      snippet: typeof detail.snippet === "string" ? detail.snippet : "",
    });
  }

  return summaries;
}

/**
 * Contexte "boîte mail" partagé par l'agent cœur Email et le Répondeur Intelligent.
 */
export async function buildGmailInboxContext(userId: string): Promise<Record<string, unknown>> {
  const { data: emailConfig, error: configError } = await supabase
    .from("email_agent_config")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (configError) throw new Error(`Configuration Gmail illisible: ${configError.message}`);
  if (!emailConfig?.is_active) {
    return { newEmails: [], reason: "email_agent_config inactif ou absent (Gmail non connecté)" };
  }

  const syncStartedAt = new Date().toISOString();
  const newEmails = await listNewGmailMessages(userId, emailConfig.last_sync_at ?? null);

  const update: Record<string, unknown> = { last_sync_at: syncStartedAt };
  if (newEmails.length > 0) update.last_email_id = newEmails[0].id;

  const { error: syncError } = await supabase
    .from("email_agent_config")
    .update(update)
    .eq("user_id", userId);

  if (syncError) throw new Error(`Curseur Gmail non enregistré: ${syncError.message}`);

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
  inputSchema: {
    type: "object",
    properties: {
      threadId: { type: "string", minLength: 1, maxLength: 256 },
      to: { type: "string", minLength: 3, maxLength: 320 },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      body: { type: "string", maxLength: 2_000_000 },
    },
    required: ["threadId", "to", "subject", "body"],
    additionalProperties: false,
  },
  async execute(params, ctx) {
    assertMessageInput(params.to, params.subject, params.body);
    if (typeof params.threadId !== "string" || !params.threadId || params.threadId.length > 256) {
      throw new Error("Thread Gmail invalide");
    }

    const accessToken = await getGmailAccessToken(ctx.userId);
    if (!accessToken) throw new Error("Gmail OAuth non complété pour cet utilisateur");

    const raw = buildRawEmail(params.to, params.subject, params.body);
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { threadId: params.threadId, raw } }),
    });

    if (!response.ok) throw new Error(`Gmail create draft échoué (${response.status}): ${await response.text()}`);
    const created = (await response.json()) as { id?: unknown };
    if (typeof created.id !== "string" || !created.id) throw new Error("Réponse Gmail draft invalide");
    return { draftId: created.id };
  },
};

export const gmailSendTool: ToolDefinition<{ to: string; subject: string; body: string }, { messageId: string }> = {
  name: "gmail_send",
  description: "Envoie réellement un email au nom de l'utilisateur — action sensible.",
  sensitive: true,
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", minLength: 3, maxLength: 320 },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      body: { type: "string", maxLength: 2_000_000 },
    },
    required: ["to", "subject", "body"],
    additionalProperties: false,
  },
  async execute(params, ctx) {
    assertMessageInput(params.to, params.subject, params.body);
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
    const sent = (await response.json()) as { id?: unknown };
    if (typeof sent.id !== "string" || !sent.id) throw new Error("Réponse Gmail send invalide");
    return { messageId: sent.id };
  },
};

/** Réservation atomique : deux workers concurrents ne peuvent plus dépasser le plafond. */
async function assertUnderDailySendLimit(userId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.rpc("karta_reserve_daily_counter", {
    p_user_id: userId,
    p_counter_key: "gmail_send",
    p_day: today,
    p_limit: DAILY_SEND_LIMIT,
  });

  if (error) throw new Error(`Réservation du quota Gmail impossible: ${error.message}`);
  if (typeof data !== "number" || data < 1 || data > DAILY_SEND_LIMIT) {
    throw new Error(`Limite quotidienne d'envoi Gmail atteinte (${DAILY_SEND_LIMIT}/jour, anti-ban) — réessaie demain`);
  }
}

export function buildRawEmail(to: string, subject: string, body: string): string {
  assertMessageInput(to, subject, body);
  const message = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
  return Buffer.from(message).toString("base64url");
}
