import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20261003210000_server_ledger_hardening.sql', import.meta.url),
  'utf8',
);
const webGift = readFileSync(new URL('../src/hooks/useDailyGift.ts', import.meta.url), 'utf8');
const webPoints = readFileSync(new URL('../src/hooks/usePoints.ts', import.meta.url), 'utf8');
const webWallet = readFileSync(new URL('../src/hooks/useWallet.ts', import.meta.url), 'utf8');
const mobileGift = readFileSync(new URL('../mobile/hooks/useDailyGift.ts', import.meta.url), 'utf8');
const mobileWallet = readFileSync(new URL('../mobile/hooks/useWallet.ts', import.meta.url), 'utf8');
const boutique = readFileSync(new URL('../src/pages/Boutique.tsx', import.meta.url), 'utf8');

test('ledger RPCs are authenticated security-definer boundaries with fixed search paths', () => {
  for (const fn of ['claim_daily_gift', 'purchase_shop_item', 'request_wallet_withdrawal']) {
    assert.match(migration, new RegExp(`CREATE OR REPLACE FUNCTION purama_ai\\.${fn}`));
  }
  assert.equal((migration.match(/\nSECURITY DEFINER\n/g) ?? []).length, 3);
  assert.equal((migration.match(/SET search_path = pg_catalog, purama_ai/g) ?? []).length, 3);
  assert.equal((migration.match(/auth\.uid\(\)/g) ?? []).length >= 3, true);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE/);
  assert.match(migration, /FROM PUBLIC, anon/);
});

test('ledger operations enforce idempotency, catalog prices and balances', () => {
  assert.match(migration, /daily_gift_user_day_uidx/);
  assert.match(migration, /point_purchase_user_idempotency_uidx/);
  assert.match(migration, /withdrawals_user_idempotency_uidx/);
  assert.match(migration, /v_item\.cost_points/);
  assert.match(migration, /insufficient_points/);
  assert.match(migration, /insufficient_balance/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /reward_delivery_not_available/);
});

test('web and mobile financial hooks only mutate through ledger RPCs', () => {
  assert.match(webGift, /rpc\('claim_daily_gift'\)/);
  assert.match(webPoints, /rpc\('purchase_shop_item'/);
  assert.match(webWallet, /rpc\('request_wallet_withdrawal'/);
  assert.match(mobileGift, /rpc\("claim_daily_gift"\)/);
  assert.match(mobileWallet, /rpc\("request_wallet_withdrawal"/);
  for (const source of [webGift, webPoints, webWallet, mobileGift, mobileWallet]) {
    assert.doesNotMatch(source, /\.from\(["'](?:daily_gifts|point_purchases|withdrawals)["']\)[\s\S]{0,160}\.insert\(/);
  }
  assert.doesNotMatch(webGift, /Math\.random/);
  assert.doesNotMatch(mobileGift, /Math\.random/);
});

test('unsupported shop rewards cannot be presented as delivered', () => {
  assert.match(boutique, /item\.type !== 'ticket'/);
  assert.match(boutique, /Bientôt disponible/);
  assert.match(boutique, /Aucun tirage actif/);
});
