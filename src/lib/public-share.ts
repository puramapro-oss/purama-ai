const PUBLIC_PATHS = new Set(['/', '/forge', '/ecosystem', '/parrainage', '/purama-compta']);
const PUBLIC_TEMPLATE_PATH = /^\/modeles\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const REFERRAL_CODE = /^[A-Za-z0-9_-]{1,64}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

interface PublicShareOptions {
  /** Pass window.location.origin, never the current page URL. */
  origin: string;
  path?: string;
  /** A code explicitly supplied by the caller; never inferred from an account ID. */
  referralCode?: string;
}

/** Structural validation only; eligibility remains a server-side decision. */
export function isValidReferralCode(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && REFERRAL_CODE.test(value);
}

/**
 * Builds only public links. This checks URL shape, not template publication or
 * referral eligibility: the corresponding server routes must enforce those.
 * Invalid explicit inputs fail closed rather than silently changing destination.
 */
export function buildPublicShareUrl({
  origin,
  path = '/',
  referralCode,
}: PublicShareOptions): string | null {
  if (typeof origin !== 'string' || origin.length > 2048 || origin !== origin.trim()) return null;
  if (typeof path !== 'string' || path !== path.trim()) return null;
  if (!PUBLIC_PATHS.has(path) && !PUBLIC_TEMPLATE_PATH.test(path)) return null;
  if (referralCode !== undefined && !isValidReferralCode(referralCode)) return null;

  try {
    const source = new URL(origin);
    // An origin has no credentials, path, query or fragment. Exact equality also
    // rejects URL spellings that a parser would silently repair or normalize.
    if (source.origin !== origin || source.username || source.password) return null;
    if (source.protocol !== 'https:' && !(source.protocol === 'http:' && LOCAL_HOSTS.has(source.hostname))) {
      return null;
    }
    const url = new URL(path, source.origin);
    if (referralCode !== undefined) url.searchParams.set('ref', referralCode);
    return url.href;
  } catch {
    return null;
  }
}
