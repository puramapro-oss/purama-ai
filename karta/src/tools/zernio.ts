import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";

export const zernioPublishTool: ToolDefinition<{ title: string; content: string }, { publicationId: string }> = {
  name: "zernio_publish",
  description: "Publie un contenu sur le réseau Zernio (écosystème Purama).",
  sensitive: false,
  async execute(params) {
    if (!config.zernioApiKey) throw new Error("ZERNIO_API_KEY non configurée côté KARTA");

    const response = await fetch(`${config.zernioBaseUrl}/publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.zernioApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    if (!response.ok) throw new Error(`Zernio publish échoué (${response.status}): ${await response.text()}`);
    const created = (await response.json()) as { id: string };
    return { publicationId: created.id };
  },
};
