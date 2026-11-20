import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";

export const zernioPublishTool: ToolDefinition<{ title: string; content: string }, { publicationId: string }> = {
  name: "zernio_publish",
  description: "Publie un contenu sur le réseau Zernio (écosystème Purama).",
  sensitive: true,
  requiresExplicitApproval: true,
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 500 },
      content: { type: "string", minLength: 1, maxLength: 100000 },
    },
    required: ["title", "content"],
    additionalProperties: false,
  },
  async execute(params, context) {
    if (context?.mode !== "live" || !context.approvedActionId || context.approvedActionId !== context.operationId) {
      throw new Error("Publication Zernio : approbation explicite requise pour cette action");
    }
    if (!config.zernioApiKey) throw new Error("ZERNIO_API_KEY non configurée côté KARTA");
    const base = config.zernioBaseUrl;
    if (!/^https:\/\//i.test(base) || !URL.canParse(base)) throw new Error("ZERNIO_BASE_URL doit désigner un adaptateur HTTPS explicite");
    const endpoint = new URL(base);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("ZERNIO_BASE_URL doit désigner la base de l’adaptateur, sans identifiants, paramètres ni fragment");
    }
    const host = endpoint.hostname.toLowerCase().replace(/\.+$/, "");
    if (host === "zernio.com" || host.endsWith(".zernio.com")) {
      throw new Error("Zernio public non pris en charge : comptes et plateformes autorisés requis avant publication");
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/publish`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.zernioApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(params),
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });

    if (!response.ok) throw new Error(`Zernio publish échoué (${response.status})`);
    const created: unknown = await response.json();
    if (typeof created !== "object" || !created || !("id" in created) || typeof created.id !== "string" || !created.id.trim() || "error" in created) {
      throw new Error("Confirmation de publication Zernio invalide");
    }
    return { publicationId: created.id };
  },
};
