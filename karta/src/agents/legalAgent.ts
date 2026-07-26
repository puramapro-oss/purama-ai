import { supabase } from "../db/supabase.js";
import { supabaseSelectTool, supabaseUpsertTool } from "../tools/supabase-tool.js";
import { webSearchTool } from "../tools/websearch.js";
import { docusealCreateSubmissionTool } from "../tools/docuseal.js";
import { generatePdfTool } from "../tools/pdf.js";
import { sendNotificationTool } from "../tools/notification-tool.js";
import { delegateToAgentTool } from "../tools/delegate.js";
import type { AgentDefinition } from "../engine/types.js";

const SOON_DAYS = 30;

export const legalAgent: AgentDefinition = {
  type: "legal",
  systemPrompt: `Tu es l'agent juridique IA de Purama. Tu surveilles les échéances (renouvellement de
documents, prescriptions, impayés), fais de la veille réglementaire (web_search) et prépares les
documents nécessaires (mise en demeure, relance...). Une action qui engage juridiquement
l'utilisateur (envoi d'une mise en demeure, signature DocuSeal) requiert toujours validation humaine
en dessous du niveau d'autonomie 3.`,
  tools: [webSearchTool, docusealCreateSubmissionTool, generatePdfTool, sendNotificationTool, supabaseSelectTool, supabaseUpsertTool, delegateToAgentTool],
  async buildContext(userId) {
    const { data: legalConfig } = await supabase
      .from("legal_agent_config")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (!legalConfig?.is_active) {
      return { upcomingDeadlines: [], reason: "legal_agent_config inactif ou absent" };
    }

    const soon = new Date(Date.now() + SOON_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { data: expiringDocuments } = await supabase
      .from("legal_documents")
      .select("id, title, expires_at")
      .eq("user_id", userId)
      .lte("expires_at", soon)
      .limit(10);

    const { data: overdueInvoices } = await supabase
      .from("legal_impayes")
      .select("id, debtor_name, amount, due_date, status")
      .eq("user_id", userId)
      .in("status", ["overdue", "reminder_1", "reminder_2"])
      .limit(10);

    return {
      expertiseAreas: legalConfig.expertise_areas,
      autoVeille: legalConfig.auto_veille,
      upcomingDeadlines: [...(expiringDocuments ?? []), ...(overdueInvoices ?? [])],
    };
  },
};
