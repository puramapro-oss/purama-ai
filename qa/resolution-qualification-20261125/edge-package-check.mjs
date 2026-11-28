import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Static receipt only: inspect source ASTs without importing product modules,
// fetching dependencies, building a bundle or accessing a running container.
// From the repository root: node qa/resolution-qualification-20261125/edge-package-check.mjs
const here = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(resolve(here, '../..'));
const receiptPath = join(here, 'edge-package-check.json');
const scriptPath = relative(root, fileURLToPath(import.meta.url)).split(sep).join('/');
const entries = ['creator-agent-chat', 'creator-agent-generate', 'karta-trigger-custom']
  .map(name => `supabase/functions/${name}/index.ts`);
const mounts = [
  { source: 'supabase/functions', target: '/home/deno/functions', mode: 'read_only' },
  { source: 'karta/src', target: '/home/karta/src', mode: 'read_only' },
];
const expectedLeaves = ['karta/src/claude/assistant-policy.ts', 'karta/src/knowledge/private-result-view.ts'];
const modules = new Map();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const contained = (parent, child) => {
  const suffix = relative(parent, child);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
};
const sourcePath = file => relative(root, file).split(sep).join('/');
const receipt = {
  schemaVersion: 1, status: 'RUNNING', proofKind: 'STATIC_PACKAGE_LAYOUT', startedAt: new Date().toISOString(),
  proposedMounts: mounts, entries, checks: [], sourceSha256: {},
  limits: [
    'The virtual mounts are a proposed package contract, not observed container mounts.',
    'No Deno typecheck, module execution, remote import resolution or network request.',
    'No package copy, generated business bundle, Hostinger configuration change or deployment.',
    'Working-tree SHA-256 values identify the inspected bytes; git HEAD alone does not identify uncommitted content.',
  ],
};

