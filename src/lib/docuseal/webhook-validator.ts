// DocuSeal webhook HMAC validation — works in browser, Deno, Node
// DocuSeal sends X-Docuseal-Signature: sha256=<hex> header.
// Validation: HMAC-SHA256(raw_body, webhook_secret) === signature

/**
 * Verify HMAC-SHA256 signature. Constant-time comparison.
 * Returns true if valid, false otherwise.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
): Promise<boolean> {
  if (!signatureHeader || !webhookSecret) return false;

  const expected = await hmacSha256Hex(webhookSecret, rawBody);

  const received = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice(7)
    : signatureHeader;

  return constantTimeEqual(expected, received);
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  // Prefer Web Crypto (browser + Deno + modern Node)
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const encoder = new TextEncoder();
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(data));
    return bufferToHex(new Uint8Array(signature));
  }
  // Node.js fallback
  const { createHmac } = await import('crypto');
  return createHmac('sha256', secret).update(data).digest('hex');
}

function bufferToHex(buf: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, '0');
  return hex;
}

/** Constant-time string comparison to prevent timing attacks. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

/**
 * Parse DocuSeal webhook payload and extract key signals.
 * Returns normalized event info.
 */
export interface NormalizedWebhookEvent {
  eventType: string;
  submissionId: number | null;
  submitterId: number | null;
  submitterEmail: string | null;
  status: string | null;
  completedAt: string | null;
  declinedAt: string | null;
  rawData: Record<string, unknown>;
}

export function normalizeWebhookEvent(payload: {
  event_type?: string;
  data?: Record<string, unknown>;
}): NormalizedWebhookEvent {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  return {
    eventType: payload.event_type ?? 'unknown',
    submissionId: typeof data.submission_id === 'number' ? data.submission_id
                : typeof data.id === 'number' && payload.event_type?.startsWith('submission.') ? data.id
                : null,
    submitterId: typeof data.id === 'number' && !payload.event_type?.startsWith('submission.') ? data.id : null,
    submitterEmail: typeof data.email === 'string' ? data.email : null,
    status: typeof data.status === 'string' ? data.status : null,
    completedAt: typeof data.completed_at === 'string' ? data.completed_at : null,
    declinedAt: typeof data.declined_at === 'string' ? data.declined_at : null,
    rawData: data,
  };
}
