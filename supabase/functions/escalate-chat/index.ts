import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";
import { json } from "../_shared/response.ts";
import { rateLimit } from "../_shared/rate-limit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HISTORY_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

async function readBoundedJson(body: ReadableStream<Uint8Array> | null, signal: AbortSignal, maxBytes: number) {
  if (!body) throw new Error("Missing body");
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new RangeError("Body too large");
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const abort = new AbortController();
  const parentAbort = () => abort.abort(req.signal.reason);
  req.signal.addEventListener("abort", parentAbort, { once: true });
  if (req.signal.aborted) parentAbort();
  const timeout = setTimeout(() => abort.abort(new Error("Support request timed out")), REQUEST_TIMEOUT_MS);
  const scopedFetch: typeof fetch = (input, init) => {
    abort.signal.throwIfAborted();
    return fetch(input, { ...init, signal: abort.signal });
  };

  try {
    abort.signal.throwIfAborted();
    const authorization = req.headers.get("Authorization") ?? "";
    const token = authorization.length <= 8_192 ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] : undefined;
    if (!token) return json({ error: "Connexion requise" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!supabaseUrl || !serviceKey || !resendKey) return json({ error: "Support temporairement indisponible" }, 503);
    const supabase = createClient(supabaseUrl, serviceKey, {
      db: { schema: "purama_ai" },
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: scopedFetch },
    });
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    abort.signal.throwIfAborted();
    const user = authData?.user;
    if (authError || !user || !UUID.test(user.id) || user.is_anonymous) return json({ error: "Connexion requise" }, 401);
    if (typeof user.email !== "string" || user.email.length > 254
      || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(user.email)) {
      return json({ error: "Une adresse email de compte est nécessaire" }, 422);
    }

    let input: unknown;
    try { input = await readBoundedJson(req.body, abort.signal, 1_024); }
    catch (error) {
      abort.signal.throwIfAborted();
      return json({ error: "Requête de support invalide" }, error instanceof RangeError ? 413 : 400);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)
      || !("conversationId" in input) || typeof input.conversationId !== "string"
      || !UUID.test(input.conversationId)) return json({ error: "Conversation invalide" }, 400);
    const conversationId = input.conversationId.toLowerCase();
    // Additional client fields (email, text, history) are deliberately ignored.
    const { data: conversation, error: conversationError } = await supabase
      .from("chat_conversations").select("id, user_id, escalated")
      .eq("id", conversationId).eq("user_id", user.id).maybeSingle();
    abort.signal.throwIfAborted();
    if (conversationError) return json({ error: "Historique temporairement indisponible" }, 503);
    if (!conversation || conversation.id !== conversationId || conversation.user_id !== user.id)
      return json({ error: "Conversation inaccessible" }, 404);
    // This legacy flag is not proof of email delivery. Never return a fabricated
    // success for it, and do not send another email for a marked conversation.
    if (conversation.escalated === true) return json({ error: "Cette conversation est déjà signalée au support" }, 409);
    // Best-effort per-isolate throttling, not a durable cross-process cost ledger.
    if (!rateLimit(`escalate-chat:${user.id}`, 5, 3_600_000).allowed)
      return json({ error: "Trop de demandes de support. Réessayez plus tard." }, 429);

    const { data: history, error: historyError } = await supabase.from("chat_messages")
      .select("id, role, content, created_at").eq("conversation_id", conversationId)
      .in("role", ["user", "assistant"]).order("created_at", { ascending: false })
      .order("id", { ascending: false }).limit(MAX_HISTORY_MESSAGES);
    abort.signal.throwIfAborted();
    if (historyError) return json({ error: "Historique temporairement indisponible" }, 503);
    if (!Array.isArray(history) || history.length === 0 || history.length > MAX_HISTORY_MESSAGES
      || history.some(message => !message || !["user", "assistant"].includes(message.role)
        || typeof message.content !== "string" || !message.content.trim()
        || message.content.length > MAX_MESSAGE_CHARS)) {
      return json({ error: "Aucun historique valide à transmettre" }, 409);
    }
    const lastUserMessage = history.find(message => message.role === "user");
    if (!lastUserMessage) return json({ error: "Aucun message utilisateur enregistré" }, 409);

    const emailBody = `<h2>Demande de support chat — Purama</h2>
      <p><strong>Conversation :</strong> ${escapeHtml(conversationId)}</p>
      <p><strong>Email du compte :</strong> ${escapeHtml(user.email)}</p>
      <p><strong>Dernier message utilisateur :</strong></p>
      <blockquote>${escapeHtml(lastUserMessage.content)}</blockquote>
      <h3>Historique récent (au plus ${MAX_HISTORY_MESSAGES} messages)</h3>
      ${[...history].reverse().map(message => `<p><strong>${message.role === "user" ? "Utilisateur" : "Purama AI"} :</strong> ${escapeHtml(message.content)}</p>`).join("\n")}`;
    // Resend keeps this key for 24 hours; a changed payload returns a conflict.
    // Keep the key stable and never retry automatically or rotate it on errors.
    // https://resend.com/docs/dashboard/emails/idempotency-keys
    const emailResponse = await scopedFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json",
        "Idempotency-Key": `chat-support/v1/${conversationId}` },
      body: JSON.stringify({
        from: "Purama Support <support@purama.app>", to: ["support@purama.app"],
        subject: `[Escalade Chat] Demande de support humain - ${conversationId.slice(0, 8)}`,
        html: emailBody,
      }),
    });
    abort.signal.throwIfAborted();
    if (!emailResponse.ok) {
      await emailResponse.body?.cancel().catch(() => undefined);
      return json({ error: "La transmission au support n'a pas été confirmée" }, 502);
    }
    let receipt: unknown;
    try { receipt = await readBoundedJson(emailResponse.body, abort.signal, 16_384); }
    catch {
      abort.signal.throwIfAborted();
      return json({ error: "La transmission au support n'a pas été confirmée" }, 502);
    }
    if (!receipt || typeof receipt !== "object" || !("id" in receipt)
      || typeof receipt.id !== "string" || !receipt.id.trim() || receipt.id.length > 256)
      return json({ error: "La transmission au support n'a pas été confirmée" }, 502);

    // Mail acceptance and this update are not atomic. A database failure remains
    // an unconfirmed outcome; do not claim success or resend automatically.
    abort.signal.throwIfAborted();
    const { data: updated, error: updateError } = await supabase.from("chat_conversations")
      .update({ escalated: true, status: "escalated" }).eq("id", conversationId)
      .eq("user_id", user.id).select("id").maybeSingle();
    abort.signal.throwIfAborted();
    if (updateError || updated?.id !== conversationId)
      return json({ error: "Le suivi de la transmission n'a pas pu être confirmé" }, 503);
    return json({ success: true, message: "Demande transmise au support" });
  } catch {
    if (abort.signal.aborted) return json({ error: "Demande de support interrompue" }, req.signal.aborted ? 499 : 504);
    return json({ error: "Support temporairement indisponible" }, 503);
  } finally {
    clearTimeout(timeout);
    req.signal.removeEventListener("abort", parentAbort);
  }
});
