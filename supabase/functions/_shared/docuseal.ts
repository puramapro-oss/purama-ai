// Shared DocuSeal client + helpers for edge functions
// Imported by contracts-create, contracts-webhook, contracts-get, etc.

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-purama-service-token",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

export const DOCUSEAL_URL = Deno.env.get("DOCUSEAL_API_URL") ?? "https://docuseal.purama.dev";
export const DOCUSEAL_TOKEN = Deno.env.get("DOCUSEAL_API_TOKEN") ?? "";
export const DOCUSEAL_WEBHOOK_SECRET = Deno.env.get("DOCUSEAL_WEBHOOK_SECRET") ?? "";

export class DocusealError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "DocusealError";
    this.status = status;
    this.body = body;
  }
}

export async function docusealFetch<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${DOCUSEAL_URL}${path}`, {
    method,
    headers: {
      "X-Auth-Token": DOCUSEAL_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let errBody: unknown;
    try { errBody = await res.json(); } catch { errBody = await res.text(); }
    throw new DocusealError(`DocuSeal ${method} ${path} → ${res.status}`, res.status, errBody);
  }
  if (res.status === 204) return {} as T;
  return await res.json() as T;
}

// ─── HMAC webhook validation (Web Crypto, Deno-native) ────────────────
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  const received = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : signatureHeader;
  if (expected.length !== received.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) result |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return result === 0;
}

// ─── Cross-app JWT verification (service-to-service) ──────────────────
export interface CrossAppJwtPayload {
  iss: string;
  aud: string;
  app_slug: string;
  iat: number;
  exp: number;
  jti?: string;
}

export async function verifyCrossAppJwt(
  token: string,
  secrets: string[],
): Promise<CrossAppJwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const [encHeader, encPayload, encSig] = parts;
  const signingInput = `${encHeader}.${encPayload}`;

  const receivedSig = base64UrlDecode(encSig);
  let valid = false;
  for (const secret of secrets) {
    const expected = await hmacSha256Bytes(secret, signingInput);
    if (bytesEqual(expected, receivedSig)) { valid = true; break; }
  }
  if (!valid) throw new Error("Invalid JWT signature");

  const payloadJson = new TextDecoder().decode(base64UrlDecode(encPayload));
  const payload = JSON.parse(payloadJson) as CrossAppJwtPayload;
  if (payload.aud !== "purama-contracts-hub") throw new Error("Invalid JWT aud");
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp + 30 < now) throw new Error("JWT expired");
  return payload;
}

async function hmacSha256Bytes(secret: string, data: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function corsResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 400, details?: unknown): Response {
  return corsResponse({ error: message, ...(details ? { details } : {}) }, status);
}
