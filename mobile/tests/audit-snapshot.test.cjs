const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { MAX_AGE_MS, verifyAuditSnapshot } = require('../scripts/verify-audit-snapshot.cjs');

const root = path.resolve(__dirname, '..');
function inputs() {
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'qa/dependency-audit/snapshot.json'), 'utf8'));
  return {
    lock: JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')),
    snapshot,
    reportBytes: fs.readFileSync(path.join(root, 'qa/dependency-audit/approved-report.json')),
    now: Date.parse(snapshot.capturedAt) + 60_000,
  };
}

test('the real audited graph remains identical after Babel preset relocation', () => {
  const input = inputs();
  const actual = verifyAuditSnapshot(input);
  const preset = input.lock.packages['node_modules/babel-preset-expo'];
  assert.equal(preset.version, '54.0.12');
  delete input.lock.packages['node_modules/babel-preset-expo'];
  input.lock.packages['node_modules/expo/node_modules/babel-preset-expo'] = preset;
  assert.deepEqual(verifyAuditSnapshot(input), actual);
  assert.equal(actual.status, 'PASS');
});

test('a registry version or integrity change is refused', () => {
  for (const field of ['version', 'integrity']) {
    const input = inputs();
    input.lock.packages['node_modules/expo'][field] += '-changed';
    assert.throws(() => verifyAuditSnapshot(input), /dependency graph differs/);
  }
});

test('duplicate registry instances are retained in the multiset', () => {
  const input = inputs();
  input.lock.packages['node_modules/fixture/node_modules/expo'] = structuredClone(input.lock.packages['node_modules/expo']);
  assert.throws(() => verifyAuditSnapshot(input), /dependency graph differs/);
});

test('npm aliases bind their real upstream name, independently of placement', () => {
  const input = inputs();
  const actual = verifyAuditSnapshot(input);
  const alias = input.lock.packages['node_modules/decode-uri-component-upstream'];
  assert.equal(alias.name, 'decode-uri-component');
  delete input.lock.packages['node_modules/decode-uri-component-upstream'];
  input.lock.packages['node_modules/another-alias'] = alias;
  assert.deepEqual(verifyAuditSnapshot(input), actual);
  alias.name = 'unapproved-upstream';
  assert.throws(() => verifyAuditSnapshot(input), /dependency graph differs/);
});

test('expired, invalid and future snapshot dates fail closed', () => {
  const expired = inputs();
  expired.now = Date.parse(expired.snapshot.capturedAt) + MAX_AGE_MS;
  assert.throws(() => verifyAuditSnapshot(expired), /expired/);
  const invalid = inputs(); invalid.snapshot.capturedAt = 'not-a-date';
  assert.throws(() => verifyAuditSnapshot(invalid), /invalid or in the future/);
  const future = inputs(); future.snapshot.capturedAt = new Date(future.now + 1).toISOString();
  assert.throws(() => verifyAuditSnapshot(future), /invalid or in the future/);
});

test('the approved report must match byte for byte', () => {
  const input = inputs();
  input.reportBytes = Buffer.concat([input.reportBytes, Buffer.from('\n')]);
  assert.throws(() => verifyAuditSnapshot(input), /report hash does not match/);
});

test('a report with high or critical vulnerabilities cannot pass the policy', () => {
  for (const severity of ['high', 'critical']) {
    const input = inputs();
    const report = JSON.parse(input.reportBytes); report.metadata.vulnerabilities[severity] = 1;
    input.reportBytes = Buffer.from(JSON.stringify(report));
    input.snapshot.reportSha256 = createHash('sha256').update(input.reportBytes).digest('hex');
    assert.throws(() => verifyAuditSnapshot(input), /does not satisfy high=0 and critical=0/);
  }
});

test('an unknown non-registry dependency cannot evade the binding', () => {
  const input = inputs();
  input.lock.packages['node_modules/unapproved'] = { version: '1.0.0', resolved: 'file:unapproved' };
  assert.throws(() => verifyAuditSnapshot(input), /outside the audited registry graph/);
});

test('the reviewed Expo merge guard and its upstream alias retain distinct identities', () => {
  const input = inputs();
  const adapter = input.lock.packages['compat/deepmerge'];
  assert.equal(adapter.name, '@purama/expo-deepmerge-compat');
  assert.deepEqual(adapter.dependencies, { 'deepmerge-upstream': 'npm:deepmerge@4.3.1' });
  assert.deepEqual(input.lock.packages['node_modules/deepmerge'], { resolved: 'compat/deepmerge', link: true });
  assert.equal(input.lock.packages['node_modules/deepmerge-upstream'].name, 'deepmerge');
  assert.equal(input.lock.packages['node_modules/deepmerge-upstream'].version, '4.3.1');
  assert.equal(verifyAuditSnapshot(input).status, 'PASS');
  adapter.name = 'unreviewed-package';
  assert.throws(() => verifyAuditSnapshot(input), /local adapter has changed/);
});
