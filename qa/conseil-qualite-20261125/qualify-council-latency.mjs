// Node 24+. Run from the repository root or supply --checkout=/absolute/path.
// --out=/absolute/path/report.json is required. Override --baseline=<sha> and
// --candidate=<sha> to reproduce a comparison after branches move. The default
// candidate is the working tree. --baseline-only runs three smoke trials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

function argument(name) {
  return process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
}
const checkout = resolve(argument('--checkout') ?? '.');
const baseline = argument('--baseline') ?? '36a07d9ec13d2787c88af60438f24882161abd98';
const candidate = argument('--candidate');
const destination = argument('--out');
assert.ok(destination, 'Specify --out=/path/to/report.json');
const smoke = process.argv.includes('--baseline-only');
const repetitions = smoke ? 3 : 20;
const entry = 'karta/src/claude/consultation.ts';
const names = ['principal', 'relecteur-a', 'relecteur-b'];
const conclusion = {
  answer: 'Les données de référence indiquent B.',
  citedSourceIds: [],
  disagreements: ['La proposition A dépend du contexte.'],
  uncertainties: ['La portée du calcul est bornée au jeu de test.'],
};
const partialAnswer = 'Les informations de la question permettent seulement un constat partiel.';
const cases = {
  head_wait: [96, 8, 90],
  balanced: [48, 48, 48],
  second_wait: [8, 90, 96],
  tail_wait: [8, 8, 96],
};
const critiqueMs = 21;
const synthesisMs = 13;
const hash = value => createHash('sha256').update(value).digest('hex');

async function loadEngine(revision, directory) {
  const hashes = {};
  function copy(module) {
    if (Object.hasOwn(hashes, module)) return;
    assert.ok(module.startsWith('karta/src/') && module.endsWith('.ts'), 'Unexpected dependency: ' + module);
    const original = revision
      ? execFileSync('git', ['show', revision + ':' + module], {cwd: checkout, encoding: 'utf8'})
      : readFileSync(join(checkout, module), 'utf8');
    hashes[module] = hash(original);
    const code = stripTypeScriptTypes(original);
    const output = join(directory, module.slice(0, -3) + '.js');
    mkdirSync(dirname(output), {recursive: true});
    writeFileSync(output, code);
    // Follow the static relative imports that remain after type-only imports disappear.
    for (const [, file] of code.matchAll(/\b(?:from\s+|import\s*)["'](\.{1,2}\/[^"']+\.js)["']/g)) {
      copy(posix.join(posix.dirname(module), file.slice(0, -3) + '.ts'));
    }
  }
  copy(entry);
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
  const imported = await import(pathToFileURL(join(directory, entry.slice(0, -3) + '.js')));
  return {run: imported.runModelConsultation, hashes};
}

const proposals = names.map((model, index) => ({
  label: 'proposal-' + (index + 1), text: 'proposition ' + model,
}));
const critiques = names.slice(1).map((model, index) => ({
  label: 'critique-' + (index + 1), text: 'critique ' + model,
}));

