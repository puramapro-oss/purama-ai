const SIGNATURE_PREFIX = "sha256=";

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  // Compare the maximum length as well as the length itself so a length mismatch
  // does not return before doing any comparison work.
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function decodeHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

/** Constant-time comparison for a raw shared secret transported as a bearer token. */
export function verifyBearerSecret(authorization: string | null, secret: string): boolean {
  if (!authorization || !secret) return false;
  const encoder = new TextEncoder();
  return constantTimeEqual(
    encoder.encode(authorization),
    encoder.encode(`Bearer ${secret}`),
  );
}

/** Verify the optional DocuSeal HMAC format over the exact, unparsed request body. */
export async function verifyHmacSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const normalized = signatureHeader.startsWith(SIGNATURE_PREFIX)
    ? signatureHeader.slice(SIGNATURE_PREFIX.length)
    : signatureHeader;
  const received = decodeHex(normalized);
  if (!received) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)),
  );
  return constantTimeEqual(expected, received);
}

/**
 * DocuSeal Community supports configured raw headers; some installations emit
 * an HMAC header. Accept either authenticated form, never an unauthenticated
 * request.
 */
export async function verifyDocusealWebhook(
  rawBody: string,
  headers: Headers,
  secret: string,
): Promise<boolean> {
  return verifyBearerSecret(headers.get("authorization"), secret) ||
    await verifyHmacSignature(rawBody, headers.get("x-docuseal-signature"), secret);
}

export function isExplicitDevelopmentEnvironment(environment: string | undefined): boolean {
  return environment === "development" || environment === "local" || environment === "test";
}
