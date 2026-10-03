import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("mobile data hooks target the migrated Purama schema", () => {
  for (const hook of ["useWallet.ts", "usePoints.ts", "useDailyGift.ts"]) {
    assert.match(read(`mobile/hooks/${hook}`), /schema\("purama_ai"\)/);
  }
  assert.doesNotMatch(read("mobile/hooks/useDailyGift.ts"), /app_slug/);
  assert.match(read("mobile/hooks/useWallet.ts"), /beneficiary_name/);
  assert.doesNotMatch(read("mobile/hooks/useWallet.ts"), /wallet_balance/);
});

test("profile lookup uses the auth user foreign key", () => {
  assert.match(read("mobile/hooks/useAuth.tsx"), /\.eq\("user_id", userId\)/);
});

test("Expo config contains no fake EAS project or legacy storage permissions", () => {
  const config = JSON.parse(read("mobile/app.json"));
  assert.equal(config.expo.extra?.eas, undefined);
  assert.equal(config.expo.updates, undefined);
  assert.equal(config.expo.ios.bundleIdentifier, "dev.purama.puramaai");
  assert.ok(!config.expo.android.permissions.includes("READ_EXTERNAL_STORAGE"));
  assert.ok(!config.expo.android.permissions.includes("WRITE_EXTERNAL_STORAGE"));
});

test("invalid agent routes cannot be force-unwrapped", () => {
  assert.doesNotMatch(read("mobile/app/agent/[slug].tsx"), /useAgentChat\(agent!\)/);
  assert.match(read("mobile/hooks/useAgents.ts"), /Agent \| undefined/);
});