async function exercise(engine, proposalDelays, operationId, failAllProposals = false) {
  const events = [];
  const record = (event, model, phase) => events.push({event, model, phase, time: performance.now()});
  const records = (event, phase) => events.filter(row => row.event === event && (!phase || row.phase === phase));
  let active = 0;
  let peak = 0;
  const question = 'Comparer les propositions pour les données de référence.';
  const request = {
    operationId, userId: 'utilisateur-mesure', question,
    preferences: {model: names[0], reflection: 'deep', speed: 'standard'},
    reviewerModels: names.slice(1),
  };
  const models = names.map((model, index) => ({
    model, provider: 'transport-controle',
    client: {
      isMock: false,
      async decide(input) {
        const final = Object.hasOwn(input.context, 'unavailableCalls');
        const phase = final ? 'synthesis' : Object.hasOwn(input.context, 'opinions') ? 'critique' : 'proposal';
        active++;
        peak = Math.max(peak, active);
        record('start', model, phase);
        try {
          assert.deepEqual(input.tools, []);
          if (!failAllProposals && phase === 'critique') assert.deepEqual(input.context.opinions, proposals);
          if (final) {
            assert.equal(model, names[0]);
            if (!failAllProposals) assert.deepEqual(input.context.opinions, [...proposals, ...critiques]);
          }
          await delay(phase === 'synthesis' ? synthesisMs : phase === 'critique' ? critiqueMs : proposalDelays[index]);
          if (failAllProposals && phase === 'proposal') throw new Error('Réponse de proposition indisponible.');
          const answer = failAllProposals ? {...conclusion, answer: partialAnswer} : conclusion;
          const summary = final ? JSON.stringify(answer) : (phase === 'critique' ? 'critique ' : 'proposition ') + model;
          return {summary, toolCalls: [], requiresApproval: false, mock: false};
        } finally {
          active--;
          record('finish', model, phase);
        }
      },
    },
  }));
  const dependencies = {
    catalog: names.map(model => ({model, maxOutputTokens: 16_384, reasoning: 'budget'})),
    models,
    admission: {
      claim: async () => { record('claim'); return true; },
      reserve: async call => { record('reserve', call.model, call.kind); return true; },
      settle: async receipt => { record('settle', receipt.call.model, receipt.call.kind); },
    },
  };
  const start = performance.now();
  const result = await engine(request, dependencies);
  const totalMs = performance.now() - start;
  const calls = records('start').length;
  const settlements = records('settle').length;

  assert.equal(active, 0);
  assert.equal(peak, 2);
  assert.equal(records('claim').length, 1);
  assert.equal(records('reserve').length, calls);
  assert.equal(settlements, calls);
  assert.equal(result.verificationStatus, 'unverified');
  assert.equal(records('start', 'proposal').length, 3);
  assert.equal(records('start', 'synthesis').length, 1);
  if (failAllProposals) {
    assert.equal(result.status, 'partial');
    assert.equal(result.reason, 'some_calls_unavailable');
    assert.equal(result.answer, partialAnswer);
  } else {
    assert.equal(result.status, 'complete');
    assert.equal(calls, 6);
    assert.equal(records('start', 'critique').length, 2);
    assert.ok(records('start', 'critique')[0].time >= records('settle', 'proposal').at(-1).time);
    assert.ok(records('start', 'synthesis')[0].time >= records('settle', 'critique').at(-1).time);
    assert.ok(result.receipts.every(receipt => receipt.status === 'completed'));
    for (const [field, expected] of Object.entries(conclusion)) assert.deepEqual(result[field], expected);
  }
  const proposalsMs = records('settle', 'proposal').at(-1).time - records('start', 'proposal')[0].time;
  return {totalMs, proposalsMs, peak, calls, settlements, status: result.status, signature: hash(JSON.stringify(result))};
}

function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  return {
    median: (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2,
    p95: sorted[Math.ceil(.95 * sorted.length) - 1],
  };
}

const temporary = mkdtempSync(join(tmpdir(), 'purama-council-latency-'));
try {
  const labels = smoke ? ['before'] : ['before', 'after'];
  const versions = {};
  for (const label of labels) {
    versions[label] = await loadEngine(label === 'before' ? baseline : candidate, join(temporary, label));
    await exercise(versions[label].run, [1, 1, 1], 'warmup');
  }
  if (!smoke) assert.notEqual(versions.before.hashes[entry], versions.after.hashes[entry], 'Candidate unchanged');
  const raw = {};
  const summary = {};
  for (const [name, delays] of Object.entries(cases)) {
    const pairs = [];
    for (let i = 0; i < repetitions; i++) {
      const pair = {};
      for (const label of (i % 2 ? [...labels].reverse() : labels)) {
        pair[label] = await exercise(versions[label].run, delays, 'operation-' + name + '-' + i);
      }
      if (!smoke) assert.equal(pair.before.signature, pair.after.signature, 'Result or receipts changed');
      pairs.push(pair);
    }
    raw[name] = pairs;
    summary[name] = {};
    for (const label of labels) {
      summary[name][label] = {
        proposalsMs: quantiles(pairs.map(pair => pair[label].proposalsMs)),
        totalMs: quantiles(pairs.map(pair => pair[label].totalMs)),
      };
    }
    if (!smoke) {
      summary[name].pairedTotalReductionPercent = quantiles(pairs.map(pair => 100 * (1 - pair.after.totalMs / pair.before.totalMs)));
    }
  }
  const failure = {};
  for (const label of labels) {
    const observed = await exercise(versions[label].run, [1, 1, 1], 'propositions-unavailable', true);
    assert.equal(observed.calls, label === 'before' ? 6 : 4);
    failure[label] = {calls: observed.calls, settlements: observed.settlements, status: observed.status};
  }
  const report = {
    baseline, candidate: candidate ?? 'working tree (see source hashes)', node: process.version, repetitions,
    method: 'Alternating paired requests after warm-up. Fixed transport delays, three models, two concurrent calls. p95 uses nearest rank.',
    fixture: {proposalMs: cases, critiqueMs, synthesisMs},
    sourceSha256: Object.fromEntries(labels.map(label => [label, versions[label].hashes])),
    summary, failure, raw,
  };
  mkdirSync(dirname(resolve(destination)), {recursive: true});
  writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({summary, failure}, null, 2));
} finally {
  rmSync(temporary, {recursive: true, force: true});
}
