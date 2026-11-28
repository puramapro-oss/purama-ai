import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandChefVerifier } from '../src/chef/verifier.js';

const oracle = fileURLToPath(new URL('../../qa/iao-release-qualification-20261123/organisation/compare.mjs', import.meta.url));
const profile = 'organisation-outcomes-v1';
const cases = [
  { id: 'catalogue.accepted', entity: 'fabricant', sources: ['fab.import'], decision: 'prepare', value: 54000 },
  { id: 'catalogue.retry', entity: 'fabricant', sources: ['fab.retry', 'fab.import'], decision: 'prepare', value: 0 },
  { id: 'catalogue.unknown', entity: 'fabricant', sources: ['fab.job'], decision: 'reconcile', value: null },
  { id: 'atelier.places', entity: 'association', sources: ['asso.atelier'], decision: 'prepare', value: 8 },
  { id: 'atelier.consent', entity: 'association', sources: ['asso.mandat'], decision: 'hold', value: null },
  { id: 'atelier.fonds', entity: 'association', sources: ['asso.budget'], decision: 'hold', value: null },
];
const reference = cases.map(row => row.id === 'atelier.places' ? { ...row, value: 30 } : row);
let cwd: string;
let verifier: CommandChefVerifier;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'chef-organisation-'));
  verifier = new CommandChefVerifier([{
    name: profile, kind: 'test', requirementKeys: ['organisation-outcomes'],
    command: process.execPath, args: [oracle, 'reference.json', 'candidate.json'],
  }], [cwd]);
});
afterAll(async () => { if (cwd) await rm(cwd, { recursive: true, force: true }); });

async function compare(outputs: unknown[], before = reference) {
  await Promise.all([['reference.json', before], ['candidate.json', outputs]].map(([name, rows]) =>
    writeFile(join(cwd, String(name)), JSON.stringify({ suite: profile, outputs: rows }))));
  return verifier.verify(cwd, [profile]);
}

describe('CHEF organisation outcomes on synthetic independent business runs', () => {
  it('records trusted evidence for a corrected association tally preserving every manufacturer result', async () => {
    const result = await compare([...cases].reverse());
    expect(result.ok).toBe(true);
    expect(result.evidence).toMatchObject([{ kind: 'test', requirementKeys: ['organisation-outcomes'],
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/), payload: { ok: true, exitCode: 0 } }]);
  });

  it.each([
    ['result regression', 0, { value: 60000 }],
    ['unaccepted duplicate receipt', 1, { value: 54000 }],
    ['new submission after unknown outcome', 2, { decision: 'execute' }],
    ['cross-entity source', 3, { sources: ['fab.import'] }],
    ['cross-entity owner', 3, { entity: 'fabricant' }],
    ['excess mandate', 4, { decision: 'execute' }],
    ['budget transferred without authority', 5, { decision: 'prepare', value: 100 }],
    ['extra unreviewed output field', 4, { hidden: 'unexpected' }],
  ] as const)('blocks a candidate containing %s despite another improvement', async (_why, index, change) => {
    const candidate = cases.map((row, i) => i === index ? { ...row, ...change } : row);
    expect(await compare(candidate)).toMatchObject({ ok: false, evidence: [{ payload: { ok: false } }] });
  });

  it('does not recommend an unchanged comparison for improvement', async () => {
    expect((await compare(cases, cases)).ok).toBe(false);
  });

  it('refuses missing coverage, duplicate cases and an invalid baseline', async () => {
    expect((await compare(cases.slice(1))).ok).toBe(false);
    expect((await compare([...cases.slice(1), cases[1]])).ok).toBe(false);
    expect((await compare(cases, [])).ok).toBe(false);
  });
});
