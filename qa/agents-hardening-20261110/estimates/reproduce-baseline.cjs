const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const fromKarta = createRequire(path.join(root, "karta/package.json"));
const ts = fromKarta("typescript");
const { PGlite } = fromKarta("@electric-sql/pglite");
const base = "1daf6314d60f6dd336c3a3601ddf73cf432ef4b3";
const fromBase = file => execFileSync("git", ["show", `${base}:${file}`], { cwd: root, encoding: "utf8" });

(async () => {
  const source = fromBase("karta/src/chef/brief.ts");
  const loaded = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(require, loaded, loaded.exports);
  const brief = {
    briefId: "brief-estimates", version: 1, goal: "Build bounded work", repo: "puramapro-oss/example",
    requirements: [{ key: "R1", description: "Implement and verify" }],
    tasks: [
      {
        key: "T1", title: "Implement", instructions: "Implement safely", requirementKeys: ["R1"],
        provider: "codex", accessMode: "write", scopeKey: "example:src", allowedPaths: ["src"],
        verificationProfiles: ["unit"],
      },
      {
        key: "T2", title: "Review", instructions: "Review independently", requirementKeys: ["R1"],
        provider: "claude", accessMode: "read", dependsOn: ["T1"], verificationProfiles: ["review"],
      },
    ],
  };
  const estimated = structuredClone(brief);
  Object.assign(estimated.tasks[0], { estimatedTokens: 0, estimatedCostMicros: 70 });
  Object.assign(estimated.tasks[1], { estimatedTokens: 10, estimatedCostMicros: 0 });
  const normalized = loaded.exports.normalizeChefBrief(estimated);
  const legacyHash = loaded.exports.hashChefBrief(brief);
  assert.equal(loaded.exports.hashChefBrief(estimated), legacyHash);
  assert(normalized.tasks.every(task => task.estimatedTokens === undefined && task.estimatedCostMicros === undefined));

  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
      CREATE SCHEMA purama_ai;
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
    `);
    for (const file of [
      "008_chef_control_plane.sql", "009_chef_hardening.sql", "010_chef_reliability.sql",
      "011_chef_runtime_policy.sql", "012_chef_mission_ingest.sql", "013_chef_independent_review.sql",
      "014_chef_file_ownership.sql", "015_chef_mission_file_ownership.sql",
    ]) await db.exec(fromBase("karta/migrations/" + file));
    const uid = "00000000-0000-4000-8000-000000000601";
    await db.query("INSERT INTO auth.users(id) VALUES($1)", [uid]);
    await db.query("SELECT purama_ai.chef_create_mission($1,$2::jsonb,$3,4,100,100)", [uid, JSON.stringify(estimated), legacyHash]);
    const rows = (await db.query("SELECT task_key,estimated_tokens,estimated_cost_micros FROM purama_ai.chef_tasks ORDER BY task_key")).rows;
    assert.deepEqual(rows, [
      { task_key: "T1", estimated_tokens: null, estimated_cost_micros: null },
      { task_key: "T2", estimated_tokens: null, estimated_cost_micros: null },
    ]);
    const evidence = {
      status: "BUG_REPRODUCED", base, legacy_hash: legacyHash,
      brief_source_sha256: createHash("sha256").update(source).digest("hex"),
      normalization_drops_estimates: true, old_hash_ignores_estimates: true,
      raw_rpc_drops_estimates: rows,
      limitation: "PGlite local, aucune API ou base de production ; les migrations sont lues directement au commit indiqué.",
    };
    writeFileSync(path.join(__dirname, "baseline-reproduction.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
