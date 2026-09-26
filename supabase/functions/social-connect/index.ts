import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  getConnectUrl,
  SUPPORTED_PLATFORMS,
  type Platform,
} from "../_shared/zernio.ts";
import { createSocialCallbackState } from "../_shared/social-state.ts";

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

    // R1 Red Team : `user_id` brut en query string etait recopie tel quel par
    // Zernio dans le callback, sans aucune preuve que la requete de retour venait
    // reellement de la session de cet utilisateur — jeton signe/expirant a la place.
    const stateSecret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!stateSecret) {
      return new Response(JSON.stringify({ error: "Configuration serveur incomplete" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const state = await createSocialCallbackState(user.id, stateSecret);

    // Self-hosted Supabase: edge functions are exposed at SUPABASE_URL/functions/v1/*
    const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
    const callbackUrl =
      `${supabaseUrl}/functions/v1/social-callback` +
      `?platform=${platform}&state=${state}`;

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
