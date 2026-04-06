import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, deleteProfile } from "../_shared/zernio.ts";

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
        .from("social_accounts")
        .select("*")
        .eq("user_id", user.id)
        .order("connected_at", { ascending: false });

      if (error) throw error;
      return new Response(JSON.stringify(data ?? []), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (req.method === "DELETE") {
      const url = new URL(req.url);
      const platform = url.searchParams.get("platform");
      if (!platform) {
        return new Response(
          JSON.stringify({ error: "platform required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // Find the account first to grab the zernio profile id
      const { data: account } = await supabase
        .from("social_accounts")
        .select("*")
        .eq("user_id", user.id)
        .eq("platform", platform)
        .maybeSingle();

      if (account?.zernio_profile_id) {
        try {
          await deleteProfile(account.zernio_profile_id);
        } catch (e) {
          console.warn("[social-accounts] zernio delete failed:", e);
        }
      }

      const { error: delError } = await supabase
        .from("social_accounts")
        .delete()
        .eq("user_id", user.id)
        .eq("platform", platform);
      if (delError) throw delError;

      return new Response(JSON.stringify({ success: true }), {
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
    console.error("[social-accounts]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
