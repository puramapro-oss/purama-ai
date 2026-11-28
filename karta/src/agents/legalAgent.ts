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
    try {
      const { data: legalConfig, error: configError } = await supabase
        .from("legal_agent_config")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (configError) throw new Error("Lecture de la configuration indisponible");

      if (!legalConfig?.is_active) {
        return { upcomingDeadlines: [], reason: "legal_agent_config inactif ou absent" };
      }

      const soon = new Date(Date.now() + SOON_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // These reads share only the validated configuration and user scope.
      // Await both before giving the model a complete business context.
      const [documents, invoices] = await Promise.all([
        supabase
          .from("legal_documents")
          .select("id, title, expires_at")
          .eq("user_id", userId)
          .lte("expires_at", soon)
          .limit(10),
        supabase
          .from("legal_impayes")
          .select("id, debtor_name, amount, due_date, status")
          .eq("user_id", userId)
          .in("status", ["overdue", "reminder_1", "reminder_2"])
          .limit(10),
      ]);
      if (documents.error || invoices.error) throw new Error("Lecture des échéances indisponible");

      return {
        expertiseAreas: legalConfig.expertise_areas,
        autoVeille: legalConfig.auto_veille,
        upcomingDeadlines: [...(documents.data ?? []), ...(invoices.data ?? [])],
      };
    } catch {
      // A failed read is not an empty account. Do not expose transport details
      // or send an incomplete context to the model through the engine.
      throw new Error("Contexte juridique temporairement indisponible");
    }
  },
};
