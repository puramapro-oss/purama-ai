import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { AGENTS_CATALOG } from "./agents-catalog.js";

/**
 * Reseed purama_ai.agents (Finding #3 de AUDIT-AGENTS.md — table vide, marketplace + exécution
 * cassées de ce fait). Idempotent : upsert par slug, ré-exécutable sans risque.
 * Usage: npm run reseed:agents (depuis karta/, avec .env configuré).
 */
async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL ?? "https://auth.purama.dev";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY manquante dans l'environnement");

  const supabase = createClient(url, key, { db: { schema: "purama_ai" } });

  let upserted = 0;
  for (const agent of AGENTS_CATALOG) {
    const { error } = await supabase.from("agents").upsert(
      {
        slug: agent.slug,
        name: agent.name,
        description: agent.description,
        category: agent.category,
        icon: agent.icon,
        color: agent.color,
        webhook_slug: agent.webhookSlug,
        is_active: true,
        is_premium: false,
      },
      { onConflict: "slug" }
    );

    if (error) {
      console.error(`[reseed-agents] échec pour "${agent.slug}": ${error.message}`);
      continue;
    }
    upserted += 1;
  }

  console.log(`[reseed-agents] ${upserted}/${AGENTS_CATALOG.length} agents upsertés dans purama_ai.agents`);
}

main().catch((error) => {
  console.error("[reseed-agents] échec:", error);
  process.exit(1);
});
