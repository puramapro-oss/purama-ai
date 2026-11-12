// GET/POST /functions/v1/entraide-missions : authentification JWT et RPC atomique.
// Aucune clé service_role, aucune écriture directe ni copie de la bibliothèque privée.
import { createClient } from "npm:@supabase/supabase-js@2.91.0";
import { createMissionsHandler } from "./handler.ts";

Deno.serve(createMissionsHandler({
  createBackend(authorization) {
    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !anonKey) throw new Error("missing_supabase_configuration");
    const client = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: "purama_ai" },
    });
    return {
      async getUserId() {
        const { data, error } = await client.auth.getUser();
        return error ? null : data.user?.id ?? null;
      },
      async listMissions() {
        return await client.from("missions_collectives")
          .select("*, missions_collectives_participants(user_id, joined_at)")
          .order("created_at", { ascending: false });
      },
      async mutateMission(command) {
        return await client.rpc("entraide_mission_mutate", command);
      },
    };
  },
}));
