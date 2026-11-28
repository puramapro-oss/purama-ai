import { supabase } from "../db/supabase.js";
import { config } from "../config.js";
import { decryptGmailToken, encryptGmailToken } from "../lib/gmail-token-crypto.js";
import type { ToolDefinition } from "../engine/types.js";
import { assertToolResult } from "../engine/tool-result.js";
import { extractGmailPlainText, gmailHeader, readBoundedGmailJson, type GmailBodyContent } from "./gmail-message.js";
import { createProviderDeadline, requestProviderJson, type ProviderDeadline } from "./provider-http.js";

interface EmailAgentConfigRow {
  id: string;
  gmail_email: string | null;
  updated_at: string;
  gmail_refresh_token: string | null;
  gmail_access_token: string | null;
  gmail_token_expiry: string | null;
}

const GMAIL_LIST_LIMIT = 50;
const GMAIL_MAX_LIST_PAGES = 5;
const SYNC_OVERLAP_MS = 2 * 60 * 1000;
const DAILY_SEND_LIMIT = 400;
const HEADER_BREAK = /[\r\n]/;
const GMAIL_CREDENTIAL_TIMEOUT_MS = 20_000;
const GMAIL_ACTION_TIMEOUT_MS = 40_000;

function usableGmailToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384
    && [...value].every(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) < 127);
}

// The Edge OAuth handler uses the same total-deadline/CAS contract. Keep this
// adapter inside the Node package: its build cannot import Edge runtime files.
function gmailCredentialDeadline() {
  return createProviderDeadline(GMAIL_CREDENTIAL_TIMEOUT_MS, "Délai de connexion Gmail dépassé");
}

function cancelGmailCredentialBody(body: { cancel(): Promise<unknown> } | null | undefined): void {
  try { void body?.cancel().catch(() => {}); } catch { /* A broken cleanup cannot hold a deadline open. */ }
}

