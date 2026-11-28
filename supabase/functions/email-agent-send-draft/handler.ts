// Cross-runtime handler. No network operation is retried after a possible send.
import { readApprovedDraftSnapshot, readApprovedParent, type ApprovedParent } from "./draft-snapshot.ts";
import { hasAsciiControl, hasNulOrNewline } from "./text-guards.ts";
type Row = Record<string, unknown>;
type RpcResult = { data: Row | null; error: unknown };
export type DraftSenderDependencies = {
  authenticate: (token: string) => Promise<string | null>;
  rpc: (name: string, args: Row) => Promise<RpcResult>;
  prepareAccess: (userId: string) => Promise<{
    accessToken: string; gmailEmail: string; connectionUpdatedAt: string;
  }>;
  fetch: typeof fetch;
  newClaimToken?: () => string;
};
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opaqueId = /^[A-Za-z0-9_-]{1,512}$/;
const mailbox = /^[^\s@<>,;:]+@[^\s@<>,;:]+\.[^\s@<>,;:]+$/;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function resultResponse(result: Row): Response {
  if (result.status === "sent" && typeof result.provider_message_id === "string"
    && result.provider_message_id.trim() && typeof result.matches_current_preview === "boolean") {
    return json({ ok: true, status: "sent", action_id: result.action_id,
      provider_message_id: result.provider_message_id, matches_current_preview: result.matches_current_preview }, 200);
  }
  // Existing UI interprets *any* 2xx as "sent". In-progress/unknown MUST be 409.
  return json({ ok: false, error: "Email not confirmed sent", status: result.status ?? "unknown",
    reason: result.reason ?? "dispatch_in_progress", action_id: result.action_id }, 409);
}
function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}
function sendRequest(payload: Row, parent?: ApprovedParent): { url: string; body: Row } {
  if (typeof payload.recipient !== "string" || hasAsciiControl(payload.recipient) || !mailbox.test(payload.recipient)
    || payload.recipient.length > 950
    || typeof payload.subject !== "string" || hasNulOrNewline(payload.subject)
    || payload.subject.length > 998) throw new Error("Invalid approved headers");
  if (payload.gmail_draft_id != null && payload.gmail_draft_id !== "") {
    if (typeof payload.gmail_draft_id !== "string" || !opaqueId.test(payload.gmail_draft_id)) {
      throw new Error("Invalid draft identifier");
    }
    return { url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", body: { id: payload.gmail_draft_id } };
  }
  if (typeof payload.body !== "string" || !payload.body.trim() || payload.body.length > 1_000_000
    || (payload.gmail_thread_id != null && (typeof payload.gmail_thread_id !== "string"
      || !opaqueId.test(payload.gmail_thread_id)))) throw new Error("Invalid approved message");
  const subject = encodeHeader(payload.subject);
  if (subject.length > 970) throw new Error("Approved subject exceeds a single header line");
  const raw = base64UrlEncode(`To: ${payload.recipient}\r\nSubject: ${subject}\r\n`
    + (parent ? `In-Reply-To: ${parent.rfcId}\r\nReferences: ${parent.references.join("\r\n ")}\r\n` : "")
    + `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${payload.body}`);
  return { url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    body: { raw, ...(payload.gmail_thread_id ? { threadId: payload.gmail_thread_id } : {}) } };
}

export function createDraftSender(deps: DraftSenderDependencies): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const auth = req.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
    if (!auth) return json({ error: "Unauthorized" }, 401);
    let userId: string | null;
    try { userId = await deps.authenticate(auth[1]); }
    catch { return json({ error: "Authentication unavailable" }, 503); }
    if (!userId || !uuid.test(userId)) return json({ error: "Unauthorized" }, 401);
    let input: Row;
    try { input = await req.json() as Row; }
    catch { return json({ error: "Invalid JSON" }, 400); }
    if (!input || typeof input.log_id !== "string" || !uuid.test(input.log_id)) {
      return json({ error: "Valid log_id required" }, 400);
    }
    if (typeof input.user_id !== "string" || !uuid.test(input.user_id) || input.user_id !== userId) {
      return json({ error: "The displayed account no longer matches the session" }, 403);
    }
    const action = input.action ?? "send";
    if (!["preview", "approve", "send"].includes(String(action))) return json({ error: "Invalid action" }, 400);
    if (action !== "preview" && (typeof input.approval_id !== "string" || !uuid.test(input.approval_id))) {
      return json({ error: "Versioned preview approval required", reason: "versioned_approval_required" }, 400);
    }
    if (input.feedback != null && (typeof input.feedback !== "string" || input.feedback.length > 4000)) {
      return json({ error: "Invalid feedback" }, 400);
    }
    const claimToken = (deps.newClaimToken ?? (() => crypto.randomUUID()))();
    const common: Row = { p_user_id: userId, p_claim_token: claimToken };
    let reserved: Row;
    const call = async (name: string, args: Row): Promise<Row> => {
      const r = await deps.rpc(name, args);
      if (r.error || !r.data) throw new Error("Durable dispatch unavailable");
      return r.data;
    };
    if (action === "preview" || action === "approve") {
      try {
        const result = await call(action === "preview" ? "email_agent_draft_preview" : "email_agent_draft_approve", {
          p_user_id: userId, p_log_id: input.log_id,
          ...(action === "approve" ? { p_approval_id: input.approval_id, p_feedback: input.feedback ?? null } : {}),
        });
        if (result.status === (action === "preview" ? "ready" : "approved")) {
          return json({ ...result, ok: true }, 200);
        }
        return resultResponse(result);
      } catch { return json({ error: "Versioned approval unavailable", status: "unknown" }, 503); }
    }
    try { reserved = await call("email_agent_send_reserve", {
      ...common, p_log_id: input.log_id, p_approval_id: input.approval_id,
    }); }
    catch { return json({ error: "Durable reservation unavailable", status: "unknown" }, 503); }
    if (reserved.claimed !== true) return resultResponse(reserved);
    if (typeof reserved.action_id !== "string" || !uuid.test(reserved.action_id)
      || !reserved.payload || typeof reserved.payload !== "object") {
      return json({ error: "Invalid durable reservation", status: "unknown" }, 503);
    }
    common.p_action_id = reserved.action_id;
    const finish = (outcome: string, receipt: string | null = null) => call("email_agent_send_finish", {
      ...common, p_outcome: outcome, p_provider_message_id: receipt,
    });
    const uncertain = async (receipt: string | null = null): Promise<Response> => {
      try { return resultResponse(await finish("unknown", receipt)); }
      catch { return json({ ok: false, error: "Provider outcome requires reconciliation", status: "unknown",
        action_id: reserved.action_id }, 409); }
    };
    let outbound: ReturnType<typeof sendRequest>;
    let access: Awaited<ReturnType<DraftSenderDependencies["prepareAccess"]>>;
    let preparationReason = "preparation_failed";
    try {
      const payload = reserved.payload as Row;
      outbound = sendRequest(payload);
      access = await deps.prepareAccess(userId);
      if (!access.accessToken || hasAsciiControl(access.gmailEmail) || !mailbox.test(access.gmailEmail)
        || !Number.isFinite(Date.parse(access.connectionUpdatedAt))
        || payload.gmail_email !== access.gmailEmail) throw new Error("Connection changed");
      const profile = await deps.fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${access.accessToken}` }, signal: AbortSignal.timeout(20_000),
      });
      if (!profile.ok) throw new Error("Gmail identity unavailable");
      const identity = await profile.json() as Row;
      if (typeof identity.emailAddress !== "string"
        || identity.emailAddress.toLowerCase() !== access.gmailEmail.toLowerCase()) {
        throw new Error("Gmail identity mismatch");
      }
      if (payload.gmail_draft_id) {
        preparationReason = "draft_content_unverified";
        const snapshot = await readApprovedDraftSnapshot(deps.fetch, access.accessToken, payload, access.gmailEmail);
        outbound.body = { id: payload.gmail_draft_id, message: snapshot };
      } else {
        preparationReason = "reply_parent_unverified";
        const parent = await readApprovedParent(deps.fetch, access.accessToken, payload);
        outbound = sendRequest(payload, parent);
      }
    } catch {
      try { return resultResponse({ ...await finish("failed"), reason: preparationReason }); }
      catch { return json({ error: "Preparation not confirmed", status: "unknown" }, 503); }
    }
    let begun: Row;
    try {
      begun = await call("email_agent_send_begin", { ...common, p_connection_email: access.gmailEmail,
        p_connection_updated_at: access.connectionUpdatedAt });
    } catch {
      // A lost begin acknowledgement might have committed. Do not call Gmail.
      return json({ error: "Dispatch transition not confirmed", status: "unknown", action_id: reserved.action_id }, 409);
    }
    if (begun.claimed !== true || begun.status !== "sending") return resultResponse(begun);
    let provider: Response;
    try {
      provider = await deps.fetch(outbound.url, {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${access.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(outbound.body), signal: AbortSignal.timeout(20_000),
      });
    } catch { return uncertain(); }
    if (!provider.ok) {
      // Explicit client rejection is a known failure. Neither case is retried;
      // 408/429/5xx can follow a possible acceptance.
      if (provider.status >= 400 && provider.status < 500 && ![408,429].includes(provider.status)) {
        try { return resultResponse(await finish("failed")); } catch { return uncertain(); }
      }
      return uncertain();
    }
    let receipt: string;
    try {
      const body = await provider.json() as Row;
      if (typeof body.id !== "string" || !opaqueId.test(body.id)) return uncertain();
      receipt = body.id;
    } catch { return uncertain(); }
    try {
      const completed = await finish("sent", receipt);
      if (completed.status !== "sent" || completed.provider_message_id !== receipt) return uncertain(receipt);
      return resultResponse(completed);
    } catch { return uncertain(receipt); }
  };
}
