import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifestVersionPrefix = '// OFFLINE ASSET CACHE VERSION:';
const assets = [
  { path: '/offline.html', types: ['text/html'] },
  { path: '/offline-workspace.js', types: ['text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript'] },
  { path: '/offline-library-backup.js', types: ['text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript'] },
  { path: '/manifest.json', types: ['application/json', 'application/manifest+json'] },
];
const manifest = await Promise.all(assets.map(async (asset) => {
  const bytes = await readFile(new URL(`public${asset.path}`, root));
  return { ...asset, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
const path = new URL('public/sw.js', root);
const source = await readFile(path, 'utf8');
const pattern = /\/\/ BEGIN OFFLINE ASSET MANIFEST\n[\s\S]*?\/\/ END OFFLINE ASSET MANIFEST/g;
const matches = source.match(pattern);
if (matches?.length !== 1) throw new Error('Expected exactly one offline asset manifest in public/sw.js');
const workspace = await readFile(new URL('public/offline-workspace.js', root), 'utf8');

function parseVersion(value, label) {
  const match = /^purama-offline-v([1-9][0-9]*)$/.exec(value);
  if (!match) throw new Error(`Invalid ${label}: expected purama-offline-vN with a positive canonical integer`);
  return { name: value, number: BigInt(match[1]) };
}

function sourceVersion(text, label) {
  const declarations = [...text.matchAll(/^[\t ]*const CACHE_NAME = '([^']+)';$/gm)];
  if (declarations.length !== 1) throw new Error(`Expected exactly one CACHE_NAME declaration in ${label}`);
  return parseVersion(declarations[0][1], `${label} cache version`);
}

function recordedManifest(block) {
  const declarations = [...block.matchAll(/(?:^|\n)const OFFLINE_ASSETS = (\[[\s\S]*?\]);(?:\n|$)/g)];
  if (declarations.length !== 1) throw new Error('Expected exactly one JSON offline asset declaration');
  let records;
  try { records = JSON.parse(declarations[0][1]); }
  catch (_) { throw new Error('Recorded offline asset manifest is not valid JSON'); }
  if (!Array.isArray(records) || records.length === 0 || records.some((asset) =>
    !asset || typeof asset !== 'object' || Array.isArray(asset)
    || typeof asset.path !== 'string' || !asset.path.startsWith('/')
    || !Array.isArray(asset.types) || asset.types.length === 0
    || asset.types.some((type) => typeof type !== 'string' || !type)
    || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0
    || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256))) {
    throw new Error('Recorded offline asset descriptors are invalid');
  }
  if (new Set(records.map((asset) => asset.path)).size !== records.length) {
    throw new Error('Recorded offline asset paths must be unique');
  }
  // Compare the descriptor values independently of JSON property ordering.
  return records.map(({ path, types, bytes, sha256 }) => ({ path, types, bytes, sha256 }));
}

const currentVersion = sourceVersion(source, 'worker');
const workspaceVersion = sourceVersion(workspace, 'workspace');
if (currentVersion.name !== workspaceVersion.name) {
  throw new Error('Offline workspace and worker must use the same cache version');
}

const previousBlock = matches[0];
const previousManifest = recordedManifest(previousBlock);
const descriptorsChanged = JSON.stringify(previousManifest) !== JSON.stringify(manifest);
const versionMarkers = previousBlock.split('\n').filter((line) => line.startsWith(manifestVersionPrefix));
if (versionMarkers.length > 1) throw new Error('Expected at most one offline manifest cache version marker');
const previousVersion = versionMarkers.length === 1
  ? parseVersion(versionMarkers[0].slice(manifestVersionPrefix.length).trim(), 'recorded manifest cache version')
  : null;

if (!previousVersion && descriptorsChanged) {
  throw new Error('Cannot bootstrap a versionless manifest after its resources changed. Restore the recorded resources before adding the version marker.');
}
if (previousVersion && currentVersion.number < previousVersion.number) {
  throw new Error('Offline cache version cannot decrease or reuse an older release version');
}
if (previousVersion && descriptorsChanged && currentVersion.number <= previousVersion.number) {
  throw new Error('Offline resources changed without a newer cache version. Increase both CACHE_NAME versions before regenerating the manifest.');
}

const block = `// BEGIN OFFLINE ASSET MANIFEST\n${manifestVersionPrefix} ${currentVersion.name}\nconst OFFLINE_ASSETS = ${JSON.stringify(manifest, null, 2)};\n// END OFFLINE ASSET MANIFEST`;
const next = source.replace(pattern, block);
if (process.argv.includes('--write')) {
  if (source !== next) await writeFile(path, next);
  console.log(`Offline asset manifest verified and recorded for ${currentVersion.name}.`);
} else if (source !== next) {
  throw new Error('Offline asset manifest is not current. Run npm run prepare:offline-assets after checking the release version, before building.');
} else {
  console.log(`PASS — ${manifest.length} offline assets match their exact release sizes and SHA-256 hashes for ${currentVersion.name}.`);
}
