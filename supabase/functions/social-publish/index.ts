import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveSocialSchema } from "../_shared/social-db.ts";
import { corsHeaders, publishPost } from "../_shared/zernio.ts";
import type { SocialDbClient } from "../_shared/social-publish-store.ts";
import { handleSocialPublishRequest } from "./handler.ts";

export { handleSocialPublishRequest } from "./handler.ts";

// Authentication uses the caller's JWT. Writes are server-only after the
// idempotency migration; the handler filters every row by the verified user.
Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    try {
      const url = Deno.env.get("SUPABASE_URL") ?? "";
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      if (!url || !anonKey || !serviceKey) throw new Error("Missing server configuration");
      const schema = resolveSocialSchema(Deno.env.get("SOCIAL_DB_SCHEMA"));
      const authClient = createClient(url, anonKey, {
        global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const db = createClient(url, serviceKey, {
        db: { schema },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      return await handleSocialPublishRequest(req, {
        db: db as unknown as SocialDbClient,
        authenticate: async (token) => {
          const { data, error } = await authClient.auth.getUser(token);
          return error ? null : data.user?.id ?? null;
        },
        publish: publishPost,
      });
    } catch {
      return new Response(JSON.stringify({ error: "Configuration de publication indisponible." }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
});
