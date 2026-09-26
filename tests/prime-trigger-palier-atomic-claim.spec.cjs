// Garde statique (source-guard) — pas de substitut a un test d'integration reel.
// Verifie que le cron prime-trigger-palier claim atomiquement un palier
// (WHERE palier_actuel=lu) avant tout credit wallet_transactions/RPC.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(
  path.join(__dirname, '../supabase/functions/prime-trigger-palier/index.ts'),
  'utf8'
);

let pass = 0;
function check(name, cond) {
  assert.ok(cond, `FAIL: ${name}`);
  pass++;
  console.log(`PASS: ${name}`);
}

const claimIdx = src.indexOf("from('primes')\n        .update({");
check('claim atomique trouve avant wallet_transactions', claimIdx !== -1);
check(
  'claim garde .eq(id) + .eq(palier_actuel, valeur lue)',
  /\.eq\('id', p\.id\)\s*\.eq\('palier_actuel', p\.palier_actuel/.test(src)
);
check(
  'claim echoue -> continue avant tout insert wallet_transactions',
  /if \(claimErr \|\| !claimed \|\| claimed\.length === 0\) \{[\s\S]{0,150}continue;/.test(src)
);
check(
  'rollback du claim si insert wallet_transactions echoue',
  /await admin\.from\('primes'\)\.update\(\{ palier_actuel: p\.palier_actuel \?\? 0 \}\)\.eq\('id', p\.id\);/.test(src)
);
check(
  'ordre correct: claim avant insert wallet_transactions avant RPC increment',
  (() => {
    const insertIdx = src.indexOf("from('wallet_transactions').insert(");
    const rpcIdx = src.indexOf("rpc('increment_wallet_balance'");
    return claimIdx < insertIdx && insertIdx < rpcIdx;
  })()
);

console.log(`\n${pass}/5 PASS`);
