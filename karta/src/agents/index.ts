import { supabase } from "../db/supabase.js";
import { emailAgent } from "./emailAgent.js";
import { comptaAgent } from "./comptaAgent.js";
import { legalAgent } from "./legalAgent.js";
import { partnerAgent } from "./partnerAgent.js";
import type { AgentDefinition, AgentType } from "../engine/types.js";

export const AGENT_REGISTRY: Record<AgentType, AgentDefinition> = {
  email: emailAgent,
  compta: comptaAgent,
  legal: legalAgent,
  partner: partnerAgent,
};

const CONFIG_TABLE: Record<AgentType, string> = {
  email: "email_agent_config",
  compta: "compta_agent_config",
  legal: "legal_agent_config",
  partner: "partner_agent_config",
};

/** Liste les user_id ayant activé cet agent — utilisé par le scheduler pour itérer. */
export async function listActiveUserIds(agentType: AgentType): Promise<string[]> {
  const { data, error } = await supabase.from(CONFIG_TABLE[agentType]).select("user_id").eq("is_active", true);

  if (error) throw new Error(`listActiveUserIds(${agentType}): ${error.message}`);
  return (data ?? []).map((row) => row.user_id as string);
}
