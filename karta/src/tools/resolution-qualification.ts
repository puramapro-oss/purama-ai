import type { ToolDefinition } from "../engine/types.js";
import { qualifyResolution, RESOLUTION_INPUT_SCHEMA, type ResolutionQualification } from "../lib/resolution-qualification.js";

/** Existing KARTA contract; capability selection remains explicit. This tool cannot act on a dossier. */
export const resolutionQualificationTool: ToolDefinition<unknown, ResolutionQualification> = {
  name: "qualify_resolution",
  description: "Qualifie localement un dossier fourni : prérequis circulaires et alternatives référencées, périodes de transition, effort déclaré, impacts de correction, épisodes et rejeux, passation préparée/transmise/acceptée/réalisée. " +
    "Les références et statuts fournis restent non vérifiés. Aucun droit, envoi, paiement, modification de dossier, relance ou service n'est créé. Les données absentes restent inconnues.",
  sensitive: false,
  tracePolicy: "metadata_only",
  inputSchema: RESOLUTION_INPUT_SCHEMA,
  async execute(params, ctx) {
    if (ctx.mode !== "simulation" && ctx.mode !== "live") throw new Error("Mode d'exécution KARTA invalide.");
    return qualifyResolution(params);
  },
};
