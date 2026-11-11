// Signed, short-lived intent. A valid signature is necessary but not sufficient:
// the callback also checks and consumes the matching server-owned database row.
export const SOCIAL_STATE_TTL_SECONDS = 600;
export const OAUTH_SOCIAL_PLATFORMS = [
  "youtube", "tiktok", "instagram", "facebook", "threads", "linkedin",
  "twitter", "pinterest", "reddit", "snapchat", "google_business", "whatsapp",
] as const;
export type OAuthSocialPlatform = typeof OAUTH_SOCIAL_PLATFORMS[number];

export function isOAuthSocialPlatform(value: unknown): value is OAuthSocialPlatform {
  return typeof value === "string" &&
    (OAUTH_SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

export function isSocialUserId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isZernioId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{24}$/i.test(value);
}

export interface SocialCallbackClaims {
  userId: string;
  platform: OAuthSocialPlatform;
  profileId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  if (secret.length < 32) throw new Error("social_state_secret_unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

export async function createSocialCallbackState(
  context: Pick<SocialCallbackClaims, "userId" | "platform" | "profileId">,
  secret: string,
  nowMs = Date.now(),
): Promise<{ state: string; stateHash: string; claims: SocialCallbackClaims }> {
  if (!isSocialUserId(context.userId) || !isOAuthSocialPlatform(context.platform) ||
    !isZernioId(context.profileId) || !Number.isFinite(nowMs)) {
    throw new Error("invalid_social_state_context");
  }
  const issuedAt = Math.floor(nowMs / 1000);
  const claims: SocialCallbackClaims = {
    ...context, nonce: crypto.randomUUID(), issuedAt,
    expiresAt: issuedAt + SOCIAL_STATE_TTL_SECONDS,
  };
  const payload = ["v2", claims.userId, claims.platform, claims.profileId,
    claims.nonce, claims.issuedAt, claims.expiresAt].join(".");
  const sig = await hmacHex(secret, payload);
  const state = `${payload}.${sig}`;
  return { state, claims, stateHash: await hashSocialCallbackState(state) };
}

export async function verifySocialCallbackState(
  state: string | null,
  secret: string,
  nowMs = Date.now(),
): Promise<SocialCallbackClaims | null> {
  if (!state || state.length > 600 || secret.length < 32 || !Number.isFinite(nowMs)) return null;
  // URLSearchParams has already decoded the query. Never decode a second time.
  const parts = state.split(".");
  if (parts.length !== 8) return null;
  const [version, userId, platform, profileId, nonce, issuedAtText, expiresAtText, sig] = parts;
  if (version !== "v2" || !isSocialUserId(userId) || !isOAuthSocialPlatform(platform) ||
    !isZernioId(profileId) || !isSocialUserId(nonce) ||
    !/^\d{1,12}$/.test(issuedAtText) || !/^\d{1,12}$/.test(expiresAtText) ||
    !/^[a-f0-9]{64}$/.test(sig)) return null;
  const issuedAt = Number(issuedAtText), expiresAt = Number(expiresAtText);
  const now = Math.floor(nowMs / 1000);
  if (expiresAt <= now || issuedAt > now + 30 || expiresAt <= issuedAt ||
    expiresAt - issuedAt > SOCIAL_STATE_TTL_SECONDS) return null;
  const expectedSig = await hmacHex(secret, parts.slice(0, 7).join("."));
  if (!timingSafeEqualHex(expectedSig, sig)) return null;
  return { userId, platform, profileId, nonce, issuedAt, expiresAt };
}

export async function hashSocialCallbackState(state: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
