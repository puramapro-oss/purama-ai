import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptGmailToken } from "../_shared/gmail-token-crypto.ts";
import { createDraftSender } from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const boundedFetch: typeof fetch = (input, init) => fetch(input, {
  ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
});
const options = { db: { schema: "purama_ai" }, global: { fetch: boundedFetch },
  auth: { persistSession: false, autoRefreshToken: false } };
const authClient = createClient(supabaseUrl, anonKey, options);
const admin = createClient(supabaseUrl, serviceKey, options);

Deno.serve(createDraftSender({
  authenticate: async (token) => {
    const { data, error } = await authClient.auth.getUser(token);
    return error ? null : data.user?.id ?? null;
  },
  rpc: async (name, args) => {
    const { data, error } = await admin.rpc(name, args);
    return { data, error };
  },
  prepareAccess: async (userId) => {
    const { data: cfg, error } = await admin.from("email_agent_config")
      .select("gmail_email,gmail_access_token,gmail_refresh_token,gmail_token_expiry,updated_at")
      .eq("user_id", userId).single();
    if (error || !cfg?.gmail_email || !cfg.updated_at) throw new Error("Gmail connection unavailable");
    let accessToken = cfg.gmail_access_token ? await decryptGmailToken(cfg.gmail_access_token) : null;
    const expiry = cfg.gmail_token_expiry ? Date.parse(cfg.gmail_token_expiry) : NaN;
    if (!accessToken || !Number.isFinite(expiry) || expiry <= Date.now() + 60_000) {
      if (!cfg.gmail_refresh_token || !googleClientId || !googleClientSecret) throw new Error("Gmail refresh unavailable");
      const refreshToken = await decryptGmailToken(cfg.gmail_refresh_token);
      const response = await boundedFetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: googleClientId, client_secret: googleClientSecret,
          refresh_token: refreshToken, grant_type: "refresh_token" }),
      });
      if (!response.ok) throw new Error("Gmail refresh failed");
      const refreshed = await response.json();
      if (typeof refreshed.access_token !== "string" || !refreshed.access_token) throw new Error("Invalid Gmail access token");
      accessToken = refreshed.access_token;
      // Ephemeral use avoids restoring stale credentials after a reconnect.
      // The begin RPC rechecks the original config version before any send.
    }
    return { accessToken: accessToken!, gmailEmail: cfg.gmail_email, connectionUpdatedAt: cfg.updated_at };
  },
  fetch: boundedFetch,
}));
