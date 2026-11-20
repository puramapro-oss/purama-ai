import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.cwd();
const files = ['src/lib/entraide.ts', 'src/pages/Entraide.tsx', 'supabase/functions/_shared/entraide-http.ts'];
const configPath = resolve(root, 'tsconfig.app.json');
const input = ts.readConfigFile(configPath, ts.sys.readFile);
if (input.error) throw new Error(ts.flattenDiagnosticMessageText(input.error.messageText, '\n'));
const config = ts.parseJsonConfigFileContent(input.config, ts.sys, root);
const domain = process.env.ENTRAIDE_DOMAIN_ROOT;
if (!domain) throw new Error('An explicit existing canonical ENTRAIDE_DOMAIN_ROOT is required');
const options = { ...config.options, noEmit: true, allowImportingTsExtensions: true,
  paths: { ...config.options.paths, '@purama/entraide': [resolve(domain, 'src/index.ts')] } };
const tracked = new Set(files.map(file => resolve(root, file)));
function inspect(baseline) {
  const old = baseline ? new Map(files.map(file => [resolve(root, file), execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' })])) : new Map();
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  host.readFile = path => old.get(resolve(path)) ?? read(path);
  const program = ts.createProgram([...tracked, resolve(root, 'src/vite-env.d.ts')], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ({
    file: d.file?.fileName, code: d.code,
    line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : undefined,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  }));
  return { selected: diagnostics.filter(d => tracked.has(resolve(d.file ?? ''))),
    dependencyDiagnostics: diagnostics.filter(d => !tracked.has(resolve(d.file ?? ''))),
    files: program.getSourceFiles().length };
}
const baseline = inspect(true);
globalThis.gc?.();
const current = inspect(false);
const result = { typescript: ts.version, scope: files, baselineHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baseline, current };
writeFileSync('qa/entraide-reconciliation-20261110/typecheck.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ typescript: ts.version, baselineSelected: baseline.selected.length, currentSelected: current.selected.length, baselineDependencies: baseline.dependencyDiagnostics.length, currentDependencies: current.dependencyDiagnostics.length, files: current.files }));
if (current.selected.length || current.dependencyDiagnostics.length) process.exitCode = 1;
