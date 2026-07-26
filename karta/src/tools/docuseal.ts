import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";

/** DocuSeal self-hosted (VPS, cf CLAUDE.md). Génère une demande de signature — action sensible
 * (engage juridiquement le destinataire), toujours soumise à validation en dessous du niveau 3. */
export const docusealCreateSubmissionTool: ToolDefinition<
  { templateId: string; signerName: string; signerEmail: string },
  { submissionId: string }
> = {
  name: "docuseal_create_submission",
  description: "Envoie un document pour signature électronique via DocuSeal.",
  sensitive: true,
  async execute(params) {
    if (!config.docusealApiKey) throw new Error("DOCUSEAL_API_KEY non configurée côté KARTA");

    const response = await fetch(`${config.docusealBaseUrl}/api/submissions`, {
      method: "POST",
      headers: { "X-Auth-Token": config.docusealApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: params.templateId,
        submitters: [{ name: params.signerName, email: params.signerEmail }],
      }),
    });

    if (!response.ok) throw new Error(`DocuSeal create submission échoué (${response.status}): ${await response.text()}`);
    const created = (await response.json()) as { id: number };
    return { submissionId: String(created.id) };
  },
};
