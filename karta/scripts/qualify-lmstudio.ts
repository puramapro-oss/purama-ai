/** Opt-in component qualification, not an agent worker or production activation. */
import { strict as assert } from "node:assert";
import type { AnyToolDefinition } from "../src/engine/types.js";

async function main(): Promise<void> {
  if (process.env.PURAMA_LMSTUDIO_SMOKE !== "1") {
    throw new Error("Qualification LM Studio non sélectionnée explicitement");
  }
  const model = process.env.PURAMA_LMSTUDIO_MODEL;
  if (!model) throw new Error("Identifiant exact du modèle chargé requis");
  // Ignore .env files and ambient cloud settings in this child process only.
  process.env.DOTENV_CONFIG_PATH = "/dev/null";
  process.env.KARTA_MODEL_TIMEOUT_MS = "60000";
  const { createRealClaudeClient } = await import("../src/claude/real.js");
  const client = createRealClaudeClient({ lmStudio: {
    model, baseURL: process.env.PURAMA_LMSTUDIO_URL,
    apiKey: process.env.PURAMA_LMSTUDIO_TOKEN,
  } });
  const tool: AnyToolDefinition = {
    name: "prepare_fixture", description: "Préparer une donnée synthétique sans effet réel.", sensitive: false,
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
    execute: async () => { throw new Error("Aucun outil ne doit être exécuté dans ce banc"); },
  };
  let failed = false;
  for (const caseName of ["exact_format", "structured_tool"] as const) {
    const started = performance.now();
    let receipt: unknown = null;
    try {
      const result = await client.decide({
        agentType: "lmstudio-qualification",
        systemPrompt: caseName === "exact_format"
          ? "Calcule a multiplié par b. Réponds exactement par les deux chiffres du résultat."
          : "Appelle prepare_fixture une seule fois en recopiant exactement le titre fourni, sans le traduire.",
        context: caseName === "exact_format" ? { a: 6, b: 7 } : { title: "Création à Frasne" },
        tools: caseName === "exact_format" ? [] : [tool],
        onUsage: value => { receipt = value; },
      });
      if (caseName === "exact_format") {
        assert.equal(result.summary.trim(), "42"); assert.deepEqual(result.toolCalls, []);
      } else assert.deepEqual(result.toolCalls, [{ tool: "prepare_fixture", params: { title: "Création à Frasne" } }]);
      console.log(JSON.stringify({ case: caseName, status: "PASS", elapsedMs: Math.round(performance.now() - started), receipt }));
    } catch {
      failed = true;
      // No prompt, credentials, provider body or arbitrary exception in reports.
      console.log(JSON.stringify({ case: caseName, status: "NON VALIDE", elapsedMs: Math.round(performance.now() - started), receipt }));
    }
  }
  if (failed) process.exitCode = 1;
}
void main().catch(() => { console.error("BLOQUÉ : vérifier la sélection explicite, le modèle chargé et le serveur LM Studio local."); process.exitCode = 1; });
