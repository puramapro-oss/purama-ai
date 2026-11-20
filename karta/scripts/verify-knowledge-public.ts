/** Explicit, bounded real-network verification. No credentials or private input.
 * From karta/: node --import tsx scripts/verify-knowledge-public.ts --live
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { knowledgeSearchTool } from "../src/tools/knowledge-search.js";

if (process.argv.slice(2).length !== 1 || process.argv[2] !== "--live") {
  process.stderr.write("Utilisation : node --import tsx scripts/verify-knowledge-public.ts --live\n");
  process.exitCode = 2;
} else {
  const started = performance.now();
  const executedAt = new Date().toISOString();
  const result = await knowledgeSearchTool.execute({
    query: "quantum computing", sources: ["crossref", "wikidata"], language: "en", limit: 2,
  }, { userId: "public-verification", agentType: "custom:public-verification", mode: "live" });
  const passed = result.ok && result.status === "complete"
    && result.evidence.sources.length === 2
    && result.evidence.sources.every(source => source.status === "ok" && source.result_count > 0);
  const files = ["../src/tools/knowledge-search.ts", "../src/knowledge/public-search.ts"];
  const hashes = Object.fromEntries(files.map(path => [path.slice(3), createHash("sha256")
    .update(readFileSync(new URL(path, import.meta.url))).digest("hex")]));
  process.stdout.write(JSON.stringify({
    status: passed ? "PASS" : "FAIL", executed_at: executedAt,
    command: "node --import tsx scripts/verify-knowledge-public.ts --live",
    cwd: "karta", node_version: process.versions.node,
    duration_ms: Math.round(performance.now() - started),
    checked_files_sha256: hashes, result,
    limitations: ["One public query per provider; no private input or credentials.",
      "No full-text retrieval, QPU, distributed quota test or production deployment."],
  }, null, 2) + "\n");
  process.exitCode = passed ? 0 : 1;
}
