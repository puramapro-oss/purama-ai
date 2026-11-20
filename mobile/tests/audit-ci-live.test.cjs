'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MAX_AGE_MS } = require('../scripts/verify-audit-snapshot.cjs');
const { validateRecordedAudit, qualifyAudit } = require('../scripts/qualify-audit-ci.cjs');

const source = path.resolve(__dirname, '..');
const auditDir = 'qa/dependency-audit';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purama-audit-ci-'));
  fs.mkdirSync(path.join(root, auditDir), { recursive: true });
  for (const file of ['package-lock.json']) {
    fs.copyFileSync(path.join(source, file), path.join(root, file));
  }
  for (const file of ['snapshot.json', 'approved-report.json']) {
    fs.copyFileSync(path.join(source, auditDir, file), path.join(root, auditDir, file));
  }
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, auditDir, 'snapshot.json')));
  const reportBytes = fs.readFileSync(path.join(root, auditDir, 'approved-report.json'));
  const expiredAt = Date.parse(snapshot.capturedAt) + MAX_AGE_MS;
  return {
    root, snapshot, reportBytes, expiredAt,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    live: () => ({ status: 0, stdout: Buffer.from(reportBytes), stderr: Buffer.alloc(0) }),
  };
}

test('fresh approved snapshot passes without any registry call', t => {
  const f = fixture(); t.after(f.cleanup);
  const result = qualifyAudit({
    root: f.root, now: f.expiredAt - 1, allowLiveAudit: true,
    runAudit: () => { throw new Error('REGISTRY_MUST_NOT_BE_CALLED'); }, writeEvidence: false,
  });
  assert.equal(result.mode, 'approved_offline_snapshot');
  assert.equal(result.queriedRegistry, false);
});

test('exact expiry boundary refuses reuse of the recorded snapshot', t => {
  const f = fixture(); t.after(f.cleanup);
  const lock = JSON.parse(fs.readFileSync(path.join(f.root, 'package-lock.json')));
  assert.equal(validateRecordedAudit({
    lock, snapshot: f.snapshot, reportBytes: f.reportBytes, now: f.expiredAt,
  }).expired, true);
});

test('expired proof cannot silently authorize network access', t => {
  const f = fixture(); t.after(f.cleanup);
  assert.throws(() => qualifyAudit({
    root: f.root, now: f.expiredAt + 1000, allowLiveAudit: false,
    runAudit: () => { throw new Error('UNAUTHORIZED'); }, writeEvidence: false,
  }), /explicit live registry audit authorization/);
});

