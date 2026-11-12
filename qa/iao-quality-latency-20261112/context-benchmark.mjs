// Controlled dependency benchmark only. No live database/model/network traffic.
// Compare exact baseline/current agent functions with 25 ms per inert DB read.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2] ?? 'context-benchmark-result.json');
const require = createRequire(`${repo}/karta/package.json`);
const ts = require('typescript');
const base = '8259b84e65ca89b01bd1b1fc46576cb60bb8a1ec';
const injectedReadDelayMs = 25;
const runsPerVariant = 20;
const hash = source => createHash('sha256').update(source).digest('hex');

function loadAgent(name, source) {
  const config = { is_active: true, expertise_areas: ['test'], auto_veille: true,
    company_name: 'test', fiscal_regime: 'test', tva_regime: 'test' };
  const responses = {
    legal_agent_config: config, compta_agent_config: config,
    legal_documents: [{ id: 'document-1' }], legal_impayes: [{ id: 'invoice-1' }],
    compta_transactions: [{ id: 'transaction-1' }], compta_invoices: [{ id: 'invoice-2' }],
  };
  const supabase = { from(table) {
    const query = new Proxy({}, { get(_target, key) {
      if (key === 'then') return (resolve, reject) => delay(injectedReadDelayMs)
        .then(() => ({ data: responses[table], error: null })).then(resolve, reject);
      return () => query;
    } });
    return query;
  } };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports,
    require: id => id.includes('/db/supabase') ? { supabase }
      : new Proxy({}, { get: () => ({ name: 'inert', execute: async () => ({ ok: true }) }) }),
    Date, Promise, console,
  });
  return module.exports[name];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samplesMs: values, medianMs: (sorted[9] + sorted[10]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0], maxMs: sorted.at(-1) };
}

const results = [];
for (const name of ['legalAgent', 'comptaAgent']) {
  const path = `karta/src/agents/${name}.ts`;
  const baselineSource = execFileSync('git', ['show', `${base}:${path}`], { cwd: repo, encoding: 'utf8' });
  const candidateSource = readFileSync(`${repo}/${path}`, 'utf8');
  const agents = { baseline: loadAgent(name, baselineSource), candidate: loadAgent(name, candidateSource) };
  const samples = { baseline: [], candidate: [] };
  for (const agent of Object.values(agents)) {
    await agent.buildContext('benchmark-inert-user');
    await agent.buildContext('benchmark-inert-user');
  }
  for (let index = 0; index < runsPerVariant; index++) {
    const order = index % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const variant of order) {
      const start = performance.now();
      await agents[variant].buildContext('benchmark-inert-user');
      samples[variant].push(performance.now() - start);
    }
  }
  const baseline = stats(samples.baseline);
  const candidate = stats(samples.candidate);
  results.push({ name, path, baselineSourceSha256: hash(baselineSource), candidateSourceSha256: hash(candidateSource),
    baseline, candidate, medianReductionPercent: 100 * (1 - candidate.medianMs / baseline.medianMs),
    medianSpeedRatio: baseline.medianMs / candidate.medianMs });
}
const report = { measuredAt: new Date().toISOString(), base,
  scope: 'Controlled buildContext microbenchmark with inert dependencies; no production or model latency claim.',
  injectedReadDelayMs, runsPerVariant, warmupRunsPerVariant: 2,
  databaseRequestsPerBuild: 3, modelsCalled: 0, networkRequests: 0,
  results };
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, ...report,
  results: results.map(({ baseline, candidate, ...rest }) => ({ ...rest,
    baselineMedianMs: baseline.medianMs, baselineP95Ms: baseline.p95Ms,
    candidateMedianMs: candidate.medianMs, candidateP95Ms: candidate.p95Ms,
  })),
}, null, 2));
