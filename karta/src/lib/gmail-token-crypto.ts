import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { config } from "../config.js";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  if (!config.gmailTokenEncryptionKey) {
    throw new Error("GMAIL_TOKEN_ENCRYPTION_KEY manquante — impossible de chiffrer/déchiffrer un token Gmail");
  }
  const key = Buffer.from(config.gmailTokenEncryptionKey, "base64");
  if (key.length !== 32) {
    throw new Error("GMAIL_TOKEN_ENCRYPTION_KEY doit être une clé AES-256 encodée en base64 (32 octets)");
  }
  return key;
}

/**
 * Chiffre un token Gmail avant stockage (AES-256-GCM, iv+ciphertext+tag concaténés en base64).
 * Layout identique à supabase/functions/_shared/gmail-token-crypto.ts (Web Crypto, tag en fin de
 * ciphertext par convention) — un même token doit pouvoir être écrit par l'OAuth callback (Deno)
 * et lu par KARTA Engine (Node), ou l'inverse.
 */
export function encryptGmailToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64");
}

/** Déchiffre un token Gmail lu depuis la DB. */
export function decryptGmailToken(stored: string): string {
  const key = getKey();
  const raw = Buffer.from(stored, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(raw.length - AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH, raw.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
