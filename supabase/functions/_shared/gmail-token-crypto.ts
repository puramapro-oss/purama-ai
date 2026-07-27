// Chiffrement au repos des tokens Gmail (brief §Phase 3 "tokens chiffrés AES-256"), Web Crypto API
// (AES-256-GCM) — même clé/format que karta/src/lib/gmail-token-crypto.ts (Node), pour que les tokens
// écrits par l'OAuth callback (Deno) soient lisibles par KARTA Engine (Node) et vice-versa.
const ALGO = "AES-GCM";
const IV_LENGTH = 12;

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Copie défensive en ArrayBuffer "pur" — Uint8Array.buffer est typé ArrayBufferLike (inclut
 * SharedArrayBuffer), que les typings SubtleCrypto de Deno n'acceptent pas en BufferSource. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function getKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("GMAIL_TOKEN_ENCRYPTION_KEY") ?? "";
  if (!raw) throw new Error("GMAIL_TOKEN_ENCRYPTION_KEY manquante — impossible de chiffrer/déchiffrer un token Gmail");
  const keyBytes = base64ToBytes(raw);
  if (keyBytes.length !== 32) throw new Error("GMAIL_TOKEN_ENCRYPTION_KEY doit être une clé AES-256 encodée en base64 (32 octets)");
  return crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), ALGO, false, ["encrypt", "decrypt"]);
}

/** Chiffre un token Gmail avant stockage (iv+ciphertext+tag concaténés en base64, le tag GCM est déjà inclus par Web Crypto). */
export async function encryptGmailToken(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: ALGO, iv }, key, new TextEncoder().encode(plaintext)));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return bytesToBase64(combined);
}

/** Déchiffre un token Gmail lu depuis la DB. */
export async function decryptGmailToken(stored: string): Promise<string> {
  const key = await getKey();
  const combined = base64ToBytes(stored);
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const plainBuf = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}
