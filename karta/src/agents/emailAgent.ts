import { buildGmailInboxContext, gmailCreateDraftTool, gmailSendTool } from "../tools/gmail.js";
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
  buildContext: buildGmailInboxContext,
};
