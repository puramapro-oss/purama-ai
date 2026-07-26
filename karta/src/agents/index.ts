import { supabase } from "../db/supabase.js";
import { emailAgent } from "./emailAgent.js";
import { comptaAgent } from "./comptaAgent.js";
import { legalAgent } from "./legalAgent.js";
import { partnerAgent } from "./partnerAgent.js";
import {
  repondeurIntelligentAgent,
  campagnesParCourrielAgent,
  coldOutreachAgent,
  newsletterGenieAgent,
  facturePro,
  chasseurDePaiements,
  rapportsFinanciers,
  crmIntelligent,
  machineDeSuivi,
  maitreDesPublicites,
  planificateurDAppels,
  reservationIntelligente,
} from "./actionAgents.js";
import type { AgentDefinition, AgentType, CoreAgentType, StaticAgentType } from "../engine/types.js";

/** Les agents créés par les utilisateurs (`custom:<id>`) ne sont PAS ici — ils sont résolus
 * dynamiquement depuis `creator_agents` (cf agents/customAgent.ts), jamais codés en dur. */
export const AGENT_REGISTRY: Record<StaticAgentType, AgentDefinition> = {
  email: emailAgent,
  compta: comptaAgent,
  legal: legalAgent,
  partner: partnerAgent,
  "repondeur-intelligent": repondeurIntelligentAgent,
  "campagnes-par-courriel": campagnesParCourrielAgent,
  "pro-de-la-sensibilisation-au-froid": coldOutreachAgent,
  "newsletter-genie": newsletterGenieAgent,
  "facture-pro": facturePro,
  "chasseur-de-paiements": chasseurDePaiements,
  "rapports-financiers": rapportsFinanciers,
  "crm-intelligent": crmIntelligent,
  "machine-de-suivi": machineDeSuivi,
  "maitre-des-publicites": maitreDesPublicites,
  "planificateur-d-appels": planificateurDAppels,
  "reservation-intelligente": reservationIntelligente,
};

/** Les 4 agents cœur ont une table de config métier dédiée (SIREN, tokens OAuth...) dont
 * `is_active` fait foi pour savoir s'il y a de quoi travailler. Les 12 agents "action" n'ont
 * pas de config métier propre — karta_agent_state.is_enabled (activation depuis "Mes employés
 * IA") est directement la source de vérité pour eux. */
const CORE_CONFIG_TABLE: Record<CoreAgentType, string> = {
  email: "email_agent_config",
  compta: "compta_agent_config",
  legal: "legal_agent_config",
  partner: "partner_agent_config",
};

/** Liste les user_id ayant activé cet agent — utilisé par le scheduler pour itérer. */
export async function listActiveUserIds(agentType: AgentType): Promise<string[]> {
  const coreTable = CORE_CONFIG_TABLE[agentType as CoreAgentType];

  const { data, error } = coreTable
    ? await supabase.from(coreTable).select("user_id").eq("is_active", true)
    : await supabase.from("karta_agent_state").select("user_id").eq("agent_type", agentType).eq("is_enabled", true);

  if (error) throw new Error(`listActiveUserIds(${agentType}): ${error.message}`);
  return (data ?? []).map((row) => row.user_id as string);
}
