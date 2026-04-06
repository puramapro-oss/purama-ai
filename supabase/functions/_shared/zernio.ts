// Shared Zernio API helper for edge functions
const ZERNIO_API_KEY = Deno.env.get("ZERNIO_API_KEY") ?? "";
const ZERNIO_BASE = Deno.env.get("ZERNIO_BASE_URL") || "https://zernio.com/api/v1";

export type Platform =
  | "youtube"
  | "tiktok"
  | "instagram"
  | "facebook"
  | "threads"
  | "linkedin"
  | "twitter"
  | "bluesky"
  | "pinterest"
  | "reddit"
  | "telegram"
  | "whatsapp"
  | "snapchat"
  | "google_business";

export const SUPPORTED_PLATFORMS: Platform[] = [
  "youtube",
  "tiktok",
  "instagram",
  "facebook",
  "threads",
  "linkedin",
  "twitter",
  "bluesky",
  "pinterest",
  "reddit",
  "telegram",
  "whatsapp",
  "snapchat",
  "google_business",
];

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

async function zernioFetch(path: string, options: RequestInit = {}) {
  if (!ZERNIO_API_KEY) {
    throw new Error("ZERNIO_API_KEY missing in edge function secrets");
  }
  const res = await fetch(`${ZERNIO_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${ZERNIO_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Zernio ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function getConnectUrl(platform: Platform, callbackUrl: string) {
  return zernioFetch("/profiles/connect", {
    method: "POST",
    body: JSON.stringify({ platform, callback_url: callbackUrl }),
  });
}

export async function listProfiles() {
  return zernioFetch("/profiles");
}

export async function publishPost(params: {
  text?: string;
  mediaUrls?: string[];
  platforms: Platform[];
  profileIds: string[];
  scheduledAt?: string;
}) {
  return zernioFetch("/posts", {
    method: "POST",
    body: JSON.stringify({
      text: params.text,
      media_urls: params.mediaUrls,
      platforms: params.platforms,
      profile_ids: params.profileIds,
      scheduled_at: params.scheduledAt,
    }),
  });
}

export async function getPost(postId: string) {
  return zernioFetch(`/posts/${postId}`);
}

export async function deleteProfile(profileId: string) {
  return zernioFetch(`/profiles/${profileId}`, { method: "DELETE" });
}
