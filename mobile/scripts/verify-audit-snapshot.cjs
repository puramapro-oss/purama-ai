'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const localPackages = {
  'compat/decode-uri-component': '@purama/decode-uri-component-compat',
  'compat/deepmerge': '@purama/expo-deepmerge-compat',
  'compat/image-size': '@purama/metro-image-size-compat',
};
const localLinks = {
  'node_modules/decode-uri-component': 'compat/decode-uri-component',
  'node_modules/deepmerge': 'compat/deepmerge',
  'node_modules/image-size': 'compat/image-size',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function registryPackageMultiset(lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('Unsupported lockfile; the audit snapshot cannot be reused.');
  }
  const rows = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location === '') continue;
    if (Object.hasOwn(localPackages, location)) {
      if (entry.name !== localPackages[location] || entry.version !== '1.0.0' || entry.resolved) {
        throw new Error('An admitted local adapter has changed its package identity.');
      }
      continue;
    }
    if (Object.hasOwn(localLinks, location) && entry.link === true && entry.resolved === localLinks[location]) {
      continue;
    }
    let resolved;
    try { resolved = new URL(entry.resolved); } catch { /* rejected below */ }
    if (!resolved || resolved.protocol !== 'https:' || resolved.hostname !== 'registry.npmjs.org' ||
        resolved.port || resolved.username || resolved.password || resolved.search || resolved.hash ||
        typeof entry.version !== 'string' || !entry.version ||
        typeof entry.integrity !== 'string' || !entry.integrity) {
      throw new Error('An unrecognized dependency is outside the audited registry graph.');
    }
    // npm aliases record the real upstream name in entry.name. Paths and
    // hoisting positions are excluded; duplicate package instances are kept.
    const name = entry.name || location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
    rows.push([name, entry.version, entry.resolved, entry.integrity]);
  }
  rows.sort((left, right) => {
    const a = JSON.stringify(left), b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return rows;
}

function verifyAuditSnapshot({ lock, snapshot, reportBytes, now = Date.now() }) {
  if (snapshot.schemaVersion !== 1 || snapshot.maximumAgeHours !== 24) {
    throw new Error('Unsupported audit snapshot policy.');
  }
  const capturedAt = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(capturedAt) || !Number.isFinite(now) || capturedAt > now) {
    throw new Error('The audit snapshot date is invalid or in the future.');
  }
  if (now - capturedAt >= MAX_AGE_MS) {
    throw new Error('The audit snapshot has expired (24 hours); an authorized audit renewal is required.');
  }
  if (sha256(reportBytes) !== snapshot.reportSha256) {
    throw new Error('The approved audit report hash does not match.');
  }
  const report = JSON.parse(reportBytes.toString('utf8'));
  const counts = report.metadata?.vulnerabilities;
  if (!counts || counts.high !== 0 || counts.critical !== 0) {
    throw new Error('The approved audit report does not satisfy high=0 and critical=0.');
  }
  const packages = registryPackageMultiset(lock);
  const digest = sha256(JSON.stringify(packages));
  if (packages.length !== snapshot.registryPackageInstances || digest !== snapshot.registryMultisetSha256) {
    throw new Error('The registry dependency graph differs from the approved audit snapshot.');
  }
  return {
    status: 'PASS', gate: 'audit snapshot binding — no registry request',
    auditAsOf: snapshot.capturedAt,
    expiresAt: new Date(capturedAt + MAX_AGE_MS).toISOString(),
    reportSha256: snapshot.reportSha256, registryMultisetSha256: digest,
    registryPackageInstances: packages.length, vulnerabilities: counts,
    limitation: 'Reuses the dated report. This is not a new registry audit or a native/store qualification.',
  };
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const result = verifyAuditSnapshot({
      lock: JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')),
      snapshot: JSON.parse(fs.readFileSync(path.join(root, 'qa/dependency-audit/snapshot.json'), 'utf8')),
      reportBytes: fs.readFileSync(path.join(root, 'qa/dependency-audit/approved-report.json')),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Audit snapshot binding failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { MAX_AGE_MS, registryPackageMultiset, verifyAuditSnapshot };
