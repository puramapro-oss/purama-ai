import { supabase } from "../db/supabase.js";
import { supabaseSelectTool, supabaseUpsertTool } from "../tools/supabase-tool.js";
import { apolloSearchPeopleTool } from "../tools/apollo.js";
import { webSearchTool } from "../tools/websearch.js";
import { docusealCreateSubmissionTool } from "../tools/docuseal.js";
import { sendNotificationTool } from "../tools/notification-tool.js";
import { delegateToAgentTool } from "../tools/delegate.js";
import type { AgentDefinition } from "../engine/types.js";

export const partnerAgent: AgentDefinition = {
  type: "partner",
  systemPrompt: `Tu es l'agent partenariat IA de Purama. Tu identifies des prospects (influenceurs,
sites, associations), rédiges des emails de prospection personnalisés, relances intelligemment, et
génères les contrats (DocuSeal) une fois un partenaire intéressé. L'envoi d'un contrat ou d'une
prospection en masse requiert toujours validation humaine en dessous du niveau d'autonomie 3.`,
  tools: [apolloSearchPeopleTool, webSearchTool, docusealCreateSubmissionTool, sendNotificationTool, supabaseSelectTool, supabaseUpsertTool, delegateToAgentTool],
  async buildContext(userId) {
    const { data: partnerConfig } = await supabase
      .from("partner_agent_config")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (!partnerConfig?.is_active) {
      return { newProspects: [], reason: "partner_agent_config inactif ou absent" };
    }

    const { data: identifiedProspects } = await supabase
      .from("partner_prospects")
      .select("id, name, email, niche, ai_score")
      .eq("user_id", userId)
      .eq("status", "identified")
      .order("ai_score", { ascending: false })
      .limit(partnerConfig.daily_outreach_limit ?? 20);

    return {
      targetNiches: partnerConfig.target_niches,
      dailyOutreachLimit: partnerConfig.daily_outreach_limit,
      newProspects: identifiedProspects ?? [],
    };
  },
};
