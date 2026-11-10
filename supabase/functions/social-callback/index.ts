import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";
import { createSocialCallbackHandler, socialDatabaseSchema } from "../_shared/social-connection-core.ts";
import { createZernioConnectionProvider } from "../_shared/social-connection-provider.ts";
import { createSocialConnectionStore } from "../_shared/social-connection-store.ts";

serve((request) => {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const stateSecret = Deno.env.get("SOCIAL_STATE_SECRET") ?? serviceKey;
  return createSocialCallbackHandler({
    appUrl: Deno.env.get("APP_URL") ?? "https://purama-ai.purama.dev",
    allowedOrigin: Deno.env.get("CORS_ALLOWED_ORIGIN"),
    callbackBaseUrl: supabaseUrl + "/functions/v1/social-callback",
    stateSecret,
    getUserId: () => Promise.resolve(null),
    getDependencies() {
      // The signed intent is checked before a privileged database client exists.
      const admin = createClient(supabaseUrl, serviceKey, {
        db: { schema: socialDatabaseSchema(Deno.env.get("SOCIAL_DB_SCHEMA")) },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      return {
        store: createSocialConnectionStore(admin), stateSecret,
        provider: createZernioConnectionProvider({ apiKey: Deno.env.get("ZERNIO_API_KEY") ?? "" }),
      };
    },
  })(request);
});