function readModule(file) {
  const physical = realpathSync(file);
  assert.ok(mounts.some(mount => contained(realpathSync(resolve(root, mount.source)), physical)),
    `Local source escapes the declared package roots: ${sourcePath(physical)}`);
  const name = sourcePath(physical);
  if (modules.has(name)) return modules.get(name);
  const bytes = readFileSync(physical);
  const source = ts.createSourceFile(name, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
  assert.equal(source.parseDiagnostics.length, 0, `Invalid source syntax: ${name}`);
  const imports = [];
  const add = (node, specifier, typeOnly = false) => {
    assert.ok(specifier && ts.isStringLiteralLike(specifier), `Nonliteral module dependency in ${name}`);
    imports.push({ specifier: specifier.text, typeOnly,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };
  const visit = node => {
    if (ts.isImportDeclaration(node)) add(node, node.moduleSpecifier, Boolean(node.importClause?.isTypeOnly));
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node, node.moduleSpecifier, node.isTypeOnly);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      add(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node, node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const module = { source: name, sha256: sha256(bytes), bytes: bytes.length, imports };
  modules.set(name, module);
  receipt.sourceSha256[name] = module.sha256;
  return module;
}

function closure(entry) {
  const pending = [resolve(root, entry)], visited = new Set(), localImports = [], externalImports = [];
  while (pending.length) {
    const module = readModule(pending.pop());
    if (visited.has(module.source)) continue;
    visited.add(module.source);
    for (const item of module.imports) {
      const edge = { from: module.source, ...item };
      if (/^(?:https?:|npm:|node:)/.test(item.specifier)) externalImports.push(edge);
      else {
        assert.ok(item.specifier.startsWith('./') || item.specifier.startsWith('../'),
          `Unresolved module specifier in ${module.source}: ${item.specifier}`);
        const destination = realpathSync(resolve(root, dirname(module.source), item.specifier));
        localImports.push({ ...edge, to: sourcePath(destination) });
        pending.push(destination);
      }
    }
  }
  return { entry, modules: [...visited].sort(), localImports, externalImports };
}

function virtualPath(source, layout) {
  const mount = layout.find(candidate => source === candidate.source || source.startsWith(`${candidate.source}/`));
  return mount ? posix.join(mount.target, posix.relative(mount.source, source)) : undefined;
}

function inspectLayout(graph, layout) {
  const errors = [], resolutions = [];
  if (!virtualPath(graph.entry, layout)) errors.push({ code: 'ENTRY_NOT_MOUNTED', source: graph.entry });
  for (const edge of graph.localImports) {
    const from = virtualPath(edge.from, layout), expected = virtualPath(edge.to, layout);
    if (!from) {
      errors.push({ code: 'IMPORTER_NOT_MOUNTED', source: edge.from });
      continue;
    }
    const resolved = posix.resolve(posix.dirname(from), edge.specifier);
    const inside = layout.some(mount => resolved === mount.target || resolved.startsWith(`${mount.target}/`));
    const record = { ...edge, fromVirtual: from, resolvedVirtual: resolved, expectedVirtual: expected ?? null };
    resolutions.push(record);
    if (!expected || !inside) errors.push({ code: 'DEPENDENCY_NOT_MOUNTED', ...record });
    else if (resolved !== expected) errors.push({ code: 'MOUNT_PATH_MISMATCH', ...record });
  }
  return { entry: graph.entry, status: errors.length ? 'FAIL' : 'PASS', errors, resolutions };
}

try {
  receipt.sourceSha256[scriptPath] = sha256(readFileSync(fileURLToPath(import.meta.url)));
  const graphs = entries.map(closure);
  receipt.graphs = graphs;
  receipt.checks.push({ name: 'Every local dependency exists and stays inside the two canonical source roots', status: 'PASS' });

  const outsideFunctions = [...modules.keys()].filter(name => !name.startsWith('supabase/functions/')).sort();
  assert.deepEqual(outsideFunctions, expectedLeaves);
  for (const name of expectedLeaves) assert.deepEqual(modules.get(name).imports, [], `Canonical module is no longer a leaf: ${name}`);
  receipt.canonicalLeaves = expectedLeaves;
  receipt.checks.push({ name: 'Only the two expected canonical modules leave functions, and both are import-free leaves', status: 'PASS' });

  receipt.proposedLayout = graphs.map(graph => inspectLayout(graph, mounts));
  for (const result of receipt.proposedLayout) assert.deepEqual(result.errors, [], `Virtual package is incomplete: ${result.entry}`);
  receipt.checks.push({ name: 'Every local import resolves to its exact source under the two proposed virtual mounts', status: 'PASS' });

  const functionsOnly = graphs.map(graph => inspectLayout(graph, mounts.slice(0, 1)));
  assert.deepEqual(functionsOnly.map(result => result.status), ['FAIL', 'FAIL', 'PASS']);
  assert.deepEqual(functionsOnly[0].errors.map(error => error.to).sort(), expectedLeaves);
  assert.deepEqual(functionsOnly[1].errors.map(error => error.to), [expectedLeaves[0]]);
  assert.ok(functionsOnly.slice(0, 2).every(result => result.errors.every(error => error.code === 'DEPENDENCY_NOT_MOUNTED')));
  receipt.negativeFunctionsOnly = { status: 'PASS_EXPECTED_REJECTION', results: functionsOnly };
  receipt.checks.push({ name: 'Functions-only mounting rejects chat and generation for the exact missing sources; custom trigger remains closed', status: 'PASS' });

  for (const [name, digest] of Object.entries(receipt.sourceSha256)) {
    assert.equal(sourcePath(realpathSync(resolve(root, name))), name, `Source path changed during inspection: ${name}`);
    assert.equal(sha256(readFileSync(resolve(root, name))), digest, `Source bytes changed during inspection: ${name}`);
  }
  receipt.checks.push({ name: 'All module and checker SHA-256 fingerprints remain unchanged across the inspection', status: 'PASS' });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
  receipt.repository = {
    head: git('rev-parse', 'HEAD'),
    inspectedSourceStatus: git('status', '--porcelain=v1', '--untracked-files=all', '--', ...Object.keys(receipt.sourceSha256)).split('\n').filter(Boolean),
  };
  receipt.localModuleCount = modules.size;
  receipt.fingerprintCount = Object.keys(receipt.sourceSha256).length;
  receipt.status = 'PASS';
} catch (error) {
  receipt.status = 'FAIL';
  receipt.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ status: receipt.status, proofKind: receipt.proofKind,
    checks: receipt.checks.length, localModules: receipt.localModuleCount,
    fingerprints: receipt.fingerprintCount, receipt: receiptPath, error: receipt.error }));
}
