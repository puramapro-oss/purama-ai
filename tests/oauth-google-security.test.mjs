import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const edge = readFileSync(new URL('../supabase/functions/oauth-google/index.ts', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../src/hooks/useUserConnections.ts', import.meta.url), 'utf8');
const callback = readFileSync(new URL('../src/pages/OAuthCallback.tsx', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261003190000_oauth_state_nonces.sql', import.meta.url), 'utf8');
const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');

test('validates bearer JWT and derives every database owner from it', () => {
  assert.match(edge, /auth\.getUser\(match\[1\]\)/);
  assert.match(edge, /user_id:\s*user\.id/);
  assert.doesNotMatch(edge, /body\.userId/);
  assert.doesNotMatch(edge, /const\s*\{[^}]*userId[^}]*\}\s*=\s*body/);
  assert.match(config, /\[functions\.oauth-google\]\s+verify_jwt = true/);
});

test('enforces signed, expiring, one-time state and PKCE', () => {
  assert.match(edge, /HMAC/);
  assert.match(edge, /state\.exp\s*</);
  assert.match(edge, /oauth_state_nonces/);
  assert.match(edge, /\.delete\(\).*\.eq\("nonce"/s);
  assert.match(edge, /code_challenge_method:\s*"S256"/);
  assert.match(edge, /code_verifier:\s*body\.codeVerifier/);
  assert.match(hook, /crypto\.getRandomValues/);
  assert.match(callback, /oauth_code_verifier/);
  assert.match(migration, /REVOKE ALL .* anon, authenticated/i);
});

test('takes providers and scopes from a server allowlist only', () => {
  assert.match(edge, /const PROVIDERS =/);
  assert.match(edge, /scope:\s*PROVIDERS\[provider\]/);
  assert.doesNotMatch(edge, /searchParams\.get\(["']scopes["']\)/);
  assert.doesNotMatch(edge, /body\.scopes/);
});

test('never returns refreshed access tokens to the browser', () => {
  assert.doesNotMatch(edge, /success:\s*true,\s*access_token/);
  assert.match(edge, /return json\(req, \{ success: true \}\)/);
});
