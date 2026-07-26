import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";

/** Prospection Apollo.io — utilisé par l'agent Partenariat pour trouver des prospects réels. */
export const apolloSearchPeopleTool: ToolDefinition<
  { keywords: string; limit?: number },
  { people: Array<{ name: string; email: string | null; organization: string | null }> }
> = {
  name: "apollo_search_people",
  description: "Recherche des prospects via Apollo.io par mots-clés (niche, secteur).",
  sensitive: false,
  async execute(params) {
    if (!config.apolloApiKey) throw new Error("APOLLO_API_KEY non configurée côté KARTA");

    const response = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
      method: "POST",
      headers: { "X-Api-Key": config.apolloApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q_keywords: params.keywords, per_page: params.limit ?? 10 }),
    });

    if (!response.ok) throw new Error(`Apollo search échoué (${response.status}): ${await response.text()}`);
    const data = (await response.json()) as {
      people?: Array<{ name: string; email: string | null; organization_name: string | null }>;
    };

    return {
      people: (data.people ?? []).map((p) => ({ name: p.name, email: p.email, organization: p.organization_name })),
    };
  },
};
