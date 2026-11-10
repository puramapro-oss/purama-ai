// Public API retained; proof operations stay in upstream OpenTimestamps 0.4.9.
// The package entrypoint's legacy request/uuid transport is never imported.
import DetachedTimestampFile from 'opentimestamps/src/detached-timestamp-file.js';
import Ops from 'opentimestamps/src/ops.js';
import Context from 'opentimestamps/src/context.js';
import Timestamp from 'opentimestamps/src/timestamp.js';
import Notary from 'opentimestamps/src/notary.js';
import { createOtsClient, type OtsLibrary } from './ots-core';

const ots = createOtsClient({ DetachedTimestampFile, Ops, Context, Timestamp, Notary } as OtsLibrary);

export type OtsContent = string | ArrayBuffer | Uint8Array;
// Preserve the binary-content public type introduced by the concurrent branch.
export type HashableContent = OtsContent;

export async function hashContent(data: OtsContent): Promise<Uint8Array> {
  // Snapshot binary input before any await. Hash the original PDF bytes,
  // not the Base64 text used to transport them.
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  }
  const { createHash } = await import('crypto');
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

export async function stampHash(data: OtsContent): Promise<string> {
  return ots.stampDigest(await hashContent(data));
}

export interface VerifyResult {
  verified: boolean;
  blockHeight?: number;
  timestamp?: Date;
  pending?: boolean;
}

export async function verifyProof(data: OtsContent, proofBase64: string): Promise<VerifyResult> {
  const hash = await hashContent(data);
  try {
    const result = await ots.verifyDigest(hash, proofBase64, true);
    if (result.bitcoin) return { verified: true, blockHeight: result.bitcoin.height, timestamp: new Date(result.bitcoin.timestamp * 1000) };
    return { verified: false, pending: true };
  } catch {
    return { verified: false };
  }
}
