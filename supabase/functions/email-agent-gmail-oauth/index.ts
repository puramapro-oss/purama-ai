// Gmail provider redirects have no authority to link an account. The browser
// completes the shared callback with its initiating session and one-use state.
import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import { encryptGmailToken } from "../_shared/gmail-token-crypto.ts";
import { issueOAuthState, consumeOAuthState } from "../_shared/oauth-state.ts";
import { readRequestText, readBoundedBytes } from "../_shared/request-body.ts";
import { createRequestDeadline, cancelResponseQuietly, RequestDeadlineError } from "../_shared/request-deadline.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://purama-ai.purama.dev";
const REDIRECT_URI = SUPABASE_URL.replace(/\/$/, "") + "/functions/v1/email-agent-gmail-oauth";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function returnUrl(result: "connected" | "error"): string {
  const app = new URL(APP_URL);
  if (app.protocol !== "https:" || app.username || app.password || app.search || app.hash || app.pathname !== "/") {
    throw new Error("Invalid application origin");
  }
  return new URL("/dashboard/email-agent?gmail=" + result, app).toString();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const url = new URL(req.url);
  const isCallback = req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"));
  const deadline = createRequestDeadline(15_000, req.signal);
  const endsAt = performance.now() + 15_000;
  const adminClient = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "purama_ai" } });

  async function providerJson(input: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await deadline.fetch(new URL(input), { ...init, redirect: "error" });
    if (!response.ok) {
      cancelResponseQuietly(response.body);
      throw new Error("Provider request failed");
    }
    const bytes = await deadline.wait(() => readBoundedBytes(
      { headers: response.headers, body: response.body, signal: req.signal },
      { maxBytes: 64_000, deadline: endsAt, matchContentLength: !response.headers.get("content-encoding") },
    ));
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    deadline.check();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid provider response");
    return body as Record<string, unknown>;
  }

  try {
    deadline.check();
    const failureUrl = returnUrl("error");
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: "Gmail OAuth unavailable" }, 503);
    }

    if (isCallback) {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") ?? "";
      if (!/^[0-9a-f]{64}$/.test(state) || !code || code.length > 4096 || url.searchParams.has("error")) {
        return redirect(failureUrl);
      }
      // Keep the registered Google redirect_uri, but defer every privileged
      // operation until the initiating browser verifies its stored context.
      const destination = new URL("/oauth/callback", failureUrl);
      destination.searchParams.set("code", code);
      destination.searchParams.set("state", state);
      return redirect(destination.toString());
    }

    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "");
    if (!match) return jsonResponse({ error: "Unauthorized" }, 401);
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { db: { schema: "purama_ai" } });
    const { data: actor, error: authError } = await deadline.wait(() => userClient.auth.getUser(match[1]));
    if (authError || !actor.user) return jsonResponse({ error: "Unauthorized" }, 401);
    const text = await deadline.wait(() => readRequestText(req, { maxBytes: 8192, timeoutMs: 5000 }));
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid shape");
      body = parsed as Record<string, unknown>;
    } catch { return jsonResponse({ error: "Invalid request" }, 400); }

    if (body.action === "callback") {
      const code = body.code;
      const state = body.state;
      if (typeof code !== "string" || !code || code.length > 4096 || typeof state !== "string" || !/^[0-9a-f]{64}$/.test(state)) {
        return jsonResponse({ error: "Invalid callback" }, 400);
      }
      const admin = adminClient();
      const receipt = await deadline.wait(() => consumeOAuthState(admin, {
        state, purpose: "email_agent_gmail", actorId: actor.user.id,
      }));
      if (!receipt) return jsonResponse({ error: "Authorization expired or already used" }, 409);

      const tokens = await providerJson("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
          code, grant_type: "authorization_code", redirect_uri: REDIRECT_URI }),
      });
      if (typeof tokens.access_token !== "string" || !tokens.access_token.trim() || tokens.access_token.length > 16_384 ||
          typeof tokens.expires_in !== "number" || !Number.isSafeInteger(tokens.expires_in) || tokens.expires_in <= 60 || tokens.expires_in > 86_400 ||
          (tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== "string" ||
            !tokens.refresh_token.trim() || tokens.refresh_token.length > 16_384))) {
        throw new Error("Invalid token response");
      }
      const accessToken = tokens.access_token;
      if (tokens.scope !== undefined) {
        if (typeof tokens.scope !== "string" || !tokens.scope.trim()) return jsonResponse({ error: "Incomplete Gmail authorization" }, 403);
        const granted = new Set(tokens.scope.trim().split(/\s+/));
        const canModify = granted.has("https://www.googleapis.com/auth/gmail.modify") || granted.has("https://mail.google.com/");
        const canReadIdentity = granted.has("https://www.googleapis.com/auth/userinfo.email") || granted.has("email");
        // gmail.modify includes sending. Accept the equivalent broader Gmail
        // grant, but never treat read-only mail or identity-only consent as ready.
        if (!canModify || !canReadIdentity) return jsonResponse({ error: "Incomplete Gmail authorization" }, 403);
      }
      const profile = await providerJson("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: "Bearer " + accessToken },
      });
      if (typeof profile.email !== "string" || !profile.email.includes("@") || profile.email.length > 320 || profile.verified_email !== true) {
        throw new Error("Invalid account profile");
      }

      // A refresh token omitted by Google can be retained only for the same
      // verified Google email. Never mix credentials from different accounts.
      let encryptedRefresh: string;
      if (typeof tokens.refresh_token === "string") {
        const refreshToken = tokens.refresh_token;
        encryptedRefresh = await deadline.wait(() => encryptGmailToken(refreshToken));
      } else {
        const existing = await deadline.wait(async () => await admin.from("email_agent_config")
          .select("gmail_refresh_token,gmail_email").eq("user_id", receipt.userId).maybeSingle());
        if (existing.error || typeof existing.data?.gmail_refresh_token !== "string" || !existing.data.gmail_refresh_token ||
            typeof existing.data.gmail_email !== "string" || existing.data.gmail_email.toLowerCase() !== profile.email.toLowerCase()) {
          throw new Error("Refresh authorization required");
        }
        encryptedRefresh = existing.data.gmail_refresh_token;
      }
      const encryptedAccess = await deadline.wait(() => encryptGmailToken(accessToken));
      const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString();
      const reauthorized = await deadline.wait(() => userClient.auth.getUser(match[1]));
      if (reauthorized.error || reauthorized.data.user?.id !== receipt.userId) return jsonResponse({ error: "Unauthorized" }, 401);
      const persisted = await deadline.wait(async () => await admin.from("email_agent_config").upsert({
        user_id: receipt.userId, gmail_email: profile.email,
        gmail_access_token: encryptedAccess, gmail_refresh_token: encryptedRefresh,
        gmail_token_expiry: expiresAt, updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" }).select("user_id").single());
      if (persisted.error || persisted.data?.user_id !== receipt.userId) throw new Error("Connection persistence failed");
      deadline.check();
      return jsonResponse({ success: true, provider: "gmail", returnUrl: receipt.returnPath });
    }

    if (body.action === "start") {
      const issued = await deadline.wait(() => issueOAuthState(adminClient(), {
        userId: actor.user.id, purpose: "email_agent_gmail", provider: "gmail",
      }));
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", SCOPES);
      authUrl.searchParams.set("state", issued.state);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      deadline.check();
      return jsonResponse({ url: authUrl.toString(), state: issued.state, expiresAt: issued.expiresAt });
    }
    return jsonResponse({ error: "Invalid request" }, 400);
  } catch (error) {
    console.error("[email-agent-gmail-oauth] authorization did not complete");
    if (isCallback) {
      try { return redirect(returnUrl("error")); } catch { /* Refuse invalid redirect configuration. */ }
    }
    return jsonResponse({ error: "Gmail authorization did not complete" }, error instanceof RequestDeadlineError ? 504 : 500);
  } finally {
    deadline.close();
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function redirect(to: string) {
  return new Response(null, { status: 302, headers: { ...corsHeaders, Location: to } });
}
