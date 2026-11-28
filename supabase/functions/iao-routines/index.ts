import { createClient } from "npm:@supabase/supabase-js@2.119.2";
import { rateLimit } from "../_shared/rate-limit.ts";
import { createIaoRoutinesHandler } from "./handler.ts";

Deno.serve(createIaoRoutinesHandler({
  env: name => Deno.env.get(name),
  fetch: (input, init) => fetch(input, init),
  rateLimit,
  authenticate: async (token, signal) => {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !key) throw new Error("Authentication unavailable");
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, {
        ...init, signal, redirect: "error", credentials: "omit", cache: "no-store",
      }) },
    });
    const { data, error } = await client.auth.getUser(token);
    signal.throwIfAborted();
    return error ? null : data.user;
  },
}));
