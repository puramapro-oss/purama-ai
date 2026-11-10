// OpenTimestamps stamping for signed contracts
// Wraps src/lib/opentimestamps.ts for the contracts domain.
// Called by webhook handler on 'form.completed' event.

import { stampHash, verifyProof, hashContent, type VerifyResult } from '../opentimestamps';

export interface StampResult {
  stampHash: string; // hex SHA-256 of PDF content
  proofBase64: string;
  stampedAt: string; // ISO timestamp
}

/**
 * Stamp a signed PDF's content on Bitcoin blockchain.
 * Returns proof to store in contracts.ots_proof.
 */
export async function stampContract(pdfContent: ArrayBuffer | Uint8Array | string): Promise<StampResult> {
  // Keep the displayed hash and proof on one immutable snapshot across awaits.
  const content = typeof pdfContent === 'string'
    ? pdfContent
    : new Uint8Array(pdfContent instanceof Uint8Array ? pdfContent : new Uint8Array(pdfContent));
  const hashBytes = await hashContent(content);
  const stampHashHex = bufferToHex(hashBytes);
  const proofBase64 = await stampHash(content);

  return {
    stampHash: stampHashHex,
    proofBase64,
    stampedAt: new Date().toISOString(),
  };
}

/**
 * Verify a contract's OTS proof. Called by admin UI + CRON upgrade job.
 * If pending (not yet confirmed by a Bitcoin block), returns pending:true.
 */
export async function verifyContractProof(
  pdfContent: ArrayBuffer | Uint8Array | string,
  proofBase64: string,
): Promise<VerifyResult> {
  const content = typeof pdfContent === 'string'
    ? pdfContent
    : new Uint8Array(pdfContent instanceof Uint8Array ? pdfContent : new Uint8Array(pdfContent));
  const result = await verifyProof(content, proofBase64);
  if (typeof content === 'string' || result.verified || result.pending) return result;
  // Older versions stamped the Base64 text of binary PDFs. Keep those existing
  // proofs verifiable while all new stamps use the original PDF bytes.
  return verifyProof(await bufferToBase64(content), proofBase64);
}

// ─── Helpers ──────────────────────────────────────────────────────────
async function bufferToBase64(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function bufferToHex(buf: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, '0');
  return hex;
}
