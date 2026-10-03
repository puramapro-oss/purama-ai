import assert from "node:assert/strict";
import test from "node:test";

import {
  isExplicitDevelopmentEnvironment,
  verifyBearerSecret,
  verifyDocusealWebhook,
  verifyHmacSignature,
} from "./webhook-security.ts";

const secret = "a-test-secret";
const body = '{"event_type":"form.completed","data":{"submission_id":42}}';

async function signature(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("bearer authentication accepts only the exact configured value", () => {
  assert.equal(verifyBearerSecret(`Bearer ${secret}`, secret), true);
  assert.equal(verifyBearerSecret(`bearer ${secret}`, secret), false);
  assert.equal(verifyBearerSecret(`Bearer ${secret}x`, secret), false);
  assert.equal(verifyBearerSecret(null, secret), false);
});

test("HMAC authentication accepts prefixed and bare signatures", async () => {
  const valid = await signature(body);
  assert.equal(await verifyHmacSignature(body, `sha256=${valid}`, secret), true);
  assert.equal(await verifyHmacSignature(body, valid, secret), true);
});

test("HMAC authentication rejects tampering and malformed encodings", async () => {
  const valid = await signature(body);
  assert.equal(await verifyHmacSignature(`${body} `, valid, secret), false);
  assert.equal(await verifyHmacSignature(body, `${valid.slice(0, -2)}ff`, secret), false);
  assert.equal(await verifyHmacSignature(body, "sha256=not-hex", secret), false);
  assert.equal(await verifyHmacSignature(body, null, secret), false);
});

test("webhook authentication supports configured bearer or HMAC transport", async () => {
  const bearer = new Headers({ authorization: `Bearer ${secret}` });
  assert.equal(await verifyDocusealWebhook(body, bearer, secret), true);

  const hmac = new Headers({ "x-docuseal-signature": await signature(body) });
  assert.equal(await verifyDocusealWebhook(body, hmac, secret), true);

  assert.equal(await verifyDocusealWebhook(body, new Headers(), secret), false);
});

test("only explicit local environments may opt into the development exception", () => {
  assert.equal(isExplicitDevelopmentEnvironment("development"), true);
  assert.equal(isExplicitDevelopmentEnvironment("local"), true);
  assert.equal(isExplicitDevelopmentEnvironment("test"), true);
  assert.equal(isExplicitDevelopmentEnvironment(undefined), false);
  assert.equal(isExplicitDevelopmentEnvironment("production"), false);
});
