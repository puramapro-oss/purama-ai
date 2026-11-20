import type { ToolDefinition } from "../engine/types.js";
import { createPublicKnowledgeSearch, type KnowledgeSearchParams, type KnowledgeSearchResult } from "../knowledge/public-search.js";

/** Factory provides isolated transport/gates in tests; the exported singleton
 * below is shared by every catalogue in one KARTA worker.
 */
export function createKnowledgeSearchTool(options?: Parameters<typeof createPublicKnowledgeSearch>[0]): ToolDefinition<KnowledgeSearchParams, KnowledgeSearchResult> {
  const search = createPublicKnowledgeSearch(options);
  return {
    name: "knowledge_search",
    description: "Recherche des métadonnées publiques dans les sources explicitement choisies : Crossref (références scientifiques) " +
      "et Wikidata (entités). Aucune page ni texte intégral consulté, résultats non vérifiés. Envoyer uniquement la requête publique " +
      "nécessaire, jamais des secrets ni le profil privé. Une panne partielle conserve les résultats mais signale ok=false ; " +
      "elle ne constitue pas une recherche entièrement réussie.",
    sensitive: false,
    tracePolicy: "metadata_only",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 1000 },
        sources: { type: "array", items: { type: "string", enum: ["crossref", "wikidata"] }, minItems: 1, maxItems: 2,
          description: "Sources publiques à consulter ; chaque source doit apparaître une seule fois." },
        limit: { type: "integer", minimum: 1, maximum: 5, description: "Maximum de métadonnées demandées par source ; 3 par défaut." },
        language: { type: "string", enum: ["fr", "en"], description: "Langue de recherche Wikidata ; fr par défaut. Crossref ne filtre pas la langue." },
      },
      required: ["query", "sources"],
      additionalProperties: false,
    },
    async execute(params, ctx) { return search(params, ctx.mode); },
  };
}

export const knowledgeSearchTool = createKnowledgeSearchTool();
