import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/zernio.ts";

interface ConfigBody {
  autopilot_enabled?: boolean;
  auto_caption?: boolean;
  auto_hashtags?: boolean;
  default_platforms?: string[];
  timezone?: string;
}

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
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
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

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("social_autopilot_config")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;

      // Return defaults if missing
      const result = data ?? {
        user_id: user.id,
        autopilot_enabled: false,
        auto_caption: true,
        auto_hashtags: true,
        default_platforms: [
          "youtube",
          "tiktok",
          "instagram",
          "facebook",
          "threads",
          "linkedin",
          "twitter",
        ],
        timezone: "Europe/Paris",
      };

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST" || req.method === "PUT") {
      const body = (await req.json()) as ConfigBody;
      const { data, error } = await supabase
        .from("social_autopilot_config")
        .upsert(
          {
            user_id: user.id,
            ...body,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        )
        .select()
        .single();
      if (error) throw error;

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[social-autopilot-config]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
