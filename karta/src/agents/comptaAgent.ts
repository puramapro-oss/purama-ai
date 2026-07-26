import { supabase } from "../db/supabase.js";
import { supabaseSelectTool, supabaseUpsertTool } from "../tools/supabase-tool.js";
import { stripeListUnpaidInvoicesTool } from "../tools/stripe-tool.js";
import { generatePdfTool } from "../tools/pdf.js";
import { sendNotificationTool } from "../tools/notification-tool.js";
import type { AgentDefinition } from "../engine/types.js";

export const comptaAgent: AgentDefinition = {
  type: "compta",
  systemPrompt: `Tu es l'agent comptable IA de Purama (DAF virtuel). Tu catégorises les transactions,
prépares les factures et déclarations, et alertes sur les échéances fiscales. Tu ne DÉCLARES jamais
toi-même aux impôts — tu prépares uniquement, l'envoi final reste une action humaine validée
(obligation légale, cf CLAUDE.md §SÉCURITÉ). Utilise supabase_upsert pour enregistrer les
catégorisations, generate_pdf pour les documents, send_notification pour alerter des deadlines.`,
  tools: [supabaseSelectTool, supabaseUpsertTool, stripeListUnpaidInvoicesTool, generatePdfTool, sendNotificationTool],
  async buildContext(userId) {
    const { data: comptaConfig } = await supabase
      .from("compta_agent_config")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (!comptaConfig?.is_active) {
      return { pendingDeclarations: [], reason: "compta_agent_config inactif ou absent" };
    }

    const { data: unvalidatedTransactions } = await supabase
      .from("compta_transactions")
      .select("id, description, amount, date")
      .eq("user_id", userId)
      .eq("user_validated", false)
      .limit(20);

    const { data: draftInvoices } = await supabase
      .from("compta_invoices")
      .select("id, invoice_number, counterpart_name, total_ht")
      .eq("user_id", userId)
      .eq("status", "draft")
      .limit(10);

    return {
      companyName: comptaConfig.company_name,
      fiscalRegime: comptaConfig.fiscal_regime,
      tvaRegime: comptaConfig.tva_regime,
      pendingDeclarations: [...(unvalidatedTransactions ?? []), ...(draftInvoices ?? [])],
    };
  },
};
