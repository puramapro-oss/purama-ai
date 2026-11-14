// Frontend client for the Social Autopilot module (Zernio)
// Wraps Supabase edge functions: social-connect, social-callback, social-accounts,
// social-publish, social-autopilot-config.
import { supabase } from '@/integrations/supabase/client';
import { readPublicationResult, stablePublicationRequestId, type PublicationResult } from './social-publish-request';
import { createRequestDeadline } from './request-deadline';

const SOCIAL_REQUEST_TIMEOUT_MS = 30_000;

export type Platform =
  | 'youtube'
  | 'tiktok'
  | 'instagram'
  | 'facebook'
  | 'threads'
  | 'linkedin'
  | 'twitter'
  | 'bluesky'
  | 'pinterest'
  | 'reddit'
  | 'telegram'
  | 'whatsapp'
  | 'snapchat'
  | 'google_business';

export interface SocialAccount {
  id: string;
  user_id: string;
  platform: Platform;
  zernio_account_id: string;
  zernio_profile_id: string;
  account_name: string | null;
  account_username: string | null;
  is_active: boolean;
  publishing_verified_at: string | null;
  disconnect_pending: boolean;
  disconnect_completed_at: string | null;
  connected_at: string;
  metadata: Record<string, unknown>;
}

export interface AutopilotConfig {
  user_id: string;
  autopilot_enabled: boolean;
  auto_caption: boolean;
  auto_hashtags: boolean;
  default_platforms: Platform[];
  timezone: string;
}

export interface PublishParams {
  clientRequestId?: string;
  content: string;
  mediaUrls?: string[];
  contentType?: 'text' | 'image' | 'video' | 'carousel' | 'reel';
  agentName?: string;
  platforms?: Platform[];
  scheduledAt?: string;
  forceCaption?: boolean;
}

export interface SocialRequestOptions {
  /** Owner that started the operation, retained across asynchronous steps. */
  ownerId?: string;
  signal?: AbortSignal;
}

export interface SocialPublication {
  id: string;
  content_text: string | null;
  target_platforms: string[];
  status: PublicationResult['status'] | 'draft' | 'publishing';
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
  error_message: string | null;
  platform_results: PublicationResult['platform_results'];
}

export const PLATFORM_META: Record<
  Platform,
  { label: string; emoji: string; color: string; description: string }
> = {
  youtube: { label: 'YouTube', emoji: '▶️', color: '#FF0000', description: 'Vidéos longues & Shorts' },
  tiktok: { label: 'TikTok', emoji: '🎵', color: '#000000', description: 'Vidéos courtes virales' },
  instagram: { label: 'Instagram', emoji: '📸', color: '#E4405F', description: 'Posts, Reels & Stories' },
  facebook: { label: 'Facebook', emoji: '👥', color: '#1877F2', description: 'Pages & profils' },
  threads: { label: 'Threads', emoji: '🧵', color: '#000000', description: 'Conversations Meta' },
  linkedin: { label: 'LinkedIn', emoji: '💼', color: '#0A66C2', description: 'Réseau professionnel' },
  twitter: { label: 'X (Twitter)', emoji: '🐦', color: '#000000', description: 'Tweets & threads' },
  bluesky: { label: 'Bluesky', emoji: '☁️', color: '#0085FF', description: 'Réseau décentralisé' },
  pinterest: { label: 'Pinterest', emoji: '📌', color: '#E60023', description: 'Inspirations visuelles' },
  reddit: { label: 'Reddit', emoji: '👽', color: '#FF4500', description: 'Communautés' },
  telegram: { label: 'Telegram', emoji: '✈️', color: '#26A5E4', description: 'Canaux & groupes' },
  whatsapp: { label: 'WhatsApp', emoji: '💬', color: '#25D366', description: 'WhatsApp Business' },
  snapchat: { label: 'Snapchat', emoji: '👻', color: '#FFFC00', description: 'Stories Snap' },
  google_business: { label: 'Google Business', emoji: '🏢', color: '#4285F4', description: 'Profil entreprise' },
};

export const ALL_PLATFORMS: Platform[] = Object.keys(PLATFORM_META) as Platform[];

async function getSocialSession(options: SocialRequestOptions) {
  const deadline = createRequestDeadline(SOCIAL_REQUEST_TIMEOUT_MS, options.signal);
  try {
    const { data: { session }, error } = await deadline.wait(() => supabase.auth.getSession());
    if (error) throw error;
    if (!session?.user.id || !session.access_token) {
      throw new Error('Connectez-vous pour gérer vos réseaux sociaux.');
    }
    if (options.ownerId && session.user.id !== options.ownerId) {
      throw new Error('Le compte actif a changé. Relancez la demande depuis ce compte.');
    }
    return session;
  } finally {
    deadline.close();
  }
}

