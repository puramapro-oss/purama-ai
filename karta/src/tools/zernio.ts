import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";
import { defineTool, objectSchema, stringSchema } from "./validation.js";
import { isOutputObject, isOutputText, requireOutput } from "./response-validation.js";

export const zernioPublishTool: ToolDefinition<{ title: string; content: string }, { publicationId: string }> = defineTool({
  name: "zernio_publish",
  description: "Publie un contenu sur le réseau Zernio (écosystème Purama).",
  sensitive: false,
  input: objectSchema({ title: stringSchema({ maxLength: 512, pattern: "\\S" }), content: stringSchema({ maxLength: 100_000, pattern: "\\S" }) }),
  async execute(params) {
    if (!config.zernioApiKey) throw new Error("ZERNIO_API_KEY non configurée côté KARTA");
    const hostname = new URL(config.zernioBaseUrl).hostname.toLowerCase().replace(/\.+$/, "");
    if (hostname === "zernio.com" || hostname.endsWith(".zernio.com")) {
      // The public API uses /posts and requires authorized platform/account selection.
      // This legacy tool has neither: never issue an invented public /publish request.
      throw new Error("Zernio public non pris en charge : comptes et plateformes autorisés requis avant publication");
    }

    // Legacy custom adapter contract only: POST /publish -> { id: string }.
    // A custom deployment still requires integration validation; this is not the public Zernio API.
    const response = await fetch(`${config.zernioBaseUrl}/publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.zernioApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(config.providerTimeoutMs),
    });

    if (!response.ok) throw new Error(`Zernio publish échoué (${response.status}): ${await response.text()}`);
    const created: unknown = await response.json();
    requireOutput(isOutputObject(created) && isOutputText(created.id) && !("error" in created), "Zernio adapter");
    return { publicationId: created.id };
  },
});