async function gmailCredentialJson(
  url: string, init: RequestInit, deadline: ReturnType<typeof gmailCredentialDeadline>, maxBytes: number,
): Promise<Record<string, unknown>> {
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await deadline.wait(async () => {
      response = await fetch(url, { ...init, redirect: "error", credentials: "omit", signal: deadline.signal });
      // A transport that ignores AbortSignal may resolve after the caller left.
      if (!deadline.active()) cancelGmailCredentialBody(response.body);
      return response;
    });
    deadline.check();
    if (!response?.ok || response.redirected || !response.body) throw new Error("Réponse Google indisponible");
    reader = response.body.getReader();
    const bytes: Uint8Array[] = [];
    let size = 0;
    let emptyChunks = 0;
    for (;;) {
      const part = await deadline.wait(() => reader!.read());
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new Error("Réponse Google invalide");
      if (part.value.byteLength === 0 && ++emptyChunks > 64) throw new Error("Flux Google invalide");
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error("Réponse Google trop volumineuse");
      bytes.push(part.value.slice());
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(bytes)));
    deadline.check();
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Réponse Google invalide");
    return value as Record<string, unknown>;
  } catch {
    deadline.check();
    // Never expose provider bodies, headers or credentials in an agent error.
    throw new Error("Réponse de connexion Gmail invalide ou indisponible");
  } finally {
    if (reader) {
      cancelGmailCredentialBody(reader);
      try { reader.releaseLock(); } catch { /* A timed-out reader may still be pending. */ }
    } else cancelGmailCredentialBody(response?.body);
  }
}

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
export async function getGmailAccessToken(userId: string, inheritedDeadline?: ProviderDeadline): Promise<string | null> {
  const deadline = inheritedDeadline ?? gmailCredentialDeadline();
  try {
    const { data, error } = await deadline.wait(async () => await supabase
      .from("email_agent_config")
      .select("id,gmail_email,updated_at,gmail_refresh_token,gmail_access_token,gmail_token_expiry")
      .eq("user_id", userId)
      .abortSignal(deadline.signal)
      .maybeSingle<EmailAgentConfigRow>());
    if (error) throw new Error("Stockage de connexion Gmail indisponible");
    if (!data?.gmail_refresh_token) return null;

    const stillValid = data.gmail_token_expiry && new Date(data.gmail_token_expiry).getTime() > Date.now() + 60_000;
    if (stillValid && data.gmail_access_token) {
      const token = decryptGmailToken(data.gmail_access_token);
      if (!usableGmailToken(token)) throw new Error("Token Gmail enregistré invalide");
      return token;
    }
    if (typeof data.id !== "string" || !data.id || typeof data.gmail_email !== "string"
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.gmail_email)
      || typeof data.updated_at !== "string" || !Number.isFinite(Date.parse(data.updated_at))) {
      throw new Error("Identité de connexion Gmail incomplète : reconnecter ce compte");
    }
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new Error("GOOGLE_CLIENT_ID/SECRET non configurés côté KARTA — impossible de rafraîchir le token Gmail");
    }
    const refreshToken = decryptGmailToken(data.gmail_refresh_token);
    if (!usableGmailToken(refreshToken)) throw new Error("Refresh token Gmail enregistré invalide");
    const refreshed = await gmailCredentialJson("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret,
        refresh_token: refreshToken, grant_type: "refresh_token" }),
    }, deadline, 64 * 1024);
    if (!usableGmailToken(refreshed.access_token)
      || typeof refreshed.token_type !== "string" || refreshed.token_type.toLowerCase() !== "bearer"
      || typeof refreshed.expires_in !== "number" || !Number.isSafeInteger(refreshed.expires_in) || refreshed.expires_in <= 0
      || refreshed.refresh_token !== undefined && !usableGmailToken(refreshed.refresh_token)
      || refreshed.scope !== undefined && (typeof refreshed.scope !== "string"
        || !refreshed.scope.split(" ").includes("https://www.googleapis.com/auth/gmail.modify"))) {
      throw new Error("Réponse OAuth Gmail invalide");
    }
    const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
    if (!Number.isFinite(expiresAt.valueOf())) throw new Error("Durée du token Gmail invalide");
    const profile = await gmailCredentialJson("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${refreshed.access_token}` },
    }, deadline, 16 * 1024);
    if (typeof profile.emailAddress !== "string" || profile.emailAddress.toLowerCase() !== data.gmail_email.toLowerCase()) {
      throw new Error("Identité du compte Gmail incohérente");
    }
    deadline.check();
    let write = supabase
      .from("email_agent_config")
      .update({ gmail_access_token: encryptGmailToken(refreshed.access_token as string),
        gmail_token_expiry: expiresAt.toISOString(),
        ...(refreshed.refresh_token !== undefined ? { gmail_refresh_token: encryptGmailToken(refreshed.refresh_token as string) } : {}),
      })
      .eq("id", data.id).eq("user_id", userId).eq("gmail_email", data.gmail_email)
      .eq("gmail_refresh_token", data.gmail_refresh_token).eq("updated_at", data.updated_at);
    // Include credential values too: a coarse or preserved version timestamp
    // must not let two refreshes overwrite one another or resurrect old data.
    write = data.gmail_access_token === null ? write.is("gmail_access_token", null)
      : write.eq("gmail_access_token", data.gmail_access_token);
    write = data.gmail_token_expiry === null ? write.is("gmail_token_expiry", null)
      : write.eq("gmail_token_expiry", data.gmail_token_expiry);
    const { data: written, error: updateError } = await deadline.wait(async () => await write
      .abortSignal(deadline.signal).select("id").maybeSingle<{ id: string }>());
    if (updateError) throw new Error("Persistance de connexion Gmail indisponible");
    if (written?.id !== data.id) throw new Error("Connexion Gmail modifiée : recharger avant de réessayer");
    return refreshed.access_token;
  } finally { if (!inheritedDeadline) deadline.close(); }
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
async function collectInboxMessages(accessToken: string, lastSyncAt: string | null, excludedEmails: Set<string>, excludedDomains: Set<string>): Promise<GmailMessageSummary[]> {
  let query = "is:unread";
  if (lastSyncAt) {
    const millis = new Date(lastSyncAt).getTime();
    if (Number.isFinite(millis)) {
      query = `after:${Math.max(0, Math.floor((millis - SYNC_OVERLAP_MS) / 1000))}`;
    }
  }

  const seen = new Map<string, string>();
  const seenPages = new Set<string>();
  const messages: Array<{ id: string; threadId: string }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < GMAIL_MAX_LIST_PAGES; page++) {
    const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const listResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${GMAIL_LIST_LIMIT}&q=${encodeURIComponent(query)}${pageParam}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(20_000) }
    );
    if (!listResponse.ok) throw new Error(`Gmail list échoué (${listResponse.status})`);
    const list = (await readBoundedGmailJson(listResponse)) as { messages?: Array<{ id?: unknown; threadId?: unknown }>; nextPageToken?: unknown };
    if (!list || typeof list !== "object" || Array.isArray(list)) throw new Error("Réponse Gmail list invalide");
    const rawMessages = list.messages === undefined ? [] : list.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length > GMAIL_LIST_LIMIT) throw new Error("Réponse Gmail list invalide");
    for (const m of rawMessages) {
      assertGmailId(m?.id);
      assertGmailId(m.threadId);
      const previousThread = seen.get(m.id);
      if (previousThread && previousThread !== m.threadId) throw new Error("Fil Gmail incohérent entre les pages");
      if (!previousThread) {
        seen.set(m.id, m.threadId);
        messages.push({ id: m.id, threadId: m.threadId });
      }
    }
    if (list.nextPageToken === undefined || list.nextPageToken === "") break;
    if (typeof list.nextPageToken !== "string" || list.nextPageToken.length > 4096 || seenPages.has(list.nextPageToken)) throw new Error("Pagination Gmail invalide ou répétée : synchronisation non avancée");
    if (page === GMAIL_MAX_LIST_PAGES - 1) throw new Error("Pagination Gmail incomplète après cinq pages : synchronisation non avancée");
    seenPages.add(list.nextPageToken);
    pageToken = list.nextPageToken;
  }

  const hasExclusions = excludedEmails.size > 0 || excludedDomains.size > 0;
  const summaries: GmailMessageSummary[] = [];
  let contextBytes = 0;
  for (const m of messages) {
    const baseUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}`;
    const getMessage = async (query: string) => {
      const response = await fetch(`${baseUrl}?${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` }, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Lecture Gmail indisponible (${response.status})`);
      const detail = await readBoundedGmailJson(response) as { id?: unknown; threadId?: unknown; payload?: unknown; snippet?: unknown };
      if (detail?.id !== m.id || detail.threadId !== m.threadId) throw new Error("Identité du message Gmail incohérente");
      return detail;
    };
    let authorizedSender: string | undefined;
    if (hasExclusions) {
      // The fields projection deliberately excludes the body, subject and snippet.
      const metadata = await getMessage("format=metadata&metadataHeaders=From&fields=id,threadId,payload(headers)");
      try { authorizedSender = singleMailbox(gmailHeader(metadata.payload, "From") ?? ""); }
      catch { continue; } // Ambiguous sender: keep the message private.
      if (excludedEmails.has(authorizedSender) || excludedDomains.has(authorizedSender.split("@")[1])) continue;
    }
    const detail = await getMessage("format=full");
    const from = gmailHeader(detail.payload, "From");
    if (hasExclusions && singleMailbox(from ?? "") !== authorizedSender) throw new Error("Expéditeur Gmail modifié pendant la collecte");
    const content = extractGmailPlainText(detail.payload);
    const summary = {
      id: m.id,
      threadId: m.threadId,
      from: from ?? "inconnu",
      subject: gmailHeader(detail.payload, "Subject") ?? "(sans sujet)",
      snippet: typeof detail.snippet === "string" ? detail.snippet : "",
      replyToMessageId: m.id,
      ...content,
    };
    // Include headers and previews as well as the inline body in the model budget.
    contextBytes += Buffer.byteLength(JSON.stringify(summary), "utf8");
    if (contextBytes > 256 * 1024) throw new Error("Lot Gmail trop volumineux : synchronisation non avancée");
    summaries.push(summary);
  }

  return summaries;
}

