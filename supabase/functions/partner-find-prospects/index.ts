// POST { query, niche?, type? }. Discovery never authorizes outreach.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createPartnerDiscoveryHandler } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
function databaseClients() {
  try {
    const target = new URL(url);
    if (!["https:", "http:"].includes(target.protocol) || target.username || target.password
      || !anonKey.trim() || !serviceKey.trim()) return null;
    return {
      user: createClient(url, anonKey, { db: { schema: "purama_ai" } }),
      admin: createClient(url, serviceKey, { db: { schema: "purama_ai" } }),
    };
  } catch { return null; }
}
const clients = databaseClients();

Deno.serve(createPartnerDiscoveryHandler({
  configured: clients !== null,
  async authenticate(token) {
    if (!clients) return null;
    const { data, error } = await clients.user.auth.getUser(token);
    return error ? null : data.user?.id ?? null;
  },
  async loadConfig(userId) {
    if (!clients) throw new Error("discovery_configuration_unavailable");
    const { data, error } = await clients.admin.from("partner_agent_config")
      .select("target_countries,target_languages").eq("user_id", userId).maybeSingle();
    if (error) throw new Error("discovery_configuration_unavailable");
    return data;
  },
  async importCandidates(userId, prospects) {
    if (!clients) throw new Error("discovery_storage_unavailable");
    const { data, error } = await clients.admin.rpc("partner_discovery_import", {
      p_user_id: userId, p_prospects: prospects,
    });
    if (error) throw Object.assign(new Error("discovery_storage_unavailable"), {
      code: typeof error.code === "string" ? error.code : undefined,
    });
    return data;
  },
  fetch,
  tavilyApiKey: Deno.env.get("TAVILY_API_KEY") ?? "",
  anthropicApiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
  // Preserve an explicit deployment choice; use the active project default.
  anthropicModel: Deno.env.get("ANTHROPIC_MODEL_MAIN") ?? "claude-sonnet-4-6",
}));
