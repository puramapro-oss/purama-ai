// POST { query, niche?, type? }. Discovery never authorizes outreach.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createPartnerDiscoveryHandler } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
  db: { schema: "purama_ai" },
});
const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  db: { schema: "purama_ai" },
});

Deno.serve(createPartnerDiscoveryHandler({
  async authenticate(token) {
    const { data, error } = await userClient.auth.getUser(token);
    return error ? null : data.user?.id ?? null;
  },
  async loadConfig(userId) {
    const { data, error } = await admin.from("partner_agent_config")
      .select("target_countries,target_languages").eq("user_id", userId).maybeSingle();
    if (error) throw new Error("discovery_configuration_unavailable");
    return data;
  },
  async importCandidates(userId, prospects) {
    const { data, error } = await admin.rpc("partner_discovery_import", {
      p_user_id: userId, p_prospects: prospects,
    });
    if (error) throw new Error("discovery_storage_unavailable");
    return data;
  },
  fetch,
  tavilyApiKey: Deno.env.get("TAVILY_API_KEY") ?? "",
  anthropicApiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
  anthropicModel: Deno.env.get("ANTHROPIC_MODEL_MAIN") ?? "claude-sonnet-4-20250514",
}));
