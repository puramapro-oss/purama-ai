import { supabase } from "../db/supabase.js";
import type { GmailInboxBinding, GmailInboxCycle } from "../engine/types.js";
import { bounded } from "../runtime/lifecycle.js";
import {
  assertGmailInboxPolicy, getGmailInboxConnection, gmailInboxPage, GmailInboxPageExpired, readGmailInboxMessage, singleMailbox,
} from "./gmail.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
type InboxRole = "email" | "repondeur-intelligent";
type Connection = NonNullable<Awaited<ReturnType<typeof getGmailInboxConnection>>>;

async function request(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await bounded(async signal => supabase.rpc(name, params).abortSignal(signal), 8_000);
  if (error || !data || typeof data !== "object" || Array.isArray(data) || typeof data.status !== "string") {
    throw new Error("État du traitement Gmail non confirmé");
  }
  return data;
}

function readBinding(row: Record<string, unknown>): GmailInboxBinding {
  if (typeof row.mailbox !== "string" || row.mailbox !== singleMailbox(row.mailbox)
    || typeof row.policy_version !== "string" || !UUID.test(row.policy_version)
    || typeof row.message_id !== "string" || !ID.test(row.message_id)
    || typeof row.thread_id !== "string" || !ID.test(row.thread_id)) throw new Error("Liaison Gmail invalide");
  return { mailbox: row.mailbox, policyVersion: row.policy_version, messageId: row.message_id, threadId: row.thread_id };
}

export async function getApprovedGmailInboxBinding(userId: string, runId: string, approvalId: string): Promise<GmailInboxBinding | undefined> {
  const result = await request("gmail_inbox_approval_binding", { p_user_id: userId, p_run_id: runId, p_approval_id: approvalId });
  if (result.status === "legacy") return undefined;
  if (result.status !== "bound") throw new Error("Autorisation du courrier expirée ou modifiée");
  return readBinding(result);
}

const emptyCycle: GmailInboxCycle = {
  hasMessage: false, context: Object.freeze({ newEmails: Object.freeze([]) }),
  isCandidate: () => false, beforeInference: async () => {},
  beforeEffect: async () => { throw new Error("Aucun courrier autorisé"); }, finish: async () => {},
};

async function capturePage(userId: string, conn: Connection) {
  const started = conn.scanStartedAt ?? new Date().toISOString();
  let page;
  let restart = false;
  try { page = await gmailInboxPage(conn.accessToken, conn.lastSyncAt, conn.pageToken, started); }
  catch (error) {
    if (!(error instanceof GmailInboxPageExpired) || !conn.pageToken) throw error;
    restart = true;
    page = { messages: [], next: null };
  }
  // Only opaque provider IDs are durable. Message text and headers are read on
  // demand after a claim under the currently active mailbox policy.
  const capture = await request("gmail_inbox_capture", { p_user_id: userId, p_config_id: conn.id,
    p_config_updated_at: conn.updatedAt, p_previous_cursor: conn.lastSyncAt, p_sync_started_at: started,
    p_messages: page.messages, p_previous_page_token: conn.pageToken, p_next_page_token: page.next, p_restart_scan: restart });
  if (!["captured", "stale", "restarted"].includes(String(capture.status))) throw new Error("Page Gmail non confirmée");
  return !restart && capture.status === "captured";
}

export async function prepareGmailInboxCycle(userId: string, role: InboxRole, runId: string, mode: "live" | "simulation"): Promise<GmailInboxCycle> {
  if (mode === "simulation") return emptyCycle;
  if (!UUID.test(userId) || !UUID.test(runId) || (role !== "email" && role !== "repondeur-intelligent")) throw new Error("Identité du cycle Gmail invalide");
  const conn = await getGmailInboxConnection(userId);
  if (!conn) return emptyCycle;
  if (!UUID.test(conn.policyVersion) || !UUID.test(conn.id)) throw new Error("Version de la politique Gmail indisponible");
  const claim = () => request("gmail_inbox_claim", {
    p_user_id: userId, p_config_id: conn.id, p_run_id: runId, p_agent_type: role, p_policy_version: conn.policyVersion,
  });
  // Drain accepted items before asking Gmail to rediscover overlapping pages.
  let row = await claim();
  if (row.status === "empty" && await capturePage(userId, conn)) row = await claim();
  if (row.status === "empty" || row.status === "blocked") return emptyCycle;
  if (row.status !== "claimed" || typeof row.item_id !== "string" || !UUID.test(row.item_id)) throw new Error("Réservation Gmail non confirmée");
  const item = { p_user_id: userId, p_run_id: runId, p_item_id: row.item_id };
  const finishItem = async (outcome: string, reference?: string) => {
    const reply = await request("gmail_inbox_finish", { ...item, p_outcome: outcome, p_reference: reference ?? null });
    const expected: Record<string, string[]> = { ignored: ["ignored"], complete: ["done", "review"], retry: ["ready", "review"], unknown: ["review"] };
    if (!expected[outcome]?.includes(String(reply.status))) throw new Error("Clôture du courrier non confirmée");
  };
  let message;
  let binding;
  try {
    binding = readBinding(row);
    if (binding.mailbox !== conn.mailbox.toLowerCase() || binding.policyVersion !== conn.policyVersion) throw new Error("Réservation liée à une autre boîte");
    message = await readGmailInboxMessage(conn, { id: binding.messageId, threadId: binding.threadId });
    if (message) await assertGmailInboxPolicy(userId, conn.mailbox, conn.policyVersion);
  } catch (error) {
    await finishItem("retry");
    throw error;
  }
  if (!message) {
    await finishItem("ignored");
    return emptyCycle;
  }
  const source = message;
  const anchor = binding;
  const isCandidate = (tool: string, params: Record<string, unknown>): boolean => {
    if (tool === "send_notification") {
      return typeof params.title === "string" && params.title.trim().length > 0 && typeof params.body === "string" && params.body.trim().length > 0
        && Object.keys(params).every(key => ["title", "body", "priority"].includes(key));
    }
    if (tool !== "gmail_create_draft" && tool !== "gmail_send") return false;
    try {
      return source.bodyStatus === "complete" && params.replyToMessageId === anchor.messageId && params.threadId === anchor.threadId
        && params.subject === source.subject && typeof params.to === "string" && params.to.toLowerCase() === singleMailbox(source.from);
    } catch { return false; }
  };
  let armed = false;
  return {
    hasMessage: true, binding: anchor, context: { newEmails: [source], tone: conn.tone, signature: conn.signature },
    isCandidate, beforeInference: () => assertGmailInboxPolicy(userId, conn.mailbox, conn.policyVersion),
    async beforeEffect(tool, params, _kind, followups: string[] = []) {
      if (armed) throw new Error("Ce courrier a déjà une action réservée");
      if (!isCandidate(tool, params)) throw new Error("Action différente du message Gmail autorisé");
      const remaining = [...new Set(followups)];
      if (remaining.some(name => !["gmail_send", "gmail_create_draft", "send_notification"].includes(name))) {
        throw new Error("Suite de traitement Gmail inconnue");
      }
      const outcome = await request("gmail_inbox_begin", { ...item, p_policy_version: anchor.policyVersion, p_followup_tools: remaining });
      if (outcome.status !== "armed") throw new Error("Action Gmail déjà engagée ou autorisation expirée");
      armed = true;
    },
    finish: async (state, receipt) => {
      if (state === "done" && armed && !receipt) throw new Error("Référence de l’action Gmail absente");
      await finishItem(state === "done" ? (armed ? "complete" : "ignored") : state === "review" ? "unknown" : "retry", receipt);
    },
  };
}
