import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveSocialSchema } from "../_shared/social-db.ts";
import type { SocialDbClient } from "../_shared/social-publish-store.ts";
import { corsHeaders } from "../_shared/zernio.ts";
import { handleScheduledConsumerRequest } from "./handler.ts";

// Edge Runtime loads this module as its entrypoint. Tests import handler.ts.
Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const db = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      {
        db: { schema: resolveSocialSchema(Deno.env.get("SOCIAL_DB_SCHEMA")) },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    return handleScheduledConsumerRequest(req, db as unknown as SocialDbClient, Deno.env.get("CRON_SECRET"));
  } catch {
    return new Response(JSON.stringify({ error: "Configuration de publication indisponible." }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
