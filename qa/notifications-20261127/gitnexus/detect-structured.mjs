import { readFile, writeFile, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, '../../..');
const installed = '/home/agent/.npm/_npx/5e786f48223a616c/node_modules/gitnexus/dist';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const sha = value => createHash('sha256').update(value).digest('hex');
const snapshot = () => ({ head: git('rev-parse', 'HEAD').trim(), main: git('rev-parse', 'origin/main').trim(),
  stagedDiffSha256: sha(git('diff', '--cached', '--no-ext-diff')), stagedFiles: git('diff', '--cached', '--name-only').trim().split('\n') });
const receipt = { startedAt: new Date().toISOString(), method: 'Installed LocalBackend.callTool, identical backend used by dist/cli/tool.js',
  installedBackend: path.join(installed, 'mcp/local/local-backend.js'),
  backendSha256: sha(await readFile(path.join(installed, 'mcp/local/local-backend.js'))),
  listingLimit: { cliRequested: 30000, backendHardCap: 1000, backendLimitIsNotConfigurable: true },
  before: snapshot(), calls: [] };

for (const scope of ['staged', 'main']) {
  const original = path.join(output, `detect-${scope}.json`);
  const bytes = await readFile(original, 'utf8');
  try { JSON.parse(bytes); }
  catch {
    const archive = path.join(output, `detect-${scope}-cli-limit200.log`);
    // Exclusive archive creation preserves the first CLI output verbatim.
    await writeFile(archive, bytes, { flag: 'wx' });
    await rename(original, path.join(output, `detect-${scope}-original-text.json.log`));
  }
}

const { LocalBackend } = await import(pathToFileURL(path.join(installed, 'mcp/local/local-backend.js')).href);
const backend = new LocalBackend();
try {
  if (!await backend.init()) throw new Error('No indexed repository available');
  for (const [name, params] of [['staged', { scope: 'staged' }], ['main', { scope: 'compare', base_ref: 'origin/main' }]]) {
    const args = { ...params, repo: 'iao-notifications-b643' };
    const startedAt = new Date().toISOString();
    const result = await backend.callTool('detect_changes', args);
    await writeFile(path.join(output, `detect-${name}.json`), JSON.stringify(result, null, 2) + '\n');
    receipt.calls.push({ name, args, startedAt, finishedAt: new Date().toISOString(), summary: result.summary,
      listedSymbols: result.changed_symbols?.length, listedProcesses: result.affected_processes?.length,
      partial: result.partial ?? false, truncated: result.truncated ?? false, error: result.error ?? null });
    if (result.error || result.partial) process.exitCode = 1;
  }
} finally {
  await backend.dispose();
  receipt.after = snapshot();
  receipt.stagedUnchanged = receipt.before.stagedDiffSha256 === receipt.after.stagedDiffSha256;
  receipt.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'detect-structured-command-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ calls: receipt.calls, stagedUnchanged: receipt.stagedUnchanged }) + '\n');
}
