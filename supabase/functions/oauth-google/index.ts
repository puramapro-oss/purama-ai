import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set(["https://purama-ai.purama.dev", "https://purama.dev", ...(Deno.env.get("OAUTH_ALLOWED_ORIGINS") ?? "").split(",").map((v) => v.trim()).filter(Boolean)]);
const PROVIDERS = {
  google_sheets: ["https://www.googleapis.com/auth/spreadsheets"], gmail: ["https://www.googleapis.com/auth/gmail.modify"],
  google_calendar: ["https://www.googleapis.com/auth/calendar"], google_drive: ["https://www.googleapis.com/auth/drive.file"],
} as const;
type Provider = keyof typeof PROVIDERS;
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID"), CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET"), STATE_SECRET = Deno.env.get("GOOGLE_OAUTH_STATE_SECRET");
const REDIRECT_URI = "https://purama-ai.purama.dev/oauth/callback", encoder = new TextEncoder();

function cors(req: Request) { const origin = req.headers.get("origin") ?? ""; return { "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://purama-ai.purama.dev", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", Vary: "Origin" }; }
function json(req: Request, body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
function b64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function unb64(value: string) { const n = value.replaceAll("-", "+").replaceAll("_", "/"); return Uint8Array.from(atob(n.padEnd(Math.ceil(n.length / 4) * 4, "=")), (c) => c.charCodeAt(0)); }
async function hmac(value: string) { if (!STATE_SECRET || STATE_SECRET.length < 32) throw new Error("OAuth state signing is not configured"); const key = await crypto.subtle.importKey("raw", encoder.encode(STATE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))); }
async function signState(payload: Record<string, unknown>) { const encoded = b64(encoder.encode(JSON.stringify(payload))); return `${encoded}.${await hmac(encoded)}`; }
async function verifyState(state: string) { const [payload, signature, extra] = state.split("."); if (!payload || !signature || extra || signature !== await hmac(payload)) throw new Error("Invalid OAuth state"); return JSON.parse(new TextDecoder().decode(unb64(payload))) as { userId: string; provider: Provider; returnUrl: string; nonce: string; exp: number; codeChallenge: string }; }
function validProvider(v: string | null): v is Provider { return !!v && Object.hasOwn(PROVIDERS, v); }
function validReturnUrl(v: string | null) { return v?.startsWith("/") && !v.startsWith("//") ? v : "/mes-connexions"; }
function admin() { const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); if (!url || !key) throw new Error("Supabase service is not configured"); return createClient(url, key, { auth: { persistSession: false } }); }
async function authUser(req: Request) { const match = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i); if (!match) return null; const { data, error } = await admin().auth.getUser(match[1]); return error ? null : data.user; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  try {
    const action = new URL(req.url).searchParams.get("action"), user = await authUser(req);
    if (!user) return json(req, { error: "Unauthorized" }, 401);
    if (!CLIENT_ID || !CLIENT_SECRET || !STATE_SECRET) return json(req, { error: "Google OAuth not configured" }, 503);
    const db = admin();
    if (action === "authorize") {
      if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
      const body = await req.json().catch(() => ({})), provider = typeof body.provider === "string" ? body.provider : null, challenge = typeof body.codeChallenge === "string" ? body.codeChallenge : "";
      if (!validProvider(provider) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return json(req, { error: "Invalid OAuth request" }, 400);
      const nonce = crypto.randomUUID(), now = Math.floor(Date.now() / 1000), returnUrl = validReturnUrl(typeof body.returnUrl === "string" ? body.returnUrl : null);
      const { error } = await db.schema("purama_ai").from("oauth_state_nonces").insert({ nonce, user_id: user.id, expires_at: new Date((now + 600) * 1000).toISOString() });
      if (error) throw new Error("Unable to persist OAuth state");
      const state = await signState({ userId: user.id, provider, returnUrl, nonce, exp: now + 600, codeChallenge: challenge });
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      for (const [key, value] of Object.entries({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: PROVIDERS[provider].join(" "), state, access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256" })) authUrl.searchParams.set(key, value);
      return json(req, { authUrl: authUrl.toString(), state });
    }
    if (action === "callback") {
      if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
      const body = await req.json().catch(() => ({}));
      if (typeof body.code !== "string" || typeof body.state !== "string" || typeof body.codeVerifier !== "string") return json(req, { error: "Missing OAuth callback parameters" }, 400);
      const state = await verifyState(body.state), challenge = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body.codeVerifier))));
      if (state.exp < Math.floor(Date.now() / 1000) || state.userId !== user.id || challenge !== state.codeChallenge || !validProvider(state.provider)) return json(req, { error: "Invalid or expired OAuth state" }, 400);
      const { data: consumed, error: consumeError } = await db.schema("purama_ai").from("oauth_state_nonces").delete().eq("nonce", state.nonce).eq("user_id", user.id).gt("expires_at", new Date().toISOString()).select("nonce").maybeSingle();
      if (consumeError || !consumed) return json(req, { error: "OAuth state already used or expired" }, 400);
      const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: body.code, code_verifier: body.codeVerifier, grant_type: "authorization_code", redirect_uri: REDIRECT_URI }) });
      if (!tr.ok) return json(req, { error: "Failed to exchange authorization code" }, 400);
      const tokens = await tr.json(); if (typeof tokens.access_token !== "string") return json(req, { error: "Invalid token response" }, 502);
      const row: Record<string, unknown> = { user_id: user.id, provider: state.provider, access_token: tokens.access_token, token_expires_at: new Date(Date.now() + Number(tokens.expires_in ?? 3600) * 1000).toISOString() };
      if (typeof tokens.refresh_token === "string") row.refresh_token = tokens.refresh_token;
      const { error } = await db.from("user_connections").upsert(row, { onConflict: "user_id,provider" }); if (error) throw new Error("Failed to store tokens");
      return json(req, { success: true, provider: state.provider, returnUrl: state.returnUrl });
    }
    if (action === "refresh") {
      if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
      const body = await req.json().catch(() => ({})), provider = typeof body.provider === "string" ? body.provider : null; if (!validProvider(provider)) return json(req, { error: "Invalid provider" }, 400);
      const { data: connection, error } = await db.from("user_connections").select("refresh_token").eq("user_id", user.id).eq("provider", provider).maybeSingle(); if (error || !connection?.refresh_token) return json(req, { error: "No refresh token available" }, 400);
      const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: connection.refresh_token, grant_type: "refresh_token" }) }); if (!tr.ok) return json(req, { error: "Failed to refresh token" }, 400);
      const tokens = await tr.json(); if (typeof tokens.access_token !== "string") return json(req, { error: "Invalid token response" }, 502);
      const { error: updateError } = await db.from("user_connections").update({ access_token: tokens.access_token, token_expires_at: new Date(Date.now() + Number(tokens.expires_in ?? 3600) * 1000).toISOString() }).eq("user_id", user.id).eq("provider", provider); if (updateError) throw new Error("Failed to update token");
      return json(req, { success: true });
    }
    return json(req, { error: "Invalid action" }, 400);
  } catch (error) { console.error("OAuth error", error instanceof Error ? error.message : "unknown"); return json(req, { error: "OAuth request failed" }, 500); }
});
