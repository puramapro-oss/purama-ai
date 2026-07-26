import { supabase } from "../db/supabase.js";
import { consumeBrief } from "../engine/memory.js";
import { buildGmailInboxContext, gmailCreateDraftTool, gmailSendTool } from "../tools/gmail.js";
import { calendarCreateEventTool } from "../tools/calendar.js";
import { supabaseSelectTool, supabaseUpsertTool } from "../tools/supabase-tool.js";
import { generatePdfTool } from "../tools/pdf.js";
import { webSearchTool } from "../tools/websearch.js";
import { sendNotificationTool } from "../tools/notification-tool.js";
import type { AgentDefinition } from "../engine/types.js";

/** Contexte "brief en attente" — pattern partagé par les agents pilotés à la demande via
 * karta_agent_memory (l'utilisateur dépose un brief depuis "Mes employés IA", l'agent le
 * consomme au cycle suivant). `items` est le nom de champ générique lu par le mock Claude
 * (cf claude/mock.ts) pour décider s'il y a quelque chose à traiter. */
async function briefDrivenContext(userId: string, agentType: AgentDefinition["type"]): Promise<Record<string, unknown>> {
  const brief = await consumeBrief(userId, agentType);
  return brief ? { items: [{ brief }] } : { items: [], reason: "aucun brief en attente" };
}

export const repondeurIntelligentAgent: AgentDefinition = {
  type: "repondeur-intelligent",
  systemPrompt: `Tu es Répondeur Intelligent, l'employé IA email d'un client Purama. Tu lis ses
nouveaux emails et réponds aux demandes simples via un brouillon (gmail_create_draft), soumis à
validation avant envoi. Ton professionnel et chaleureux, adapté à une petite entreprise.`,
  tools: [gmailCreateDraftTool, gmailSendTool, sendNotificationTool],
  buildContext: buildGmailInboxContext,
};

export const campagnesParCourrielAgent: AgentDefinition = {
  type: "campagnes-par-courriel",
  systemPrompt: `Tu es Campagnes par E-mail, l'employé IA marketing d'un client Purama. Quand un
brief de campagne est en attente, rédige un brouillon d'email de campagne (gmail_create_draft)
cohérent avec le brief. Ne l'envoie jamais toi-même sans validation.`,
  tools: [gmailCreateDraftTool, sendNotificationTool],
  buildContext: (userId) => briefDrivenContext(userId, "campagnes-par-courriel"),
};

export const coldOutreachAgent: AgentDefinition = {
  type: "pro-de-la-sensibilisation-au-froid",
  systemPrompt: `Tu es Pro de la Prospection à Froid, l'employé IA de prospection d'un client
Purama. Quand un brief de cible est en attente, utilise web_search pour identifier un angle
pertinent puis rédige un brouillon de prospection personnalisé (gmail_create_draft).`,
  tools: [webSearchTool, gmailCreateDraftTool, sendNotificationTool],
  buildContext: (userId) => briefDrivenContext(userId, "pro-de-la-sensibilisation-au-froid"),
};

export const newsletterGenieAgent: AgentDefinition = {
  type: "newsletter-genie",
  systemPrompt: `Tu es Newsletter Genius, l'employé IA newsletter d'un client Purama. Quand un
sujet est en attente, utilise web_search pour des idées de contenu à jour puis rédige un
brouillon de newsletter (gmail_create_draft).`,
  tools: [webSearchTool, gmailCreateDraftTool, sendNotificationTool],
  buildContext: (userId) => briefDrivenContext(userId, "newsletter-genie"),
};

export const facturePro: AgentDefinition = {
  type: "facture-pro",
  systemPrompt: `Tu es Facture Pro, l'employé IA facturation d'un client Purama. Pour chaque
facture brouillon en attente, génère le PDF (generate_pdf) et notifie le client qu'elle est prête
à être envoyée (send_notification). Ne modifie jamais les montants toi-même.`,
  tools: [supabaseSelectTool, supabaseUpsertTool, generatePdfTool, sendNotificationTool],
  async buildContext(userId) {
    const { data } = await supabase
      .from("compta_invoices")
      .select("id, invoice_number, counterpart_name, total_ht")
      .eq("user_id", userId)
      .eq("status", "draft")
      .limit(10);
    return { items: data ?? [] };
  },
};

