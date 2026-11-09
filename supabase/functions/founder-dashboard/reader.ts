import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.91.0";
import type { DashboardReader } from "./handler.ts";

type ReadTable<Row> = { Row: Row; Insert: never; Update: never; Relationships: [] };
export type FounderDatabase = {
  purama_ai: {
    Tables: {
      profiles: ReadTable<{ id: string; full_name: string | null; created_at: string | null }>;
      subscriptions: ReadTable<{ id: string; status: string | null; plan_type: string | null }>;
      agents: ReadTable<{ id: string; is_active: boolean | null }>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

/** Counts are queried explicitly, never inferred from a paginated row list. */
export function createDashboardReader(client: SupabaseClient<FounderDatabase, "purama_ai">): DashboardReader {
  return {
    countProfiles: async (signal) => {
      const { count, error } = await client.from("profiles").select("id", { count: "exact", head: true }).abortSignal(signal);
      return { count, error };
    },
    countActiveSubscriptions: async (signal) => {
      const { count, error } = await client.from("subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("status", "active")
        .not("plan_type", "is", null)
        .neq("plan_type", "free")
        .neq("plan_type", "").abortSignal(signal);
      return { count, error };
    },
    // Catalogue enabled; this does not claim a running agent, heartbeat or completed execution.
    countEnabledAgents: async (signal) => {
      const { count, error } = await client.from("agents")
        .select("id", { count: "exact", head: true }).eq("is_active", true).abortSignal(signal);
      return { count, error };
    },
    recentProfiles: async (signal) => {
      const { data, error } = await client.from("profiles")
        .select("id, full_name, created_at")
        .order("created_at", { ascending: false }).limit(10).abortSignal(signal);
      return { data, error };
    },
  };
}
