import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  getConnectUrl,
  SUPPORTED_PLATFORMS,
  type Platform,
} from "../_shared/zernio.ts";
import { getSocialCallbackGate } from "../_shared/social-callback-gate.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { db: { schema: 'purama_ai' } }
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = userData.user;

    const { platform } = (await req.json()) as { platform: Platform };
    if (!platform || !SUPPORTED_PLATFORMS.includes(platform)) {
      return new Response(
        JSON.stringify({ error: "Unsupported platform" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const callbackGate = getSocialCallbackGate(
      Deno.env.get("SOCIAL_CALLBACK_ENABLED"),
      Deno.env.get("SOCIAL_CALLBACK_SHARED_SECRET"),
    );
    if (!callbackGate.enabled) {
      console.error(`[social-connect] callback gate closed: ${callbackGate.reason}`);
      return new Response(
        JSON.stringify({ error: "Social account connection is temporarily unavailable" }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Self-hosted Supabase: edge functions are exposed at SUPABASE_URL/functions/v1/*
    const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
    const callbackUrl =
      `${supabaseUrl}/functions/v1/social-callback` +
      `?platform=${platform}&user_id=${user.id}` +
      `&callback_secret=${encodeURIComponent(callbackGate.secret)}`;

    const result = await getConnectUrl(platform, callbackUrl);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[social-connect]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
