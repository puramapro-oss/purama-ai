import { describe, expect, it, beforeAll } from "vitest";

process.env.GMAIL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const { encryptGmailToken, decryptGmailToken } = await import("../src/lib/gmail-token-crypto.js");

describe("gmail-token-crypto — chiffrement au repos des tokens Gmail (brief §Phase 3)", () => {
  it("round-trip : déchiffre exactement ce qui a été chiffré", () => {
    const plaintext = "ya29.a0Ar-fake-access-token-value";
    const encrypted = encryptGmailToken(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(decryptGmailToken(encrypted)).toBe(plaintext);
  });

  it("2 chiffrements du même texte produisent des ciphertexts différents (iv aléatoire)", () => {
    const plaintext = "same-refresh-token";
    expect(encryptGmailToken(plaintext)).not.toBe(encryptGmailToken(plaintext));
  });

  it("refuse de déchiffrer un ciphertext altéré (intégrité GCM)", () => {
    const encrypted = encryptGmailToken("un-token-quelconque");
    const tampered = encrypted.slice(0, -4) + (encrypted.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect(() => decryptGmailToken(tampered)).toThrow();
  });
});
