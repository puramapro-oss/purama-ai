import { supabase } from "../db/supabase.js";
import { config } from "../config.js";
import { decryptGmailToken, encryptGmailToken } from "../lib/gmail-token-crypto.js";
import type { ToolDefinition } from "../engine/types.js";
import { extractGmailPlainText, gmailHeader, readBoundedGmailJson, type GmailBodyContent } from "./gmail-message.js";

interface EmailAgentConfigRow {
  gmail_refresh_token: string | null;
  gmail_access_token: string | null;
  gmail_token_expiry: string | null;
}

const GMAIL_LIST_LIMIT = 50;
const GMAIL_MAX_LIST_PAGES = 5;
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

export interface GmailMessageSummary extends GmailBodyContent {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  replyToMessageId: string;
}

/**
 * Liste les messages arrivés depuis la dernière synchronisation.
 * Gmail "after:" attend une date/timestamp, jamais un message id. Un léger chevauchement
 * évite de perdre un message situé exactement à la frontière temporelle.
 */
export async function listNewGmailMessages(userId: string, lastSyncAt: string | null): Promise<GmailMessageSummary[]> {
  const accessToken = await getGmailAccessToken(userId);
  if (!accessToken) throw new Error("Gmail OAuth absent : collecte impossible, synchronisation non avancée");

  let query = "is:unread";
  if (lastSyncAt) {
    const millis = new Date(lastSyncAt).getTime();
    if (Number.isFinite(millis)) {
      query = `after:${Math.max(0, Math.floor((millis - SYNC_OVERLAP_MS) / 1000))}`;
    }
  }

  const seen = new Set<string>();
  const seenPages = new Set<string>();
  const messages: Array<{ id: string; threadId: string }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < GMAIL_MAX_LIST_PAGES; page++) {
    const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const listResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${GMAIL_LIST_LIMIT}&q=${encodeURIComponent(query)}${pageParam}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) }
    );
    if (!listResponse.ok) throw new Error(`Gmail list échoué (${listResponse.status})`);
    const list = (await readBoundedGmailJson(listResponse)) as { messages?: Array<{ id?: unknown; threadId?: unknown }>; nextPageToken?: unknown };
    const rawMessages = list.messages ?? [];
    if (!Array.isArray(rawMessages) || rawMessages.length > GMAIL_LIST_LIMIT) throw new Error("Réponse Gmail list invalide");
    for (const m of rawMessages) {
      if (typeof m.id !== "string" || typeof m.threadId !== "string" || !m.id || !m.threadId) throw new Error("Réponse Gmail list invalide");
      if (!seen.has(m.id)) {
        seen.add(m.id);
        messages.push({ id: m.id, threadId: m.threadId });
      }
    }
    if (list.nextPageToken === undefined || list.nextPageToken === "") break;
    if (typeof list.nextPageToken !== "string" || list.nextPageToken.length > 4096 || seenPages.has(list.nextPageToken)) throw new Error("Pagination Gmail invalide ou répétée : synchronisation non avancée");
    if (page === GMAIL_MAX_LIST_PAGES - 1) throw new Error("Pagination Gmail incomplète après cinq pages : synchronisation non avancée");
    seenPages.add(list.nextPageToken);
    pageToken = list.nextPageToken;
  }

  const summaries: GmailMessageSummary[] = [];
  let contextBytes = 0;
  for (const m of messages) {
    const detailResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) }
    );
    if (!detailResponse.ok) {
      throw new Error(`Gmail message ${m.id} illisible (${detailResponse.status})`);
    }
    const detail = (await readBoundedGmailJson(detailResponse)) as {
      id?: unknown;
      threadId?: unknown;
      snippet?: unknown;
      payload?: unknown;
    };
    if (detail.id !== m.id || detail.threadId !== m.threadId) throw new Error("Identité du message Gmail incohérente");
    const content = extractGmailPlainText(detail.payload);
    contextBytes += Buffer.byteLength(content.body ?? "", "utf8");
    // Fail before the caller advances last_sync_at; a truncated batch is not a completed sync.
    if (contextBytes > 256 * 1024) throw new Error("Lot Gmail trop volumineux : synchronisation non avancée");
    summaries.push({
      id: m.id,
      threadId: m.threadId,
      from: gmailHeader(detail.payload, "From") ?? "inconnu",
      subject: gmailHeader(detail.payload, "Subject") ?? "(sans sujet)",
      snippet: typeof detail.snippet === "string" ? detail.snippet : "",
      replyToMessageId: m.id,
      ...content,
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
  { threadId: string; replyToMessageId?: string; to: string; subject: string; body: string },
  { draftId: string }
> = {
  name: "gmail_create_draft",
  description: "Crée un brouillon de réponse Gmail lié au message parent (replyToMessageId), avec sujet et destinataire vérifiés ; n'envoie rien.",
  sensitive: false,
  inputSchema: {
    type: "object",
    properties: {
      threadId: { type: "string", minLength: 1, maxLength: 256 },
      replyToMessageId: { type: "string", minLength: 1, maxLength: 256 },
      to: { type: "string", minLength: 3, maxLength: 320 },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      body: { type: "string", maxLength: 2_000_000 },
    },
    required: ["threadId", "to", "subject", "body"],
    additionalProperties: false,
  },
  async execute(params, ctx) {
    assertMessageInput(params.to, params.subject, params.body);
    assertGmailId(params.threadId);
    assertReplyInput(params, ctx.agentType === "email" || ctx.agentType === "repondeur-intelligent");

    const accessToken = await getGmailAccessToken(ctx.userId);
    if (!accessToken) throw new Error("Gmail OAuth non complété pour cet utilisateur");

    const reply = await gmailReplyHeaders(params, accessToken);
    const raw = buildRawEmail(params.to, params.subject, params.body, reply);
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

interface GmailReplyInput {
  threadId?: string;
  replyToMessageId?: string;
}

interface GmailReplyHeaders {
  inReplyTo: string;
  references: string;
}

function assertGmailId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error("Identifiant Gmail invalide");
}

function assertReplyInput(params: GmailReplyInput, replyRequired = false): void {
  if (replyRequired && (!params.threadId || !params.replyToMessageId)) throw new Error("Ce rôle de réponse exige threadId et replyToMessageId");
  if (params.threadId !== undefined) assertGmailId(params.threadId);
  if (params.replyToMessageId !== undefined) {
    assertGmailId(params.replyToMessageId);
    if (params.threadId === undefined) throw new Error("Fil Gmail requis pour une réponse");
  }
}

function singleMailbox(value: string): string {
  const match = /^(?:[^<>]*<([^<>]+)>|([^<>]+))$/.exec(value);
  if (match?.[1] && value.slice(0, value.indexOf("<")).includes("@")) throw new Error("Destinataire parent Gmail ambigu");
  const address = (match?.[1] ?? match?.[2] ?? "").trim();
  assertEmailAddress(address);
  if (/[,;:<>]/.test(address)) throw new Error("Destinataire parent Gmail ambigu");
  return address.toLowerCase();
}

/** Resolve reply headers from this user's mailbox, never from model-supplied RFC headers. */
async function gmailReplyHeaders(params: GmailReplyInput & { to: string; subject: string }, accessToken: string): Promise<GmailReplyHeaders | undefined> {
  assertReplyInput(params);
  if (!params.threadId) return undefined;
  const headersQuery = "format=full";
  const url = params.replyToMessageId
    ? `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(params.replyToMessageId)}?${headersQuery}`
    : `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(params.threadId)}?${headersQuery}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Parent Gmail illisible (${response.status})`);
  const value = await readBoundedGmailJson(response) as { id?: unknown; threadId?: unknown; payload?: unknown; messages?: Array<{ id?: unknown; threadId?: unknown; payload?: unknown }> };
  let parent = value;
  if (!params.replyToMessageId) {
    // Preserve legacy single-message replies without guessing among multiple parents.
    if (value.id !== params.threadId || !Array.isArray(value.messages) || value.messages.length !== 1) {
      throw new Error("Message parent Gmail requis pour ce fil ambigu");
    }
    parent = value.messages[0]!;
  }
  assertGmailId(parent.id);
  if ((params.replyToMessageId && parent.id !== params.replyToMessageId) || parent.threadId !== params.threadId) throw new Error("Fil ou message parent Gmail incohérent");
  if (extractGmailPlainText(parent.payload).bodyStatus !== "complete") throw new Error("Texte parent Gmail non lu intégralement : revue requise");
  const subject = gmailHeader(parent.payload, "Subject");
  if (subject !== params.subject) throw new Error("Le sujet de la réponse doit correspondre au sujet du parent Gmail");
  const from = gmailHeader(parent.payload, "From");
  if (!from || singleMailbox(from) !== params.to.toLowerCase()) throw new Error("Destinataire différent du parent Gmail : revue requise");
  const replyTo = gmailHeader(parent.payload, "Reply-To");
  if (replyTo && singleMailbox(replyTo) !== singleMailbox(from)) throw new Error("Adresse Reply-To différente : revue du destinataire requise");
  const inReplyTo = gmailHeader(parent.payload, "Message-ID");
  const validMessageId = (value: string) => /^<[^<>\s@]+@[^<>\s@]+>$/.test(value);
  if (!inReplyTo || !validMessageId(inReplyTo)) throw new Error("Message-ID du parent Gmail invalide");
  const ancestors = gmailHeader(parent.payload, "References")?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (ancestors.some(value => !validMessageId(value))) throw new Error("References du parent Gmail invalides");
  const references = [...ancestors, inReplyTo].join(" ");
  assertHeader("In-Reply-To", inReplyTo, 998);
  assertHeader("References", references, 998);
  return { inReplyTo, references };
}

export const gmailSendTool: ToolDefinition<{ to: string; subject: string; body: string } & GmailReplyInput, { messageId: string }> = {
  name: "gmail_send",
  description: "Envoie réellement un email — action sensible. Pour une réponse, fournir threadId et replyToMessageId du parent, en conservant son sujet et son destinataire.",
  sensitive: true,
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", minLength: 3, maxLength: 320 },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      body: { type: "string", maxLength: 2_000_000 },
      threadId: { type: "string", minLength: 1, maxLength: 256 },
      replyToMessageId: { type: "string", minLength: 1, maxLength: 256 },
    },
    required: ["to", "subject", "body"],
    additionalProperties: false,
  },
  async execute(params, ctx) {
    assertMessageInput(params.to, params.subject, params.body);
    assertReplyInput(params, ctx.agentType === "email" || ctx.agentType === "repondeur-intelligent");

    const accessToken = await getGmailAccessToken(ctx.userId);
    if (!accessToken) throw new Error("Gmail OAuth non complété pour cet utilisateur");

    const reply = await gmailReplyHeaders(params, accessToken);
    // On ne consomme une réservation qu'une fois l'authentification réellement disponible.
    await assertUnderDailySendLimit(ctx.userId);
    const raw = buildRawEmail(params.to, params.subject, params.body, reply);
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw, ...(params.threadId ? { threadId: params.threadId } : {}) }),
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

export function buildRawEmail(to: string, subject: string, body: string, reply?: GmailReplyHeaders): string {
  assertMessageInput(to, subject, body);
  if (reply) {
    assertHeader("In-Reply-To", reply.inReplyTo, 998);
    assertHeader("References", reply.references, 998);
  }
  const replyHeaders = reply ? [`In-Reply-To: ${reply.inReplyTo}`, `References: ${reply.references}`] : [];
  const message = [`To: ${to}`, `Subject: ${subject}`, ...replyHeaders, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
  return Buffer.from(message).toString("base64url");
}