async function readInboxConfig(userId: string) {
  const { data, error } = await supabase.from("email_agent_config")
    .select("id,updated_at,is_active,gmail_email,gmail_access_token,last_sync_at,tone,signature,excluded_emails,excluded_domains")
    .eq("user_id", userId).maybeSingle();
  if (error) throw new Error("Configuration Gmail illisible");
  return data;
}

function exclusionSet(value: unknown): Set<string> {
  if (value == null) return new Set(); // Historical nullable columns.
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) throw new Error("Configuration des exclusions Gmail invalide");
  return new Set(value.map((entry: string) => entry.trim().toLowerCase()).filter(Boolean));
}

async function readInbox(userId: string, lastSyncAt?: string | null) {
  let config = await readInboxConfig(userId);
  if (!config?.is_active) return { newEmails: [], reason: "email_agent_config inactif ou absent (Gmail non connecté)" };
  const accessToken = await getGmailAccessToken(userId);
  if (!accessToken) throw new Error("Gmail OAuth absent : collecte impossible, synchronisation non avancée");

  // Refresh may legitimately update this row. Rebind the refreshed token and
  // user policy to the same active account before inspecting any message.
  if (!config.gmail_access_token || decryptGmailToken(config.gmail_access_token) !== accessToken) {
    const fresh = await readInboxConfig(userId);
    if (!fresh?.is_active || fresh.id !== config.id || fresh.gmail_email !== config.gmail_email
      || !fresh.gmail_access_token || decryptGmailToken(fresh.gmail_access_token) !== accessToken) {
      throw new Error("Connexion Gmail modifiée avant la collecte");
    }
    config = fresh;
  }
  if (!config.id || !config.updated_at) throw new Error("Version de la configuration Gmail indisponible");
  const syncStartedAt = new Date().toISOString();
  const newEmails = await collectInboxMessages(accessToken, lastSyncAt === undefined ? config.last_sync_at : lastSyncAt,
    exclusionSet(config.excluded_emails), exclusionSet(config.excluded_domains));

  const configTable = supabase.from("email_agent_config");
  const query = lastSyncAt === undefined
    ? configTable.update({ last_sync_at: syncStartedAt, ...(newEmails.length ? { last_email_id: newEmails[0].id } : {}) }).select("id")
    : configTable.select("id");
  const sameConfig = query.eq("user_id", userId).eq("id", config.id)
    .eq("is_active", true).eq("updated_at", config.updated_at);
  const sameCursor = config.last_sync_at == null
    ? sameConfig.is("last_sync_at", null)
    : sameConfig.eq("last_sync_at", config.last_sync_at);
  const { data: matched, error } = await sameCursor.maybeSingle();
  if (error || matched?.id !== config.id) throw new Error("Configuration ou curseur Gmail modifié : collecte écartée");
  return { tone: config.tone, signature: config.signature, newEmails };
}

