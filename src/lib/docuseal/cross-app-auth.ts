// Cross-app JWT service-to-service auth
// Other Purama apps (MIDAS, KAIA, ...) sign a JWT with PURAMA_SERVICE_SECRET
// and call https://purama-ai.purama.dev/api/contracts/create with X-Purama-Service-Token header

import { CrossAppJwtPayloadSchema, type CrossAppJwtPayload } from './types';

const TOKEN_VALIDITY_SECONDS = 5 * 60; // 5 min max lifetime for service tokens
const CLOCK_SKEW_SECONDS = 30;

/**
 * Sign a cross-app JWT. Call from source app before making request to hub.
 * Uses HMAC-SHA256 (JWT alg: HS256).
 */
export async function signCrossAppJwt(input: {
  appSlug: string;
  secret: string;
  validitySeconds?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: CrossAppJwtPayload = {
    iss: input.appSlug,
    aud: 'purama-contracts-hub',
    app_slug: input.appSlug,
    iat: now,
    exp: now + (input.validitySeconds ?? TOKEN_VALIDITY_SECONDS),
    jti: crypto.randomUUID(),
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await hmacSha256(input.secret, signingInput);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/**
 * Verify a cross-app JWT. Call from edge function receiving the header.
 * Returns payload if valid, throws if invalid/expired.
 */
export async function verifyCrossAppJwt(
  token: string,
  secrets: string[], // accepts array for rotation (v1 + v2 during transition)
): Promise<CrossAppJwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const receivedSig = base64UrlDecode(encodedSignature);

  // Try each secret (rotation support)
  let validSig = false;
  for (const secret of secrets) {
    const expected = await hmacSha256(secret, signingInput);
    if (bytesEqual(expected, receivedSig)) {
      validSig = true;
      break;
    }
  }
  if (!validSig) throw new Error('Invalid JWT signature');

  const payloadJson = new TextDecoder().decode(base64UrlDecode(encodedPayload));
  const payloadRaw: unknown = JSON.parse(payloadJson);
  const payload = CrossAppJwtPayloadSchema.parse(payloadRaw);

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp + CLOCK_SKEW_SECONDS < now) throw new Error('JWT expired');
  if (payload.iat - CLOCK_SKEW_SECONDS > now) throw new Error('JWT iat in future');

  return payload;
}

// ─── Base64URL helpers ────────────────────────────────────────────────
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa !== 'undefined'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  if (typeof atob !== 'undefined') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const encoder = new TextEncoder();
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(data));
    return new Uint8Array(sig);
  }
  const { createHmac } = await import('crypto');
  return new Uint8Array(createHmac('sha256', secret).update(data).digest());
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
