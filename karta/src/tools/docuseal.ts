import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";
import { defineTool, objectSchema, stringSchema, ToolInputError } from "./validation.js";
import { isOutputObject, requireOutput } from "./response-validation.js";

/** DocuSeal self-hosted (VPS, cf CLAUDE.md). Génère une demande de signature — action sensible
 * (engage juridiquement le destinataire), toujours soumise à validation en dessous du niveau 3. */
export const docusealCreateSubmissionTool: ToolDefinition<
  { templateId: string; signerName: string; signerEmail: string },
  { submissionId: string }
> = defineTool({
  name: "docuseal_create_submission",
  description: "Envoie un document pour signature électronique via DocuSeal.",
  sensitive: true,
  input: objectSchema({
    templateId: stringSchema({ maxLength: 16, pattern: "^[1-9][0-9]*$" }),
    signerName: stringSchema({ maxLength: 512, pattern: "\\S" }),
    signerEmail: stringSchema({ format: "email", maxLength: 254 }),
  }, (params) => {
    if (!Number.isSafeInteger(Number(params.templateId))) {
      throw new ToolInputError("input.templateId", "identifiant entier positif sûr attendu");
    }
  }),
  async execute(params) {
    if (!config.docusealApiKey) throw new Error("DOCUSEAL_API_KEY non configurée côté KARTA");

    const response = await fetch(`${config.docusealBaseUrl}/api/submissions`, {
      method: "POST",
      headers: { "X-Auth-Token": config.docusealApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: Number(params.templateId),
        submitters: [{ name: params.signerName, email: params.signerEmail }],
      }),
    });

    if (!response.ok) throw new Error(`DocuSeal create submission échoué (${response.status}): ${await response.text()}`);
    // POST /submissions returns submitters; their id is not the submission id.
    // Contract: https://www.docuseal.com/docs/api#create-a-submission
    const created: unknown = await response.json();
    requireOutput(Array.isArray(created) && created.length > 0, "DocuSeal");
    const submissionIds = created.map((submitter: unknown) => {
      requireOutput(isOutputObject(submitter) && typeof submitter.submission_id === "number"
        && Number.isSafeInteger(submitter.submission_id) && submitter.submission_id > 0
        && !("error" in submitter), "DocuSeal");
      return submitter.submission_id;
    });
    requireOutput(submissionIds.every((id) => id === submissionIds[0]), "DocuSeal");
    return { submissionId: String(submissionIds[0]) };
  },
});