/** Explicit list reads enforce the same mailbox policy without advancing the scheduler cursor. */
export async function listNewGmailMessages(userId: string, lastSyncAt: string | null): Promise<GmailMessageSummary[]> {
  return (await readInbox(userId, lastSyncAt)).newEmails;
}

/** Shared by Email and Répondeur Intelligent. Only authorized messages enter the model context. */
export async function buildGmailInboxContext(userId: string): Promise<Record<string, unknown>> {
  return readInbox(userId);
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
    const deadline = createProviderDeadline(GMAIL_ACTION_TIMEOUT_MS, "Délai de l’action Gmail dépassé");
    let postStarted = false;
    try {
      const accessToken = await getGmailAccessToken(ctx.userId, deadline);
      if (!accessToken) throw new Error("Gmail OAuth non complété pour cet utilisateur");
      const reply = await gmailReplyHeaders(params, accessToken, deadline);
      const raw = buildRawEmail(params.to, params.subject, params.body, reply);
      const body = JSON.stringify({ message: { threadId: params.threadId, raw } });
      deadline.check();
      postStarted = true;
      const created = await requestProviderJson("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
        method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body,
      }, deadline, 64 * 1024);
      if (!created || typeof created !== "object" || Array.isArray(created)) throw new Error("Reçu Gmail invalide");
      assertToolResult(created);
      const id = (created as Record<string, unknown>).id;
      assertGmailId(id);
      deadline.check();
      return { draftId: id };
    } catch (error) {
      if (postStarted) throw new Error("Brouillon Gmail non confirmé : vérifier son état avant toute reprise");
      throw error;
    } finally { deadline.close(); }
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
async function gmailReplyHeaders(
  params: GmailReplyInput & { to: string; subject: string }, accessToken: string, deadline: ProviderDeadline,
): Promise<GmailReplyHeaders | undefined> {
  deadline.check();
  assertReplyInput(params);
  if (!params.threadId) return undefined;
  const headersQuery = "format=full";
  const url = params.replyToMessageId
    ? `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(params.replyToMessageId)}?${headersQuery}`
    : `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(params.threadId)}?${headersQuery}`;
  const value = await requestProviderJson(url, { headers: { Authorization: `Bearer ${accessToken}` } }, deadline, 2 * 1024 * 1024) as {
    id?: unknown; threadId?: unknown; payload?: unknown; messages?: Array<{ id?: unknown; threadId?: unknown; payload?: unknown }>;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Parent Gmail invalide");
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

// Explicit phrases are a backstop for the agent's review decision, not a legal classifier.
function needsReviewedGmailDraft(subject: string, body: string): boolean {
  const text = (subject + "\n" + body).normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019\u02bc]/gu, "'").replace(/\s+/gu, " ").toLowerCase();
  const amount = /(?:\p{Sc}|\b(?:eur|usd|gbp|chf))\s*\d|\d\s*(?:\p{Sc}|(?:euros?|dollars?|francs?|eur|usd|gbp|chf)\b)/u.test(text)
    || /\b(?:un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|vingts|cents?|mille|one|two|three|four|five|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|thousand)\s+(?:euros?|dollars?|francs?|pounds?)\b/.test(text);
  const dispute = /\b(?:je conteste|nous contestons|contestation (?:de|du|des)|i dispute|we dispute|i am disputing|we are disputing)\b/.test(text);
  const correction = /\b(?:corriger|rectifier|regulariser|annuler|corrigez|rectifiez|annulez) (?:la|le|les|cette|ce|ces|ma|mon|mes) (?:factur\w*|montant\w*|debit\w*|prelevement\w*|frais|ligne\w*)\b/.test(text)
    || /\b(?:correct|amend|reverse|cancel) (?:my |our |this |these |the )?(?:bill|invoice|charge|amount|line item)s?\b/.test(text);
  const claim = /\b(?:je (?:demande|sollicite|reclame)|j'exige|nous (?:demandons|sollicitons|reclamons|exigeons)|merci de|veuillez)\s+(?:le |un |une |mon |notre |me |nous )?(?:remboursement|rembourser|indemnis[a-z]*)\b/.test(text)
    || /\b(?:remboursez|indemnisez)[ -](?:moi|nous)\b/.test(text)
    || /\b(?:i request|we request|i am requesting|we are requesting|please issue)\s+(?:a |the |full )*(?:refund|compensation|reimbursement)\b/.test(text);
  const accepts = /\b(?:j'accepte|nous acceptons|je valide|nous validons)\s+(?:le |la |l'|votre |cet |cette |vos |les )?(?:accord|proposition|offre|echeancier|transaction|reglement|conditions)\b/.test(text)
    || /\b(?:bon pour accord|(?:i|we) accept (?:the |your |this )?(?:settlement|offer|terms|repayment plan))\b/.test(text);
  const acknowledgesDebt = /\b(?:je reconnais|nous reconnaissons)\s+(?:(?:vous |lui )?devoir|(?:ma|notre|cette|la) dette|etre redevables?)\b/.test(text)
    || /\b(?:i owe you|we owe you|(?:i|we) acknowledge (?:that (?:i|we) owe|(?:the |this |my |our )?debt))\b/.test(text);
  return (amount && (dispute || correction || claim)) || accepts || acknowledgesDebt;
}

export const gmailSendTool: ToolDefinition<{ to: string; subject: string; body: string } & GmailReplyInput, { messageId: string }> = {
  name: "gmail_send",
  description: "Envoie réellement un email ordinaire — action sensible. Pour une réponse, fournir threadId et replyToMessageId du parent, en conservant son sujet et son destinataire. Les échanges avec les partenaires médias et éditoriaux nécessitent le brouillon lié et approuvé du parcours Partenariats puis Emails ; les exclusions de contact restent applicables à tous.",
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
    if (needsReviewedGmailDraft(params.subject, params.body)) {
      throw new Error("Texte engageant : préparer un brouillon à relire et à envoyer personnellement dans Gmail.");
    }
    assertReplyInput(params, ctx.agentType === "email" || ctx.agentType === "repondeur-intelligent");
    const deadline = createProviderDeadline(GMAIL_ACTION_TIMEOUT_MS, "Délai de l’action Gmail dépassé");
    let postStarted = false;
    try {
      const accessToken = await getGmailAccessToken(ctx.userId, deadline);
      if (!accessToken) throw new Error("Gmail OAuth non complété pour cet utilisateur");
      const reply = await gmailReplyHeaders(params, accessToken, deadline);
      await assertDirectGmailSendAllowed(ctx.userId, params, deadline);
      // Keep a possibly consumed reservation after an uncertain result. Refunding
      // or retrying cannot prove that the provider did not accept the message.
      await assertUnderDailySendLimit(ctx.userId, deadline);
      const raw = buildRawEmail(params.to, params.subject, params.body, reply);
      const body = JSON.stringify({ raw, ...(params.threadId ? { threadId: params.threadId } : {}) });
      // Classification may change while reserving the quota. A general KARTA
      // approval cannot authorize a newly discovered partner conversation.
      await assertDirectGmailSendAllowed(ctx.userId, params, deadline);
      deadline.check();
      postStarted = true;
      const sent = await requestProviderJson("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body,
      }, deadline, 64 * 1024);
      if (!sent || typeof sent !== "object" || Array.isArray(sent)) throw new Error("Reçu Gmail invalide");
      assertToolResult(sent);
      const id = (sent as Record<string, unknown>).id;
      assertGmailId(id);
      deadline.check();
      return { messageId: id };
    } catch (error) {
      if (postStarted) throw new Error("Envoi Gmail non confirmé : vérifier son état avant toute reprise");
      throw error;
    } finally { deadline.close(); }
  },
};

