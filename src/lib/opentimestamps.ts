// ─── Purama · OpenTimestamps (V4.1 — remplace OriginStamp retired mai 2025) ───
//
// Horodatage blockchain Bitcoin gratuit et open source.
// Ancre un hash SHA-256 dans la blockchain Bitcoin via les calendriers
// OpenTimestamps publics (calendar.bitcoin.ts.eternitywall.com, etc.).
//
// Usage côté client/serveur :
//   import { stampHash, verifyProof, hashContent } from '@/lib/opentimestamps';
//   const proof = await stampHash(regulationText);
//   const { verified, blockHeight, timestamp } = await verifyProof(text, proof);
//
// Terme UI : "Preuve blockchain Purama" (jamais "OpenTimestamps" ni "Bitcoin").
// ───────────────────────────────────────────────────────────────────────────

import OpenTimestamps from 'opentimestamps';

export type HashableContent = string | ArrayBuffer | Uint8Array;

/**
 * Produit le digest SHA-256 d'un texte UTF-8 ou d'octets bruts.
 * Utilise SubtleCrypto côté navigateur, fallback Node.js côté serveur/edge.
 */
export async function hashContent(data: HashableContent): Promise<Uint8Array> {
  // Copy typed-array views so byteOffset/byteLength are respected consistently
  // by WebCrypto and Node, without hashing a Base64/text representation.
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data));
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  }
  // Node.js / Deno fallback
  const { createHash } = await import('crypto');
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

/**
 * Horodate un contenu sur la blockchain Bitcoin.
 * Retourne une preuve base64 à stocker en DB.
 * La preuve reste en attente jusqu'à une confirmation Bitcoin vérifiée.
 */
export async function stampHash(data: HashableContent): Promise<string> {
  const hash = await hashContent(data);
  const detachedFile = OpenTimestamps.DetachedTimestampFile.fromHash(
    new OpenTimestamps.Ops.OpSHA256(),
    hash,
  );
  await OpenTimestamps.stamp(detachedFile);
  // This library version resolves even when every calendar returned an error.
  if (detachedFile.timestamp.allAttestations().size === 0) {
    throw new Error('No timestamp calendar accepted the request');
  }
  const bytes = detachedFile.serializeToBytes();
  return toBase64(bytes);
}

export interface VerifyResult {
  verified: boolean;
  blockHeight?: number;
  timestamp?: Date;
  pending?: boolean;
}

/**
 * Vérifie qu'un contenu a bien été horodaté sur Bitcoin.
 * Si la preuve n'a pas encore été confirmée par un bloc, retourne pending:true.
 */
export async function verifyProof(data: HashableContent, proofBase64: string): Promise<VerifyResult> {
  const hash = await hashContent(data);
  const detachedOriginal = OpenTimestamps.DetachedTimestampFile.fromHash(
    new OpenTimestamps.Ops.OpSHA256(),
    hash,
  );
  try {
    const detachedProof = OpenTimestamps.DetachedTimestampFile.deserialize(fromBase64(proofBase64));
    // A serialized digest/operation tree alone is not a calendar receipt.
    if (detachedProof.timestamp.allAttestations().size === 0) return { verified: false };
    const result = await OpenTimestamps.verify(detachedProof, detachedOriginal);
    if (result && result.bitcoin) {
      return {
        verified: true,
        blockHeight: result.bitcoin.height,
        timestamp: new Date(result.bitcoin.timestamp * 1000),
      };
    }
    return { verified: false, pending: true };
  } catch {
    return { verified: false };
  }
}

// ─── Helpers base64 (compatibles navigateur + Node/Deno) ─────────────────
function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(base64, 'base64'));
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