async function invoke<T>(name: string, options: SocialRequestOptions & {
  body?: unknown;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
} = {}): Promise<T> {
  const deadline = createRequestDeadline(SOCIAL_REQUEST_TIMEOUT_MS, options.signal);
  try {
    const session = await deadline.wait(() => getSocialSession(options));
    const { data, error } = await deadline.wait(() => supabase.functions.invoke<T>(name, {
      body: options.body,
      method: options.method,
      // The SDK must not silently choose another user's bearer after an await.
      headers: { Authorization: `Bearer ${session.access_token}` },
      signal: options.signal,
      timeout: SOCIAL_REQUEST_TIMEOUT_MS,
    }));
    if (error) {
      let message = (error as { message?: string }).message || 'Requête sociale indisponible';
      const context = (error as { context?: unknown }).context;
      if (context instanceof Response) {
        try {
          const body: unknown = await deadline.wait(() => context.clone().json());
          if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
            message = body.error;
          }
        } catch { /* Keep the transport message when no structured error exists. */ }
      }
      deadline.check();
      throw new Error(message);
    }
    return data as T;
  } finally {
    deadline.close();
  }
}

export async function getConnectUrl(platform: Platform, options: SocialRequestOptions = {}): Promise<{ authUrl?: string; url?: string; auth_url?: string }> {
  return invoke('social-connect', {
    ...options,
    method: 'POST',
    body: { platform },
  });
}

export async function listAccounts(options: SocialRequestOptions = {}): Promise<SocialAccount[]> {
  return invoke<SocialAccount[]>('social-accounts', { ...options, method: 'GET' });
}

export async function listPublications(options: SocialRequestOptions = {}): Promise<SocialPublication[]> {
  // The authenticated route uses the same server-selected schema as writes.
  return invoke<SocialPublication[]>('social-publish', { ...options, method: 'GET' });
}

export async function disconnectAccount(platform: Platform, options: SocialRequestOptions = {}): Promise<{
  success: boolean;
  provider_disconnected?: boolean;
  local_disconnected?: boolean;
  requires_provider_disconnect?: boolean;
  message?: string;
}> {
  // supabase-js invoke does not directly pass query params on DELETE; use functions URL.
  const deadline = createRequestDeadline(SOCIAL_REQUEST_TIMEOUT_MS, options.signal);
  try {
    const session = await deadline.wait(() => getSocialSession(options));
    const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string) || '';
    const url = new URL(`${baseUrl}/functions/v1/social-accounts?platform=${encodeURIComponent(platform)}`, window.location.origin);
    const res = await deadline.fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string) || '',
      },
    });
    if (!res.ok) {
      throw new Error(`Disconnect failed: ${res.status} ${await deadline.wait(() => res.text())}`);
    }
    return await deadline.wait(() => res.json());
  } finally {
    deadline.close();
  }
}

export async function publishEverywhere(params: PublishParams, options: SocialRequestOptions = {}): Promise<PublicationResult> {
  const session = await getSocialSession(options);
  const clientRequestId = params.clientRequestId ?? await stablePublicationRequestId(params, session.user.id);
  const result = await invoke<unknown>('social-publish', {
    ...options,
    ownerId: session.user.id,
    method: 'POST',
    body: { ...params, clientRequestId },
  });
  return readPublicationResult(result);
}

export async function getAutopilotConfig(options: SocialRequestOptions = {}): Promise<AutopilotConfig> {
  return invoke<AutopilotConfig>('social-autopilot-config', { ...options, method: 'GET' });
}

export async function updateAutopilotConfig(
  patch: Partial<AutopilotConfig>,
  options: SocialRequestOptions = {},
): Promise<AutopilotConfig> {
  return invoke<AutopilotConfig>('social-autopilot-config', {
    ...options,
    method: 'POST',
    body: patch,
  });
}

/**
 * Helper used by AI agents: if autopilot is enabled, automatically push the
 * generated content to every connected social account. Silent on failure so
 * the agent UX is never blocked.
 */
export async function maybeAutopilot(params: PublishParams, options: SocialRequestOptions = {}): Promise<boolean> {
  try {
    const session = await getSocialSession(options);
    const scoped = { ...options, ownerId: session.user.id };
    const cfg = await getAutopilotConfig(scoped);
    if (!cfg?.autopilot_enabled) return false;
    const result = await publishEverywhere({
      ...params,
      platforms: params.platforms ?? (cfg.default_platforms?.length ? cfg.default_platforms : undefined),
      forceCaption: false,
    }, scoped);
    return result.status === 'published';
  } catch (e) {
    console.warn('[autopilot] silent failure:', e);
    return false;
  }
}
