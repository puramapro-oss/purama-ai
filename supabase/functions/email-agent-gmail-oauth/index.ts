// Email Agent — Gmail OAuth flow
// Handles two actions:
//   - { action: 'start' } (POST, authenticated) → returns authorize URL
//   - GET ?code=...&state=... → callback, exchanges code, stores tokens, redirects
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const APP_URL = Deno.env.get("APP_URL") ?? "https://purama-ai.purama.dev";
const REDIRECT_URI = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/email-agent-gmail-oauth`;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);

  try {
    // ============== CALLBACK (Google → here, GET) ==============
    if (req.method === "GET" && url.searchParams.has("code")) {
      const code = url.searchParams.get("code")!;
      const state = url.searchParams.get("state") ?? "";
      // state encodes the user_id
      const userId = state;
      if (!userId) {
        return redirect(`${APP_URL}/dashboard/email-agent?gmail=error`);
      }

      // Exchange code → tokens
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          code,
          grant_type: "authorization_code",
          redirect_uri: REDIRECT_URI,
        }),
      });
      if (!tokenRes.ok) {
        console.error("[email-agent-gmail-oauth] token exchange failed", await tokenRes.text());
        return redirect(`${APP_URL}/dashboard/email-agent?gmail=error`);
      }
      const tokens = await tokenRes.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        scope: string;
        token_type: string;
      };

      // Fetch the user's email address
      const profileRes = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      );
      const profile = await profileRes.json() as { email?: string };

      // Persist via service-role client (no user JWT in callback)
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        db: { schema: "purama_ai" },
      });

      const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000)
        .toISOString();

      await admin.from("email_agent_config").upsert(
        {
          user_id: userId,
          gmail_email: profile.email ?? null,
          gmail_access_token: tokens.access_token,
          gmail_refresh_token: tokens.refresh_token ?? null,
          gmail_token_expiry: expiresAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

      return redirect(`${APP_URL}/dashboard/email-agent?gmail=connected`);
    }

    // ============== START (POST, authenticated) ==============
    if (req.method === "POST") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      const token = authHeader.replace("Bearer ", "");
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        db: { schema: "purama_ai" },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser(
        token,
      );
      if (userErr || !userData?.user) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      const userId = userData.user.id;

      const authUrl = new URL(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", SCOPES);
      authUrl.searchParams.set("state", userId);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");

      return jsonResponse({ url: authUrl.toString() });
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[email-agent-gmail-oauth]", msg);
    return jsonResponse({ error: msg }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function redirect(to: string) {
  return new Response(null, {
    status: 302,
    headers: { ...corsHeaders, Location: to },
  });
}