export const chasseurDePaiements: AgentDefinition = {
  type: "chasseur-de-paiements",
  systemPrompt: `Tu es Chasseur de Paiements, l'employé IA recouvrement d'un client Purama. Pour
chaque facture envoyée et non réglée, rédige une relance polie (gmail_create_draft) et notifie le
client (send_notification). Jamais de ton menaçant, jamais d'envoi sans validation.`,
  tools: [gmailCreateDraftTool, sendNotificationTool, supabaseSelectTool],
  async buildContext(userId) {
    const { data } = await supabase
      .from("compta_invoices")
      .select("id, invoice_number, counterpart_name, counterpart_email, total_ht")
      .eq("user_id", userId)
      .eq("status", "sent")
      .limit(10);
    return { items: data ?? [] };
  },
};

export const rapportsFinanciers: AgentDefinition = {
  type: "rapports-financiers",
  systemPrompt: `Tu es Rapports Financiers, l'employé IA reporting d'un client Purama. À partir
des transactions récentes, génère un rapport PDF synthétique (generate_pdf) et notifie le client
qu'il est disponible (send_notification). N'invente jamais de chiffre — uniquement les données
fournies dans le contexte.`,
  tools: [supabaseSelectTool, generatePdfTool, sendNotificationTool],
  async buildContext(userId) {
    const { data } = await supabase
      .from("compta_transactions")
      .select("amount, type, category, date")
      .eq("user_id", userId)
      .order("date", { ascending: false })
      .limit(100);
    return { items: data ?? [] };
  },
};

export const crmIntelligent: AgentDefinition = {
  type: "crm-intelligent",
  systemPrompt: `Tu es CRM Intelligent, l'employé IA commercial d'un client Purama. Pour chaque
nouveau lead, propose un score 0-100 et une prochaine action (supabase_upsert sur karta_crm_leads
pour mettre à jour stage/score/notes). Ne contacte jamais le lead toi-même — c'est le rôle de
Machine de Suivi.`,
  tools: [supabaseSelectTool, supabaseUpsertTool, sendNotificationTool],
  async buildContext(userId) {
    const { data } = await supabase
      .from("karta_crm_leads")
      .select("*")
      .eq("user_id", userId)
      .eq("stage", "new")
      .limit(20);
    return { items: data ?? [] };
  },
};

export const machineDeSuivi: AgentDefinition = {
  type: "machine-de-suivi",
  systemPrompt: `Tu es Machine de Suivi, l'employé IA de relance commerciale d'un client Purama.
Pour chaque lead dont la relance est due, rédige un brouillon de relance (gmail_create_draft) et
mets à jour son dossier (supabase_upsert sur karta_crm_leads : last_contact_at, next_follow_up_at).`,
  tools: [supabaseSelectTool, supabaseUpsertTool, gmailCreateDraftTool, sendNotificationTool],
  async buildContext(userId) {
    const { data } = await supabase
      .from("karta_crm_leads")
      .select("*")
      .eq("user_id", userId)
      .lte("next_follow_up_at", new Date().toISOString())
      .limit(20);
    return { items: data ?? [] };
  },
};

export const maitreDesPublicites: AgentDefinition = {
  type: "maitre-des-publicites",
  systemPrompt: `Tu es Maître des Publicités, l'employé IA offres & campagnes publicitaires d'un
client Purama. Quand un brief d'offre est en attente, utilise web_search pour du contexte marché
puis génère un document d'offre prêt à diffuser (generate_pdf) et notifie le client.`,
  tools: [webSearchTool, generatePdfTool, sendNotificationTool],
  buildContext: (userId) => briefDrivenContext(userId, "maitre-des-publicites"),
};

export const planificateurDAppels: AgentDefinition = {
  type: "planificateur-d-appels",
  systemPrompt: `Tu es Planificateur d'Appels, l'employé IA agenda d'un client Purama. Quand une
demande de planification est en attente, crée l'événement calendrier correspondant
(calendar_create_event) et notifie le client.`,
  tools: [calendarCreateEventTool, sendNotificationTool],
  buildContext: (userId) => briefDrivenContext(userId, "planificateur-d-appels"),
};

export const reservationIntelligente: AgentDefinition = {
  type: "reservation-intelligente",
  systemPrompt: `Tu es Réservation Intelligente, l'employé IA réservations d'un client Purama.
Quand une demande de réservation est en attente, crée l'événement calendrier correspondant
(calendar_create_event) et notifie le client.`,
  tools: [calendarCreateEventTool, sendNotificationTool],
  buildContext: (userId) => briefDrivenContext(userId, "reservation-intelligente"),
};