async function assertDirectGmailSendAllowed(
  userId: string, params: { to: string } & GmailReplyInput, deadline: ProviderDeadline,
): Promise<void> {
  const { data, error } = await deadline.wait(() => supabase.rpc("partner_direct_send_guard", {
    p_user_id: userId,
    p_recipient: params.to,
    p_parent_gmail_id: params.replyToMessageId ?? null,
    p_gmail_thread_id: params.threadId ?? null,
  }).abortSignal(deadline.signal));
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Vérification du parcours partenaire indisponible : aucun envoi Gmail autorisé");
  }
  if (data.status === "blocked" && data.reason === "partner_reply_preparation_required") {
    throw new Error("Échange partenaire : préparer la réponse depuis Partenariats, puis vérifier et approuver son aperçu exact dans Emails");
  }
  if (data.status === "blocked" && data.reason === "contact_suppressed") {
    throw new Error("Contact exclu ou permission retirée : aucun envoi Gmail autorisé");
  }
  if (data.status !== "allowed" || data.reason !== null) {
    throw new Error("Vérification du parcours partenaire refusée : aucun envoi Gmail autorisé");
  }
}

/** Réservation atomique : deux workers concurrents ne peuvent plus dépasser le plafond. */
async function assertUnderDailySendLimit(userId: string, deadline: ProviderDeadline): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await deadline.wait(() => supabase.rpc("karta_reserve_daily_counter", {
    p_user_id: userId,
    p_counter_key: "gmail_send",
    p_day: today,
    p_limit: DAILY_SEND_LIMIT,
  }).abortSignal(deadline.signal));

  if (error) throw new Error("Réservation du quota Gmail impossible");
  if (typeof data !== "number" || !Number.isSafeInteger(data) || data < 1 || data > DAILY_SEND_LIMIT) {
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
