import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
// Playwright 1.59.1 crée ses workers avec child_process.fork sans remplacer execArgv :
// le worker qui héberge HTTP/PGlite hérite ainsi des deux limites, avant tout import WASM.
const child = spawn(process.execPath, [
  '--wasm-num-compilation-tasks=1',
  '--max-old-space-size=384',
  cli, 'test', '--config', join(directory, '../browser.config.mjs'), ...process.argv.slice(2),
], { cwd: join(directory, '../../..'), stdio: 'inherit', env: process.env });

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
