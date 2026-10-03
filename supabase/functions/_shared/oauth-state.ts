const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type OAuthStateClaims = {
  iss: "purama-email-agent";
  aud: "google-oauth";
  sub: string;
  nonce: string;
  iat: number;
  exp: number;
};

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("OAuth state secret must contain at least 32 characters");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

export function randomBase64Url(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return sha256Base64Url(verifier);
}

export async function signOAuthState(
  claims: OAuthStateClaims,
  secret: string,
): Promise<string> {
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), encoder.encode(input));
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

export async function verifyOAuthState(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<OAuthStateClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid OAuth state");

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = JSON.parse(decoder.decode(fromBase64Url(encodedHeader))) as Record<string, unknown>;
  if (header.alg !== "HS256" || header.typ !== "JWT") throw new Error("Invalid OAuth state algorithm");

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, ["verify"]),
    fromBase64Url(encodedSignature),
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw new Error("Invalid OAuth state signature");

  const claims = JSON.parse(decoder.decode(fromBase64Url(encodedPayload))) as Partial<OAuthStateClaims>;
  if (
    claims.iss !== "purama-email-agent" ||
    claims.aud !== "google-oauth" ||
    typeof claims.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(claims.sub) ||
    typeof claims.nonce !== "string" || claims.nonce.length < 32 ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    claims.exp <= nowSeconds ||
    claims.iat > nowSeconds + 30 ||
    claims.exp - claims.iat > 600
  ) throw new Error("Invalid or expired OAuth state claims");

  return claims as OAuthStateClaims;
}
