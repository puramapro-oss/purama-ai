import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const FUNCTIONS_ROOT = fileURLToPath(new URL("../supabase/functions/", import.meta.url));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

test("edge functions never emit a literal wildcard CORS origin", async () => {
  const files = await sourceFiles(FUNCTIONS_ROOT);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /["']Access-Control-Allow-Origin["']\s*:\s*["']\*["']/,
      `${file} must not allow every browser origin`,
    );
  }
});

test("every CORS policy is explicitly configured by environment", async () => {
  const files = await sourceFiles(FUNCTIONS_ROOT);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (!source.includes("Access-Control-Allow-Origin")) continue;
    assert.match(
      source,
      /(?:CORS_ALLOWED_ORIGIN|OAUTH_ALLOWED_ORIGINS)/,
      `${file} must source its browser origin policy from environment`,
    );
  }
});

test("CORS-enabled handlers implement preflight handling", async () => {
  const entries = await readdir(FUNCTIONS_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "_shared") continue;
    const file = join(FUNCTIONS_ROOT, entry.name, "index.ts");
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (!source.includes("Access-Control-Allow-Origin") && !source.includes("corsHeaders") && !source.includes("CORS_HEADERS")) continue;
    assert.match(source, /req\.method\s*===\s*["']OPTIONS["']/, `${file} must handle OPTIONS`);
  }
});
