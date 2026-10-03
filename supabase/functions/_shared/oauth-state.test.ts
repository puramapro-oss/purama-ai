import assert from "node:assert/strict";
import test from "node:test";
import {
  pkceChallenge,
  randomBase64Url,
  sha256Base64Url,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state.ts";

const secret = "test-secret-that-is-at-least-thirty-two-characters";
const claims = {
  iss: "purama-email-agent" as const,
  aud: "google-oauth" as const,
  sub: "123e4567-e89b-12d3-a456-426614174000",
  nonce: randomBase64Url(32),
  iat: 1_000,
  exp: 1_600,
};

test("signed OAuth state round-trips", async () => {
  const token = await signOAuthState(claims, secret);
  assert.deepEqual(await verifyOAuthState(token, secret, 1_001), claims);
});

test("tampered, expired, and wrong-secret states fail closed", async () => {
  const token = await signOAuthState(claims, secret);
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  await assert.rejects(verifyOAuthState(tampered, secret, 1_001));
  await assert.rejects(verifyOAuthState(token, `${secret}-different`, 1_001));
  await assert.rejects(verifyOAuthState(token, secret, 1_600));
});

test("PKCE and nonce hashes are deterministic SHA-256 base64url values", async () => {
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  assert.equal(await pkceChallenge(verifier), await sha256Base64Url(verifier));
  assert.match(await pkceChallenge(verifier), /^[A-Za-z0-9_-]{43}$/);
});

test("weak signing secrets and overlong lifetimes are rejected", async () => {
  await assert.rejects(signOAuthState(claims, "too-short"));
  const token = await signOAuthState({ ...claims, exp: claims.iat + 601 }, secret);
  await assert.rejects(verifyOAuthState(token, secret, claims.iat));
});
