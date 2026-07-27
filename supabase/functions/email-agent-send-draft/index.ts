// Email Agent — Send a previously-drafted reply
// POST { log_id: string }
// 1. Verify user owns the log
// 2. Refresh Gmail token if needed
// 3. Send the Gmail draft via the Gmail API (drafts.send)
// 4. Mark the log as approved + sent
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptGmailToken, encryptGmailToken } from "../_shared/gmail-token-crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const token = authHeader.replace("Bearer ", "");

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      db: { schema: "purama_ai" },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const { log_id } = (await req.json()) as { log_id?: string };
    if (!log_id) return json({ error: "log_id required" }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    // Fetch the log + config
    const { data: log, error: logErr } = await admin
      .from("email_agent_logs")
      .select("*")
      .eq("id", log_id)
      .eq("user_id", userId)
      .single();
    if (logErr || !log) return json({ error: "Log not found" }, 404);

    const { data: cfg, error: cfgErr } = await admin
      .from("email_agent_config")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (cfgErr || !cfg) return json({ error: "Config not found" }, 404);

    // Refresh Gmail access token if expired
    let accessToken = cfg.gmail_access_token
      ? await decryptGmailToken(cfg.gmail_access_token as string)
      : null;
    const expiry = cfg.gmail_token_expiry
      ? new Date(cfg.gmail_token_expiry as string)
      : null;
    if (!accessToken || !expiry || expiry.getTime() < Date.now()) {
      const refresh = cfg.gmail_refresh_token
        ? await decryptGmailToken(cfg.gmail_refresh_token as string)
        : null;
      if (!refresh) return json({ error: "Gmail not connected" }, 400);
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: refresh,
          grant_type: "refresh_token",
        }),
      });
      if (!r.ok) {
        return json({ error: "Token refresh failed" }, 500);
      }
      const t = await r.json() as { access_token: string; expires_in: number };
      accessToken = t.access_token;
      await admin
        .from("email_agent_config")
        .update({
          gmail_access_token: await encryptGmailToken(accessToken),
          gmail_token_expiry: new Date(
            Date.now() + (t.expires_in - 60) * 1000,
          ).toISOString(),
        })
        .eq("user_id", userId);
    }

    // Send the existing draft via drafts.send (preferred), or build a fresh
    // message if no draft id is stored.
    let sendOk = false;
    if (log.gmail_draft_id) {
      const r = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ id: log.gmail_draft_id }),
        },
      );
      sendOk = r.ok;
      if (!sendOk) console.error("[send-draft]", await r.text());
    } else if (log.ai_response && log.from_email) {
      // Build a raw RFC-822 message
      const subject = log.ai_subject || `Re: ${log.subject ?? ""}`;
      const raw = base64UrlEncode(
        `To: ${log.from_email}\r\n` +
          `Subject: ${encodeHeader(subject)}\r\n` +
          `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
          log.ai_response,
      );
      const r = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            raw,
            threadId: log.gmail_thread_id ?? undefined,
          }),
        },
      );
      sendOk = r.ok;
      if (!sendOk) console.error("[send-draft]", await r.text());
    } else {
      return json({ error: "Nothing to send" }, 400);
    }

    if (!sendOk) return json({ error: "Gmail send failed" }, 502);

    await admin
      .from("email_agent_logs")
      .update({
        action_taken: "auto_reply",
        user_approved: true,
        feedback_at: new Date().toISOString(),
      })
      .eq("id", log_id);

    // Bump counters
    await admin.rpc("increment", {
      table_name: "email_agent_config",
      uid: userId,
    }).catch(() => {/* optional rpc, ignore */});

    return json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[email-agent-send-draft]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function base64UrlEncode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeHeader(s: string): string {
  // RFC 2047 encoded-word for non-ASCII subject lines
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(s)))}?=`;
}
