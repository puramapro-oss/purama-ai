import { supabase } from "../db/supabase.js";
import { listNewGmailMessages, gmailCreateDraftTool, gmailSendTool } from "../tools/gmail.js";
import { sendNotificationTool } from "../tools/notification-tool.js";
import type { AgentDefinition } from "../engine/types.js";

export const emailAgent: AgentDefinition = {
  type: "email",
  systemPrompt: `Tu es l'agent email IA de Purama. Tu lis les nouveaux emails d'un utilisateur et décides,
pour chacun, l'action appropriée : brouillon de réponse (gmail_create_draft) pour les demandes simples,
notification (send_notification) pour les emails urgents/importants, ou rien si ce n'est pas nécessaire.
Ne réponds JAMAIS directement à un email sensible (juridique, facturation, plainte) sans passer par
un brouillon soumis à validation humaine. Sois concis et professionnel dans tes brouillons.`,
  tools: [gmailCreateDraftTool, gmailSendTool, sendNotificationTool],
  async buildContext(userId) {
    const { data: emailConfig } = await supabase
      .from("email_agent_config")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (!emailConfig?.is_active) {
      return { newEmails: [], reason: "email_agent_config inactif ou absent" };
    }

    const newEmails = await listNewGmailMessages(userId, emailConfig.last_email_id ?? null);

    if (newEmails.length > 0) {
      await supabase
        .from("email_agent_config")
        .update({ last_sync_at: new Date().toISOString(), last_email_id: newEmails[0].id })
        .eq("user_id", userId);
    }

    return {
      tone: emailConfig.tone,
      signature: emailConfig.signature,
      excludedEmails: emailConfig.excluded_emails,
      newEmails,
    };
  },
};
