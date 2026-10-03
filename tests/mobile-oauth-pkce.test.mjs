import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const client = readFileSync(new URL("../mobile/lib/supabase.ts", import.meta.url), "utf8");
const oauth = readFileSync(new URL("../mobile/lib/oauth.ts", import.meta.url), "utf8");
const auth = readFileSync(new URL("../mobile/hooks/useAuth.tsx", import.meta.url), "utf8");
const callback = readFileSync(new URL("../mobile/app/auth/callback.tsx", import.meta.url), "utf8");
const login = readFileSync(new URL("../mobile/app/(auth)/login.tsx", import.meta.url), "utf8");
const signup = readFileSync(new URL("../mobile/app/(auth)/signup.tsx", import.meta.url), "utf8");

test("mobile Supabase client uses PKCE", () => {
  assert.match(client, /flowType:\s*["']pkce["']/);
});

test("OAuth callback exchanges only an authorization code", () => {
  assert.match(oauth, /exchangeCodeForSession\(code\)/);
  assert.match(oauth, /searchParams\.get\(["']code["']\)/);
  assert.match(oauth, /callback\.protocol !== expected\.protocol/);
  assert.doesNotMatch(auth, /supabase\.auth\.setSession\s*\(/);
  assert.doesNotMatch(auth, /access_token|refresh_token/);
});

test("OAuth completion uses only existing routes", () => {
  assert.match(callback, /router\.replace\(["']\/\(tabs\)["']\)/);
  assert.match(callback, /router\.replace\(["']\/\(auth\)\/login["']\)/);
  assert.match(login, /router\.replace\(["']\/\(tabs\)["']\)/);
  assert.match(signup, /router\.replace\(["']\/\(tabs\)["']\)/);
});
