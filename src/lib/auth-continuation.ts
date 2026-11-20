import { safeInternalPath } from './safeNavigation';
import { isValidReferralCode } from './public-share';

export const DEFAULT_AUTH_CONTINUATION = '/dashboard';
const INTERNAL_ORIGIN = 'https://purama.invalid';
const MAX_SEARCH_LENGTH = 8_192;
const AUTH_OR_REDIRECT_ROUTE = /^\/(?:login|signup|signin|sign-in|sign-up|forgot-password|reset-password|logout|signout|auth|oauth|go|api)(?:\/|$)/i;

/** A return location is navigation only: never an OAuth callback or an action. */
export function safeAuthContinuation(value: unknown): string | null {
  const internal = safeInternalPath(value);
  if (!internal) return null;

  const destination = new URL(internal, INTERNAL_ORIGIN);
  let decodedPath = destination.pathname;
  // safeInternalPath already bounds decoding. Decode the path again for the
  // route check so /%6cogin and encoded dot segments cannot create auth loops.
  for (let pass = 0; pass < 5; pass += 1) {
    const decoded = decodeURIComponent(decodedPath);
    if (decoded === decodedPath) break;
    decodedPath = decoded;
  }
  if (decodedPath.includes('?') || decodedPath.includes('#')) return null;
  const route = new URL(decodedPath, INTERNAL_ORIGIN);
  if (route.origin !== INTERNAL_ORIGIN || AUTH_OR_REDIRECT_ROUTE.test(route.pathname)) return null;

  // Only small presentation selectors survive. In particular, provider tokens,
  // emails, nested redirects and success/connected/payment flags are discarded.
  const query = new URLSearchParams();
  for (const key of ['tab', 'view'] as const) {
    const values = destination.searchParams.getAll(key);
    if (values.length === 1 && /^[a-z][a-z0-9-]{0,39}$/i.test(values[0])) {
      query.set(key, values[0]);
    }
  }
  const pages = destination.searchParams.getAll('page');
  if (pages.length === 1 && /^[1-9]\d{0,5}$/.test(pages[0])) query.set('page', pages[0]);
  // Preserve only a caller-supplied public referral code. This shape check does
  // not grant eligibility or calculate attribution; the existing service does.
  const referrals = destination.searchParams.getAll('ref');
  if (referrals.length === 1 && isValidReferralCode(referrals[0])) query.set('ref', referrals[0]);

  const hash = /^#[a-z][a-z0-9-]{0,63}$/i.test(destination.hash)
    && !/(?:token|password|secret|credential|session)/i.test(destination.hash)
    ? destination.hash : '';
  const search = query.toString();
  return `${destination.pathname}${search ? `?${search}` : ''}${hash}`;
}

function continuationFromState(from: unknown): string | null {
  if (typeof from === 'string') return safeAuthContinuation(from);
  if (!from || typeof from !== 'object') return null;
  const location = from as { pathname?: unknown; search?: unknown; hash?: unknown };
  if (typeof location.pathname !== 'string') return null;
  if (location.search !== undefined && (typeof location.search !== 'string'
    || (location.search !== '' && !location.search.startsWith('?')))) return null;
  if (location.hash !== undefined && (typeof location.hash !== 'string'
    || (location.hash !== '' && !location.hash.startsWith('#')))) return null;
  return safeAuthContinuation(`${location.pathname}${location.search ?? ''}${location.hash ?? ''}`);
}

/** Prefer one valid explicit next; preserve ProtectedRoute's state.from fallback. */
export function resolveAuthContinuation(search: string, from?: unknown): string {
  if (search.length <= MAX_SEARCH_LENGTH) {
    const params = new URLSearchParams(search);
    const nextKeys = [...params.keys()].filter((key) => key.toLowerCase() === 'next');
    if (nextKeys.length === 1 && nextKeys[0] === 'next') {
      const next = safeAuthContinuation(params.get('next'));
      if (next) return next;
    }
  }
  return continuationFromState(from) ?? DEFAULT_AUTH_CONTINUATION;
}

/** Switching login/signup carries only the validated route, never form data. */
export function authPagePath(page: '/login' | '/signup', next: unknown): string {
  const destination = safeAuthContinuation(next) ?? DEFAULT_AUTH_CONTINUATION;
  return `${page}?${new URLSearchParams({ next: destination }).toString()}`;
}
