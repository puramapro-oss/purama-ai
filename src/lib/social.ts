// Frontend client for the Social Autopilot module (Zernio)
// Wraps Supabase edge functions: social-connect, social-callback, social-accounts,
// social-publish, social-autopilot-config.
import { supabase } from '@/integrations/supabase/client';

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
  content: string;
  mediaUrls?: string[];
  contentType?: 'text' | 'image' | 'video' | 'carousel' | 'reel';
  agentName?: string;
  platforms?: Platform[];
  scheduledAt?: string;
  forceCaption?: boolean;
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

async function invoke<T>(name: string, options: {
  body?: unknown;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string>;
} = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, {
    body: options.body,
    method: options.method,
  });
  if (error) {
    const message = (error as { message?: string }).message || 'Edge function error';
    throw new Error(message);
  }
  return data as T;
}

export async function getConnectUrl(platform: Platform): Promise<{ url?: string; auth_url?: string }> {
  return invoke('social-connect', {
    method: 'POST',
    body: { platform },
  });
}

export async function listAccounts(): Promise<SocialAccount[]> {
  return invoke<SocialAccount[]>('social-accounts', { method: 'GET' });
}

export async function disconnectAccount(platform: Platform): Promise<{ success: boolean }> {
  // supabase-js invoke does not directly pass query params on DELETE; use functions URL.
  const { data: { session } } = await supabase.auth.getSession();
  const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string) || '';
  const res = await fetch(
    `${baseUrl}/functions/v1/social-accounts?platform=${encodeURIComponent(platform)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${session?.access_token ?? ''}`,
        apikey: (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string) || '',
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Disconnect failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function publishEverywhere(params: PublishParams) {
  return invoke<{ success: boolean; post_id: string; zernio: unknown }>('social-publish', {
    method: 'POST',
    body: params,
  });
}

export async function getAutopilotConfig(): Promise<AutopilotConfig> {
  return invoke<AutopilotConfig>('social-autopilot-config', { method: 'GET' });
}

export async function updateAutopilotConfig(
  patch: Partial<AutopilotConfig>,
): Promise<AutopilotConfig> {
  return invoke<AutopilotConfig>('social-autopilot-config', {
    method: 'POST',
    body: patch,
  });
}

/**
 * Helper used by AI agents: if autopilot is enabled, automatically push the
 * generated content to every connected social account. Silent on failure so
 * the agent UX is never blocked.
 */
export async function maybeAutopilot(params: PublishParams): Promise<boolean> {
  try {
    const cfg = await getAutopilotConfig();
    if (!cfg?.autopilot_enabled) return false;
    await publishEverywhere(params);
    return true;
  } catch (e) {
    console.warn('[autopilot] silent failure:', e);
    return false;
  }
}
