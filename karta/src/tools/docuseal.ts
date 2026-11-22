import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";
import { assertToolResult } from "../engine/tool-result.js";
import { createProviderDeadline, requestProviderJson } from "./provider-http.js";

const UNCONFIRMED_SUBMISSION = "Création DocuSeal non confirmée : vérifier la demande avant toute reprise";

/** POST /submissions returns submitters; their id is not the submission identity. */
function readSubmissionId(value: unknown, expectedEmail: string): string {
  if (!Array.isArray(value) || value.length === 0) throw new Error(UNCONFIRMED_SUBMISSION);
  let submissionId: number | undefined;
  let signerConfirmed = false;
  const email = expectedEmail.trim().toLowerCase();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(UNCONFIRMED_SUBMISSION);
    assertToolResult(item);
    const submitter = item as Record<string, unknown>;
    const id = submitter.submission_id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 ||
        (submissionId !== undefined && id !== submissionId)) {
      throw new Error(UNCONFIRMED_SUBMISSION);
    }
    submissionId = id;
    signerConfirmed ||= email.length > 0 && typeof submitter.email === "string" && submitter.email.trim().toLowerCase() === email;
  }
  if (!signerConfirmed) throw new Error(UNCONFIRMED_SUBMISSION);
  return String(submissionId);
}

/** DocuSeal self-hosted (VPS, cf CLAUDE.md). Génère une demande de signature — action sensible
 * (engage juridiquement le destinataire), toujours soumise à validation en dessous du niveau 3. */
export const docusealCreateSubmissionTool: ToolDefinition<
  { templateId: string; signerName: string; signerEmail: string },
  { submissionId: string }
> = {
  name: "docuseal_create_submission",
  description: "Crée une demande de signature électronique via DocuSeal ; ne confirme pas la signature du document.",
  sensitive: true,
  inputSchema: {
    type: "object",
    properties: {
      templateId: { type: "string", minLength: 1, maxLength: 128 },
      signerName: { type: "string", minLength: 1, maxLength: 200 },
      signerEmail: { type: "string", minLength: 3, maxLength: 320 },
    },
    required: ["templateId", "signerName", "signerEmail"],
    additionalProperties: false,
  },
  async execute(params) {
    if (!config.docusealApiKey) throw new Error("DOCUSEAL_API_KEY non configurée côté KARTA");

    const deadline = createProviderDeadline(20_000, UNCONFIRMED_SUBMISSION);
    try {
      const created = await requestProviderJson(`${config.docusealBaseUrl}/api/submissions`, {
        method: "POST",
        headers: { "X-Auth-Token": config.docusealApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: params.templateId,
          submitters: [{ name: params.signerName, email: params.signerEmail }],
        }),
      }, deadline, 64 * 1024);
      const submissionId = readSubmissionId(created, params.signerEmail);
      deadline.check();
      // This receipt confirms creation only, never a completed signature.
      return { submissionId };
    } catch {
      // A timeout or invalid receipt cannot establish that the POST had no effect.
      // Do not retry it or expose provider response bodies in the generic trace.
      throw new Error(UNCONFIRMED_SUBMISSION);
    } finally {
      deadline.close();
    }
  },
};
