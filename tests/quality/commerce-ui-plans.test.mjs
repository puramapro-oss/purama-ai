import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPlan, PLANS } from '../../src/lib/plans.ts';

for (const [input, expected] of [
  ['free', 'free'],
  ['starter', 'starter'],
  ['pro', 'pro'],
  ['ultime', 'ultime'],
  ['PRO', 'pro'],
  ['enterprise', 'ultime'],
  ['ENTERPRISE', 'ultime'],
  ['unknown', 'free'],
  ['', 'free'],
  [null, 'free'],
  [undefined, 'free'],
  ['__proto__', 'free'],
  ['constructor', 'free'],
  ['hasOwnProperty', 'free'],
  [42, 'free'],
  [{}, 'free'],
  [[], 'free'],
]) {
  test(`getPlan(${JSON.stringify(input)}) returns the canonical ${expected} plan`, () => {
    assert.equal(getPlan(input), PLANS[expected]);
  });
}
