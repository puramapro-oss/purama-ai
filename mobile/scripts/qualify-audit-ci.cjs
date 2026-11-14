'use strict';

const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_AGE_MS,
  registryPackageMultiset,
  verifyAuditSnapshot,
} = require('./verify-audit-snapshot.cjs');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = reason => { throw new Error('AUDIT_REQUALIFICATION: ' + reason); };

/**
 * Independently check the recorded evidence BEFORE deciding whether it is
 * expired. An invalid hash, unapproved dependency or vulnerable old report
 * must not become permission for the live-audit fallback.
 */
function validateRecordedAudit({ lock, snapshot, reportBytes, now }) {
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.maximumAgeHours !== 24) {
    return fail('Unsupported recorded audit policy.');
  }
  const capturedAt = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(now) || !Number.isFinite(capturedAt) || capturedAt > now) {
    return fail('Invalid, future or untrusted recorded audit time.');
  }
  if (sha256(reportBytes) !== snapshot.reportSha256) {
    return fail('Recorded report bytes do not match their approved digest.');
  }
  const report = JSON.parse(reportBytes.toString('utf8'));
  const counts = report.metadata?.vulnerabilities;
  if (!counts || counts.high !== 0 || counts.critical !== 0) {
    return fail('Recorded report has unapproved high or critical vulnerabilities.');
  }
  const packages = registryPackageMultiset(lock);
  const digest = sha256(Buffer.from(JSON.stringify(packages)));
  if (packages.length !== snapshot.registryPackageInstances || digest !== snapshot.registryMultisetSha256) {
    return fail('Recorded dependency graph does not match this exact lock.');
  }
  if (now - capturedAt >= MAX_AGE_MS) {
    return { expired: true, recordedAt: snapshot.capturedAt, multisetDigest: digest,
      registryPackageInstances: packages.length };
  }
  return { expired: false,
    verification: verifyAuditSnapshot({ lock, snapshot, reportBytes, now }) };
}

function runRealRegistryAudit(root) {
  return spawnSync('npm', ['audit', '--audit-level=high', '--json'], {
    cwd: root,
    env: { ...process.env, npm_config_audit: 'true', npm_config_offline: 'false' },
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
}

/**
 * Default execution remains a strictly offline, approved snapshot check.
 * CI may explicitly authorize a real registry query when (and only when)
 * the recorded graph is valid but its 24-hour proof has expired.
 * No timestamp, approved report, snapshot, lockfile or package is rewritten.
 */
function qualifyAudit({
  root = path.resolve(__dirname, '..'),
  now = Date.now(),
  allowLiveAudit = false,
  runAudit = runRealRegistryAudit,
  writeEvidence = true,
} = {}) {
  const lockPath = path.join(root, 'package-lock.json');
  const lockBytes = fs.readFileSync(lockPath);
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const snapshot = JSON.parse(fs.readFileSync(
    path.join(root, 'qa/dependency-audit/snapshot.json'), 'utf8'));
  const recordedBytes = fs.readFileSync(path.join(root, 'qa/dependency-audit/approved-report.json'));
  const recorded = validateRecordedAudit({ lock, snapshot, reportBytes: recordedBytes, now });

  if (!recorded.expired) {
    return { ...recorded.verification, mode: 'approved_offline_snapshot',
      queriedRegistry: false };
  }
  if (allowLiveAudit !== true) {
    return fail('Snapshot expired: explicit live registry audit authorization is required.');
  }

  const response = runAudit(root);
  if (!response || response.error || response.signal || response.status !== 0
      || !Buffer.isBuffer(response.stdout) || response.stdout.length === 0) {
    return fail('Live npm registry audit did not complete successfully.');
  }
  if (sha256(fs.readFileSync(lockPath)) !== sha256(lockBytes)) {
    return fail('The dependency lock changed while the registry audit was running.');
  }

  const freshBytes = response.stdout;
  const freshReport = JSON.parse(freshBytes.toString('utf8'));
  const counts = freshReport.metadata?.vulnerabilities;
  if (!counts || counts.high !== 0 || counts.critical !== 0) {
    return fail('Live registry audit reports high or critical vulnerabilities.');
  }
  const packages = registryPackageMultiset(lock);
  const finishedAt = Date.now();
  const ephemeralSnapshot = {
    schemaVersion: 1,
    capturedAt: new Date(finishedAt).toISOString(),
    maximumAgeHours: 24,
    reportSha256: sha256(freshBytes),
    registryMultisetSha256: sha256(Buffer.from(JSON.stringify(packages))),
    registryPackageInstances: packages.length,
  };
  const proof = verifyAuditSnapshot({
    lock, snapshot: ephemeralSnapshot, reportBytes: freshBytes, now: finishedAt,
  });
  const result = {
    status: proof.status,
    gate: 'authorized fresh npm registry audit of the recorded lock',
    mode: 'fresh_registry_audit',
    queriedRegistry: true,
    auditAsOf: ephemeralSnapshot.capturedAt,
    lockSha256: sha256(lockBytes),
    reportSha256: ephemeralSnapshot.reportSha256,
    registryMultisetSha256: ephemeralSnapshot.registryMultisetSha256,
    registryPackageInstances: packages.length,
    vulnerabilities: counts,
    previousSnapshotExpiredAt: new Date(Date.parse(snapshot.capturedAt) + MAX_AGE_MS).toISOString(),
    limitation: 'Real registry audit for this lock only; no native-device, signing or store qualification.',
  };

  if (writeEvidence) {
    const dir = path.join(root, 'qa-results');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'live-registry-audit.json'), freshBytes);
    fs.writeFileSync(path.join(dir, 'live-registry-verification.json'),
      JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(qualifyAudit({
      allowLiveAudit: process.env.PURAMA_ALLOW_LIVE_AUDIT === '1',
    }), null, 2));
  } catch (error) {
    console.error('Audit qualification failed: ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = { validateRecordedAudit, qualifyAudit };
