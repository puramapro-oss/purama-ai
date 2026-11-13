import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import { rateLimit } from "../_shared/rate-limit.ts";
import { createIaoConsultationHandler } from "./handler.ts";

Deno.serve(createIaoConsultationHandler({
  env: name => Deno.env.get(name),
  fetch: (input, init) => fetch(input, init),
  rateLimit,
  authenticate: async (token, signal) => {
    const url = Deno.env.get("SUPABASE_URL"); const key = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !key) throw new Error("Authentication unavailable");
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal }) },
    });
    const { data, error } = await client.auth.getUser(token);
    signal.throwIfAborted();
    return error ? null : data.user;
  },
}));
