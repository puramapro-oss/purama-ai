import { supabase } from "../db/supabase.js";
import { resolveCustomAgentTools } from "../tools/customRegistry.js";
import type { AgentDefinition, CustomAgentType } from "../engine/types.js";

/** Vue KARTA d'une ligne `creator_agents` — seules les colonnes utiles à l'exécution réelle. */
export interface CustomAgentRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  tools_enabled: string[] | null;
  karta_enabled: boolean;
  is_active: boolean;
  schedule_enabled: boolean;
  schedule_cron: string | null;
}

const SELECT_COLUMNS =
  "id, user_id, name, description, system_prompt, tools_enabled, karta_enabled, is_active, schedule_enabled, schedule_cron";

export async function loadCustomAgent(agentId: string): Promise<CustomAgentRow | null> {
  const { data, error } = await supabase
    .from("creator_agents")
    .select(SELECT_COLUMNS)
    .eq("id", agentId)
    .maybeSingle();

  if (error) throw new Error(`loadCustomAgent(${agentId}): ${error.message}`);
  return data as CustomAgentRow | null;
}

/** Tous les agents créés par des users, activés en exécution réelle ET non désactivés par leur propriétaire. */
export async function listKartaEnabledCustomAgents(): Promise<CustomAgentRow[]> {
  const { data, error } = await supabase
    .from("creator_agents")
    .select(SELECT_COLUMNS)
    .eq("karta_enabled", true)
    .eq("is_active", true);

  if (error) throw new Error(`listKartaEnabledCustomAgents: ${error.message}`);
  return (data ?? []) as CustomAgentRow[];
}

/** Construit un AgentDefinition à la volée depuis une ligne creator_agents — aucun code statique
 * par agent : le prompt système et les outils viennent entièrement de ce que l'utilisateur (ou
 * la génération IA) a configuré. Réutilise runAgentCycle tel quel (autonomie, kill switch,
 * simulation, logs, notify) — 0 duplication du moteur. */
export function buildCustomAgentDefinition(row: CustomAgentRow): AgentDefinition {
  const type: CustomAgentType = `custom:${row.id}`;

  return {
    type,
    systemPrompt: row.system_prompt,
    tools: resolveCustomAgentTools(row.tools_enabled),
    buildContext: async () => ({
      customAgentName: row.name,
      customAgentDescription: row.description ?? "",
    }),
  };
}
