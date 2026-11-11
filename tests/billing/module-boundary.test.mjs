import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from './test-case.mjs';
import ts from 'typescript';

// Self-hosted Supabase mounts only its functions directory. Local imports
// outside that directory can pass a repository-wide check and still fail there.
const functionsRoot = realpathSync(fileURLToPath(new URL('../../supabase/functions', import.meta.url)));
for (const entry of ['create-checkout', 'customer-portal', 'stripe-webhook']) {
  test(`${entry}: local dependencies fit inside the self-hosted functions mount`, () => {
    const pending = [path.join(functionsRoot, entry, 'index.ts')];
    const visited = new Set();
    while (pending.length) {
      const file = realpathSync(pending.pop());
      assert.ok(file.startsWith(functionsRoot + path.sep), `Local dependency escapes functions mount: ${file}`);
      if (visited.has(file)) continue;
      visited.add(file);
      const imports = ts.preProcessFile(readFileSync(file, 'utf8'), true).importedFiles;
      for (const { fileName } of imports) {
        if (/^(https?:|npm:|node:)/.test(fileName)) continue; // Resolved separately by native Deno CI.
        assert.ok(fileName.startsWith('./') || fileName.startsWith('../'), `Unresolved local import: ${fileName}`);
        pending.push(path.resolve(path.dirname(file), fileName));
      }
    }
    assert.ok(visited.size > 1, 'The entry point and its real shared modules must be inspected');
  });
}
