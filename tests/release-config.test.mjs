import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === 'node_modules' || name === 'dist' || name === '.git') return [];
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function declaredVariables(path) {
  return new Set(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter(Boolean),
  );
}

function referencedVariables(directory, pattern) {
  const result = new Set();
  for (const path of filesUnder(directory)) {
    if (!/\.(?:ts|tsx|js|mjs)$/.test(path)) continue;
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(pattern)) result.add(match[1]);
  }
  return result;
}

test('all referenced web, mobile and Edge Function variables are documented', () => {
  const webRefs = referencedVariables(join(root, 'src'), /import\.meta\.env\.(VITE_[A-Z0-9_]+)/g);
  const mobileRefs = referencedVariables(join(root, 'mobile'), /process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)/g);
  const edgeRefs = referencedVariables(join(root, 'supabase/functions'), /Deno\.env\.get\(["']([A-Z][A-Z0-9_]*)["']\)/g);
  const webDeclared = declaredVariables(join(root, '.env.example'));
  const mobileDeclared = declaredVariables(join(root, 'mobile/.env.example'));
  const edgeDeclared = declaredVariables(join(root, 'supabase/functions/.env.example'));

  assert.deepEqual([...webRefs].filter((name) => !webDeclared.has(name)), []);
  assert.deepEqual([...mobileRefs].filter((name) => !mobileDeclared.has(name)), []);
  assert.deepEqual([...edgeRefs].filter((name) => !edgeDeclared.has(name)), []);
});

test('store privacy URLs target the application privacy route', () => {
  const storeConfig = JSON.parse(readFileSync(join(root, 'mobile/store-config/store.config.json'), 'utf8'));
  const serialized = JSON.stringify(storeConfig);
  assert.ok(!serialized.includes('/politique-confidentialite'));
  assert.ok(serialized.includes('/politique-de-confidentialite'));
});

test('release scripts referenced by CI exist', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const script of ['lint', 'typecheck', 'test:unit', 'test:security', 'test:release-config', 'test:ci', 'build']) {
    assert.equal(typeof pkg.scripts[script], 'string', `missing package script: ${script}`);
  }

  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm run test:ci/);
  assert.match(pkg.scripts['test:ci'], /--project=desktop/);
  assert.match(pkg.scripts['test:ci'], /--project=tablet/);
  assert.match(pkg.scripts['test:ci'], /--project=mobile/);
});

test('release UI does not reintroduce fabricated success data', () => {
  const sources = [
    'src/pages/AdminDashboard.tsx',
    'src/components/OriginForgeDemo.tsx',
    'src/pages/MyEmployees.tsx',
    'src/pages/CreatorAgentDetail.tsx',
    'src/components/onboarding/HireFirstEmployeeModal.tsx',
  ].map((path) => readFileSync(join(root, path), 'utf8')).join('\n');

  assert.doesNotMatch(sources, /\[MOCK\]|TODO_LIVE_TEST|SmartAssist|const revenueData|const trafficData|const planDistribution/);
});
