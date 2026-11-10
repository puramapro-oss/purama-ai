// Deployment copy of the existing private package; no second matching algorithm.
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = path.resolve(root, '../packages/purama-entraide');
const hashes = {
  'src/matching.ts': 'a81b93a2d14c5ebcc9fe3b2fa86eca982c04aeda30c1b6cd8e5f433b25b20e24',
};
for (const [file, expected] of Object.entries(hashes)) {
  const actual = createHash('sha256').update(await readFile(path.join(packageRoot, file))).digest('hex');
  if (actual !== expected) throw new Error(`Canonical source changed: review provenance before bundling ${file}`);
}
const provenance = '// Generated from @purama/entraide 0.1.0, puramapro-oss/purama-master@6e50837af08ad57d8db37077f0363b3e05289e31.\n' +
  '// Source SHA256 matching.ts: ' + hashes['src/matching.ts'] + '\n' +
  '// Rebuild: node scripts/build-entraide-matching.mjs. Do not edit the generated algorithm.\n';
const result = await build({
  entryPoints: [path.join(packageRoot, 'src/matching.ts')], bundle: true, write: false,
  format: 'esm', platform: 'neutral', target: 'es2022', legalComments: 'none',
  absWorkingDir: packageRoot,
});
const directory = path.join(root, 'supabase/functions/_shared/vendor');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'entraide-matching.js'), provenance + result.outputFiles[0].text);
