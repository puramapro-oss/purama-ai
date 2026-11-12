import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const sourceRoot = new URL('../../', import.meta.url);
const fixturePaths = ['scripts/check-offline-assets.mjs', 'public/sw.js', 'public/offline.html', 'public/offline-workspace.js', 'public/offline-library-backup.js', 'public/manifest.json'];
const sourceFiles = await Promise.all(fixturePaths.map(async (path) => ({
  path, bytes: await readFile(new URL(path, sourceRoot)),
})));
const manifestPattern = /\/\/ BEGIN OFFLINE ASSET MANIFEST\n[\s\S]*?\/\/ END OFFLINE ASSET MANIFEST/g;
const markerPattern = /^\/\/ OFFLINE ASSET CACHE VERSION:.*\n/gm;

function runCheck(directory, ...args) {
  const result = spawnSync(process.execPath, [join(directory, 'scripts/check-offline-assets.mjs'), ...args], {
    cwd: directory, encoding: 'utf8', timeout: 10_000, maxBuffer: 512 * 1024,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, 'The verifier must complete normally');
  return result;
}

function expectSuccess(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'purama-offline-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of sourceFiles) {
    const path = join(directory, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
  }
  // The real, unchanged release can be bootstrapped once if it lacks the new marker.
  expectSuccess(runCheck(directory, '--write'));
  expectSuccess(runCheck(directory));
  return directory;
}

const workerBytes = (directory) => readFile(join(directory, 'public/sw.js'));

async function currentVersionNumber(directory) {
  const source = (await workerBytes(directory)).toString('utf8');
  const match = /const CACHE_NAME = 'purama-offline-v([1-9][0-9]*)';/.exec(source);
  assert.ok(match, 'Fixture must declare a canonical positive version');
  return BigInt(match[1]);
}

async function changeVersion(directory, name, paths = ['public/sw.js', 'public/offline-workspace.js']) {
  for (const relativePath of paths) {
    const path = join(directory, relativePath);
    const source = await readFile(path, 'utf8');
    const declarations = source.match(/const CACHE_NAME = '[^']+';/g);
    assert.equal(declarations?.length, 1);
    await writeFile(path, source.replace(declarations[0], `const CACHE_NAME = '${name}';`));
  }
}

async function appendTo(directory, relativePath, suffix) {
  const path = join(directory, relativePath);
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(suffix)]));
}

async function expectRefusalWithoutWrite(directory, message) {
  const before = await workerBytes(directory);
  const result = runCheck(directory, '--write');
  assert.equal(result.status, 1, 'The verifier must reject the proposed regeneration');
  assert.match(result.stderr, message);
  assert.deepEqual(await workerBytes(directory), before, 'Rejected regeneration must not alter any worker byte');
}

test('accepts an unchanged release and leaves repeated checks and regeneration byte-identical', async (t) => {
  const directory = await createFixture(t);
  const before = await workerBytes(directory);
  expectSuccess(runCheck(directory));
  expectSuccess(runCheck(directory, '--write'));
  assert.deepEqual(await workerBytes(directory), before);
});

for (const [path, suffix] of [
  ['public/offline-workspace.js', '\n// Changed release content without a version increase.\n'],
  ['public/offline-library-backup.js', '\n// A changed backup module is a new offline release.\n'],
  ['public/offline.html', '\n<!-- Changed release content without a version increase. -->\n'],
  ['public/manifest.json', '\n'],
]) {
  test(`rejects changed ${path} at the same version before writing the worker`, async (t) => {
    const directory = await createFixture(t);
    await appendTo(directory, path, suffix);
    await expectRefusalWithoutWrite(directory, /resources changed without a newer cache version/i);
  });
}

test('accepts a strictly higher shared version and only regenerates its manifest block', async (t) => {
  const directory = await createFixture(t);
  const nextVersion = `purama-offline-v${(await currentVersionNumber(directory)) + 2n}`;
  await changeVersion(directory, nextVersion);
  await appendTo(directory, 'public/offline.html', '\n<!-- A new version may contain changed resources. -->\n');
  const before = (await workerBytes(directory)).toString('utf8');
  expectSuccess(runCheck(directory, '--write'));
  expectSuccess(runCheck(directory));
  const after = (await workerBytes(directory)).toString('utf8');
  assert.ok(after.includes(`// OFFLINE ASSET CACHE VERSION: ${nextVersion}\n`));
  assert.equal(after.replace(manifestPattern, '<manifest>'), before.replace(manifestPattern, '<manifest>'));
});

test('rejects decreasing the shared version even when regenerating hashes was requested', async (t) => {
  const directory = await createFixture(t);
  const version = await currentVersionNumber(directory);
  assert.ok(version > 1n, 'This release has a prior positive version to test');
  await changeVersion(directory, `purama-offline-v${version - 1n}`);
  await expectRefusalWithoutWrite(directory, /cache version cannot decrease/i);
});

for (const name of ['purama-offline-v0', 'purama-offline-v03', 'purama-offline-vnext', 'another-cache-v4']) {
  test(`rejects invalid cache version ${name}`, async (t) => {
    const directory = await createFixture(t);
    await changeVersion(directory, name);
    await expectRefusalWithoutWrite(directory, /invalid worker cache version/i);
  });
}

test('rejects different worker and workspace versions before writing the worker', async (t) => {
  const directory = await createFixture(t);
  const nextVersion = `purama-offline-v${(await currentVersionNumber(directory)) + 1n}`;
  await changeVersion(directory, nextVersion, ['public/offline-workspace.js']);
  await expectRefusalWithoutWrite(directory, /must use the same cache version/i);
});

test('bootstraps a missing version marker only while the recorded resources remain unchanged', async (t) => {
  const directory = await createFixture(t);
  const path = join(directory, 'public/sw.js');
  const source = await readFile(path, 'utf8');
  await writeFile(path, source.replace(markerPattern, ''));
  expectSuccess(runCheck(directory, '--write'));
  expectSuccess(runCheck(directory));
  assert.equal(await readFile(path, 'utf8'), source);
});

test('rejects bootstrap without a marker when the recorded resources have changed', async (t) => {
  const directory = await createFixture(t);
  const path = join(directory, 'public/sw.js');
  await writeFile(path, (await readFile(path, 'utf8')).replace(markerPattern, ''));
  await appendTo(directory, 'public/offline-workspace.js', '\n// Not the recorded bootstrap content.\n');
  await expectRefusalWithoutWrite(directory, /cannot bootstrap a versionless manifest after its resources changed/i);
});

test('rejects an invalid recorded version instead of treating it as an unversioned bootstrap', async (t) => {
  const directory = await createFixture(t);
  const path = join(directory, 'public/sw.js');
  const source = await readFile(path, 'utf8');
  await writeFile(path, source.replace(markerPattern, '// OFFLINE ASSET CACHE VERSION: purama-offline-v0\n'));
  await expectRefusalWithoutWrite(directory, /invalid recorded manifest cache version/i);
});

test('rejects duplicate version markers before regenerating the manifest', async (t) => {
  const directory = await createFixture(t);
  const path = join(directory, 'public/sw.js');
  const source = await readFile(path, 'utf8');
  await writeFile(path, source.replace(markerPattern, '$&$&'));
  await expectRefusalWithoutWrite(directory, /at most one offline manifest cache version marker/i);
});
