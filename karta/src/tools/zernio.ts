import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";

export const zernioPublishTool: ToolDefinition<{ title: string; content: string }, { publicationId: string }> = {
  name: "zernio_publish",
  description: "Publie un contenu sur le réseau Zernio (écosystème Purama).",
  // Publication externe visible : validation requise selon la politique d'autonomie.
  sensitive: true,
  async execute(params, ctx) {
    if (!config.zernioApiKey) throw new Error("ZERNIO_API_KEY non configurée côté KARTA");
    if (typeof params.title !== "string" || !params.title.trim() || params.title.length > 300 || /[\u0000]/.test(params.title)) {
      throw new Error("Titre Zernio invalide");
    }
    if (typeof params.content !== "string" || !params.content.trim() || params.content.length > 100_000 || /[\u0000]/.test(params.content)) {
      throw new Error("Contenu Zernio invalide");
    }

    const response = await fetch(`${config.zernioBaseUrl}/publish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.zernioApiKey}`,
        "Content-Type": "application/json",
        ...(ctx.operationId ? { "Idempotency-Key": ctx.operationId } : {}),
      },
      body: JSON.stringify({ title: params.title.trim(), content: params.content }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) throw new Error(`Zernio publish échoué (${response.status})`);
    const created = (await response.json()) as { id?: string };
    if (!created.id) throw new Error("Publication Zernio sans identifiant");
    return { publicationId: created.id };
  },
};
