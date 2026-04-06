// Compta Agent — Bridge API (DSP2 bank aggregator) connection
// POST { action: 'start' } → returns Bridge Connect URL (or 503 if not configured)
// GET ?bridge_user_uuid=...&user_id=... → callback after Bridge Connect flow
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BRIDGE_CLIENT_ID = Deno.env.get("BRIDGE_CLIENT_ID") ?? "";
const BRIDGE_CLIENT_SECRET = Deno.env.get("BRIDGE_CLIENT_SECRET") ?? "";
const BRIDGE_API = "https://api.bridgeapi.io/v3";
const BRIDGE_VERSION = "2025-01-15";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://purama-ai.purama.dev";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);

    // ===== CALLBACK =====
    if (req.method === "GET" && url.searchParams.has("user_id")) {
      const userId = url.searchParams.get("user_id")!;
      const bridgeUuid = url.searchParams.get("bridge_user_uuid") ?? "";
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        db: { schema: "purama_ai" },
      });
      await admin
        .from("compta_agent_config")
        .update({
          bridge_user_uuid: bridgeUuid,
          bridge_last_sync_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
      return redirect(`${APP_URL}/dashboard/compta-agent?bridge=connected`);
    }

    // ===== START =====
    if (req.method === "POST") {
      if (!BRIDGE_CLIENT_ID || !BRIDGE_CLIENT_SECRET) {
        return json(
          {
            error: "Bridge API credentials not configured on the server. Add BRIDGE_CLIENT_ID and BRIDGE_CLIENT_SECRET to the edge function env.",
          },
          503,
        );
      }
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return json({ error: "Unauthorized" }, 401);
      const token = authHeader.replace("Bearer ", "");

      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        db: { schema: "purama_ai" },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser(
        token,
      );
      if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
      const userId = userData.user.id;

      // 1. Create or fetch a Bridge user
      const userRes = await fetch(`${BRIDGE_API}/aggregation/users`, {
        method: "POST",
        headers: {
          "Client-Id": BRIDGE_CLIENT_ID,
          "Client-Secret": BRIDGE_CLIENT_SECRET,
          "Bridge-Version": BRIDGE_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ external_user_id: userId }),
      });
      if (!userRes.ok && userRes.status !== 409) {
        const t = await userRes.text();
        console.error("[bridge] user create failed", t);
        return json({ error: "Bridge user creation failed", details: t }, 502);
      }
      const userJson = userRes.ok ? await userRes.json() : null;
      const bridgeUuid = userJson?.uuid;

      // 2. Authenticate that user
      const authRes = await fetch(
        `${BRIDGE_API}/aggregation/authorization/token`,
        {
          method: "POST",
          headers: {
            "Client-Id": BRIDGE_CLIENT_ID,
            "Client-Secret": BRIDGE_CLIENT_SECRET,
            "Bridge-Version": BRIDGE_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ user_uuid: bridgeUuid, external_user_id: userId }),
        },
      );
      if (!authRes.ok) {
        return json({ error: "Bridge auth failed" }, 502);
      }
      const authJson = await authRes.json() as { access_token: string };

      // 3. Create a connect session
      const sessionRes = await fetch(`${BRIDGE_API}/aggregation/connect-sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authJson.access_token}`,
          "Client-Id": BRIDGE_CLIENT_ID,
          "Client-Secret": BRIDGE_CLIENT_SECRET,
          "Bridge-Version": BRIDGE_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_email: userData.user.email,
          callback_url: `${SUPABASE_URL}/functions/v1/compta-bridge-connect?user_id=${userId}&bridge_user_uuid=${bridgeUuid}`,
        }),
      });
      if (!sessionRes.ok) {
        const t = await sessionRes.text();
        return json({ error: "Bridge session failed", details: t }, 502);
      }
      const session = await sessionRes.json() as { url: string };

      // Persist the bridge UUID immediately
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        db: { schema: "purama_ai" },
      });
      await admin
        .from("compta_agent_config")
        .update({ bridge_user_uuid: bridgeUuid })
        .eq("user_id", userId);

      return json({ url: session.url });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[compta-bridge-connect]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
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
