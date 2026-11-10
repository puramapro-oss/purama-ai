// Public API retained; proof operations stay in upstream OpenTimestamps 0.4.9.
// The package entrypoint's legacy request/uuid transport is never imported.
import DetachedTimestampFile from 'opentimestamps/src/detached-timestamp-file.js';
import Ops from 'opentimestamps/src/ops.js';
import Context from 'opentimestamps/src/context.js';
import Timestamp from 'opentimestamps/src/timestamp.js';
import Notary from 'opentimestamps/src/notary.js';
import { createOtsClient, type OtsLibrary } from './ots-core';

const ots = createOtsClient({ DetachedTimestampFile, Ops, Context, Timestamp, Notary } as OtsLibrary);

export async function hashContent(data: string): Promise<Uint8Array> {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)));
  }
  const { createHash } = await import('crypto');
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export async function stampHash(data: string): Promise<string> {
  return ots.stampDigest(await hashContent(data));
}

export interface VerifyResult {
  verified: boolean;
  blockHeight?: number;
  timestamp?: Date;
  pending?: boolean;
}

export async function verifyProof(data: string, proofBase64: string): Promise<VerifyResult> {
  const hash = await hashContent(data);
  try {
    const result = await ots.verifyDigest(hash, proofBase64, true);
    if (result.bitcoin) return { verified: true, blockHeight: result.bitcoin.height, timestamp: new Date(result.bitcoin.timestamp * 1000) };
    return { verified: false, pending: true };
  } catch {
    return { verified: false };
  }
}
