import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";
import { rateLimit } from "../_shared/rate-limit.ts";
import { createFounderDashboardHandler } from "./handler.ts";
import { createDashboardReader, type FounderDatabase } from "./reader.ts";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error("Service configuration unavailable");
  return value;
}

serve(createFounderDashboardHandler({
  founderUserId: Deno.env.get("PURAMA_FOUNDER_USER_ID"),
  allowedOrigin: Deno.env.get("PURAMA_FOUNDER_ALLOWED_ORIGIN"),
  authenticate: async (token, signal) => {
    const client = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
      // The handler owns this signal until getUser and its response body have completed.
      global: { fetch: (input, init) => fetch(input, { ...init, signal }) },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error) {
      if (error.status === 401 || error.status === 403) return null;
      throw new Error("Authentication provider unavailable");
    }
    return data.user;
  },
  createReader: () => {
    // This factory runs only after verified owner identity and the rate-limit gate.
    const client = createClient<FounderDatabase, "purama_ai">(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
      db: { schema: "purama_ai" },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return createDashboardReader(client);
  },
  rateLimit,
}));
