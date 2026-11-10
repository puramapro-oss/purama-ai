import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../..', import.meta.url));
const gates = [
  ['deno', ['test', '--no-remote', '--no-npm',
    '--allow-env=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_ANON_KEY,DOCUSEAL_API_URL,DOCUSEAL_API_TOKEN,DOCUSEAL_WEBHOOK_SECRET',
    '--config', 'tests/contracts-ots/deno.json', 'tests/contracts-ots/admission.test.ts', 'tests/contracts-ots/webhook.test.ts', 'tests/contracts-ots/body.test.ts']],
  [process.execPath, ['--test', 'tests/contracts-ots/crypto.test.mjs', 'tests/contracts-ots/client.test.mjs']],
  ['deno', ['test', '--no-config', '--no-lock', '--cached-only', '--no-remote', '--node-modules-dir=manual',
    '--deny-net', 'tests/contracts-ots/runtime-deno.test.ts']],
];
for (const [program, args] of gates) {
  const result = spawnSync(program, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) { process.stderr.write(`${program}: ${result.error.message}\n`); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
