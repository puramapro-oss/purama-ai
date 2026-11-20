export type PublicationStatus = 'published' | 'scheduled' | 'partial' | 'failed' | 'publish_unconfirmed';

export interface PublicationResult {
  success: boolean;
  post_id: string;
  status: PublicationStatus;
  replayed: boolean;
  retryable: false;
  error?: string;
  caption_generated: false;
  platform_results?: { platform: string; accountId: string; status: string; postId?: string; postUrl?: string }[];
}

export interface PublicationIntent {
  content: string;
  mediaUrls?: string[];
  contentType?: string;
  agentName?: string;
  platforms?: string[];
  scheduledAt?: string;
  forceCaption?: boolean;
}

/**
 * Identical prepared content, destinations and owner reuse one local intent,
 * including after reload or in another tab. No content is stored in browser
 * storage. An explicit new clientRequestId is required to repeat that intent.
 */
export async function stablePublicationRequestId(intent: PublicationIntent, ownerId: string): Promise<string> {
  const canonical = JSON.stringify({
    ownerId,
    content: intent.content ?? '',
    mediaUrls: intent.mediaUrls ?? [],
    contentType: intent.contentType ?? 'text',
    agentName: intent.agentName ?? null,
    platforms: intent.platforms ? [...intent.platforms].sort() : null,
    scheduledAt: intent.scheduledAt ? new Date(intent.scheduledAt).toISOString() : null,
    forceCaption: intent.forceCaption === true,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return 'pub_' + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function readPublicationResult(value: unknown): PublicationResult {
  const result = value as Partial<PublicationResult> | null;
  if (!result || typeof result.post_id !== 'string' || !result.post_id ||
    !['published', 'scheduled', 'partial', 'failed', 'publish_unconfirmed'].includes(result.status ?? '')) {
    throw new Error('Résultat de publication non confirmé. Vérifiez la même demande avant toute nouvelle publication.');
  }
  return {
    ...result,
    success: result.status === 'published' || result.status === 'scheduled',
    retryable: false,
    replayed: result.replayed === true,
    caption_generated: false,
  } as PublicationResult;
}

export function publicationLabel(status: PublicationStatus): string {
  return {
    published: 'Publication confirmée',
    scheduled: 'Publication programmée',
    partial: 'Publication partielle',
    failed: 'Publication non effectuée',
    publish_unconfirmed: 'Publication à confirmer',
  }[status];
}