test('authorized fallback passes only with an actual clean audit result structure', t => {
  const f = fixture(); t.after(f.cleanup);
  let calls = 0;
  const result = qualifyAudit({
    root: f.root, now: f.expiredAt + 1000, allowLiveAudit: true,
    runAudit: () => { calls++; return f.live(); }, writeEvidence: false,
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'PASS');
  assert.equal(result.mode, 'fresh_registry_audit');
  assert.equal(result.queriedRegistry, true);
  assert.equal(result.reportSha256, sha(f.reportBytes));
  assert.equal(result.registryPackageInstances, 876);
  assert.equal(fs.existsSync(path.join(f.root, 'qa-results')), false);
});

test('invalid archived report hash never triggers live-audit fallback', t => {
  const f = fixture(); t.after(f.cleanup);
  fs.appendFileSync(path.join(f.root, auditDir, 'approved-report.json'), '\n');
  assert.throws(() => qualifyAudit({
    root: f.root, now: f.expiredAt + 1000, allowLiveAudit: true,
    runAudit: () => { throw new Error('UNSAFE_FALLBACK'); },
    writeEvidence: false,
  }), /Recorded report bytes do not match/);
});

test('unapproved changes to the registry graph cannot be requalified automatically', t => {
  const f = fixture(); t.after(f.cleanup);
  const file = path.join(f.root, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(file));
  lock.packages['node_modules/expo'].version += '-unapproved';
  fs.writeFileSync(file, JSON.stringify(lock));
  assert.throws(() => qualifyAudit({
    root: f.root, now: f.expiredAt + 1000, allowLiveAudit: true,
    runAudit: () => { throw new Error('UNSAFE_FALLBACK'); }, writeEvidence: false,
  }), /Recorded dependency graph does not match/);
});

test('unsafe historical report never becomes authorization for a new audit', t => {
  const f = fixture(); t.after(f.cleanup);
  const report = JSON.parse(f.reportBytes); report.metadata.vulnerabilities.high = 1;
  const bytes = Buffer.from(JSON.stringify(report));
  fs.writeFileSync(path.join(f.root, auditDir, 'approved-report.json'), bytes);
  f.snapshot.reportSha256 = sha(bytes);
  fs.writeFileSync(path.join(f.root, auditDir, 'snapshot.json'), JSON.stringify(f.snapshot));
  assert.throws(() => qualifyAudit({
    root: f.root, now: f.expiredAt + 1000, allowLiveAudit: true,
    runAudit: () => { throw new Error('UNSAFE_FALLBACK'); }, writeEvidence: false,
  }), /unapproved high or critical/);
});

test('nonzero npm audit exit, empty report and aborted request fail closed', t => {
  const f = fixture(); t.after(f.cleanup);
  for (const response of [
    { status: 1, stdout: f.reportBytes },
    { status: 0, stdout: Buffer.alloc(0) },
    { status: 0, stdout: f.reportBytes, signal: 'SIGTERM' },
    { status: null, stdout: f.reportBytes, error: new Error('ECONNRESET') },
  ]) {
    assert.throws(() => qualifyAudit({
      root: f.root, now: f.expiredAt + 1000,
      allowLiveAudit: true, runAudit: () => response, writeEvidence: false,
    }), /did not complete successfully/);
  }
});

test('high or critical vulnerabilities from a live registry response fail closed', t => {
  const f = fixture(); t.after(f.cleanup);
  for (const severity of ['high', 'critical']) {
    const report = JSON.parse(f.reportBytes);
    report.metadata.vulnerabilities[severity] = 1;
    assert.throws(() => qualifyAudit({
      root: f.root, now: f.expiredAt + 1000, allowLiveAudit: true,
      runAudit: () => ({ status: 0, stdout: Buffer.from(JSON.stringify(report)) }),
      writeEvidence: false,
    }), /Live registry audit reports high or critical/);
  }
});

test('malformed live JSON cannot pass under an exit-zero wrapper', t => {
  const f = fixture(); t.after(f.cleanup);
  assert.throws(() => qualifyAudit({
    root: f.root, now: f.expiredAt + 1000, allowLiveAudit: true,
    runAudit: () => ({ status: 0, stdout: Buffer.from('not json') }), writeEvidence: false,
  }), SyntaxError);
});

test('lockfile mutation during an audit invalidates its evidence', t => {
  const f = fixture(); t.after(f.cleanup);
  assert.throws(() => qualifyAudit({
    root: f.root, now: f.expiredAt + 1000, allowLiveAudit: true,
    runAudit: () => {
      fs.appendFileSync(path.join(f.root, 'package-lock.json'), ' ');
      return f.live();
    },
    writeEvidence: false,
  }), /lock changed while the registry audit was running/);
});

test('successful authorized live audit writes evidence without changing approved files', t => {
  const f = fixture(); t.after(f.cleanup);
  const recordedBefore = sha(fs.readFileSync(path.join(f.root, auditDir, 'snapshot.json')));
  const reportBefore = sha(fs.readFileSync(path.join(f.root, auditDir, 'approved-report.json')));
  const result = qualifyAudit({
    root: f.root, now: f.expiredAt + 1000, allowLiveAudit: true,
    runAudit: f.live, writeEvidence: true,
  });
  const stored = JSON.parse(fs.readFileSync(path.join(f.root, 'qa-results/live-registry-verification.json')));
  assert.equal(stored.mode, 'fresh_registry_audit');
  assert.equal(stored.reportSha256, sha(fs.readFileSync(path.join(f.root, 'qa-results/live-registry-audit.json'))));
  assert.equal(result.reportSha256, stored.reportSha256);
  assert.equal(sha(fs.readFileSync(path.join(f.root, auditDir, 'snapshot.json'))), recordedBefore);
  assert.equal(sha(fs.readFileSync(path.join(f.root, auditDir, 'approved-report.json'))), reportBefore);
});
