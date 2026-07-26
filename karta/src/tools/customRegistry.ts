import { supabaseSelectTool, supabaseUpsertTool } from "./supabase-tool.js";
import { gmailCreateDraftTool, gmailSendTool } from "./gmail.js";
import { calendarCreateEventTool } from "./calendar.js";
import { generatePdfTool } from "./pdf.js";
import { webSearchTool } from "./websearch.js";
import { sendNotificationTool } from "./notification-tool.js";
import type { AnyToolDefinition } from "../engine/types.js";

/**
 * Sous-ensemble d'outils "sûrs" proposés aux agents créés par les utilisateurs (Agent Créateur
 * d'Agents, cf brief §Phase 4). Exclut volontairement : les outils liés à des clés API propres
 * à Purama (stripe_list_unpaid_invoices lit la facturation PLATEFORME, pas celle de l'utilisateur ;
 * zernio_publish, apollo_search_people), docuseal_create_submission (signature de document, trop
 * sensible pour un V1 configurable en langage naturel) et delegate_to_agent (réservé aux agents
 * statiques, pour éviter des boucles de délégation entre agents créés par des utilisateurs).
 */
export const CUSTOM_AGENT_TOOLS: Record<string, AnyToolDefinition> = {
  supabase_select: supabaseSelectTool,
  supabase_upsert: supabaseUpsertTool,
  gmail_create_draft: gmailCreateDraftTool,
  gmail_send: gmailSendTool,
  calendar_create_event: calendarCreateEventTool,
  generate_pdf: generatePdfTool,
  web_search: webSearchTool,
  send_notification: sendNotificationTool,
};

export const CUSTOM_AGENT_TOOL_NAMES = Object.keys(CUSTOM_AGENT_TOOLS);

/** Filtre défensif : ne résout QUE les noms d'outils connus (liste blanche), ignore le reste
 * silencieusement — un nom invalide venant de Claude/du mock ne doit jamais planter l'agent. */
export function resolveCustomAgentTools(names: string[] | null | undefined): AnyToolDefinition[] {
  return (names ?? [])
    .map((name) => CUSTOM_AGENT_TOOLS[name])
    .filter((tool): tool is AnyToolDefinition => Boolean(tool));
}
