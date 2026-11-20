import { supabase } from '@/integrations/supabase/client';
import { cancelResponseQuietly, createRequestDeadline } from './request-deadline';
import { readBoundedBytes } from '../../supabase/functions/_shared/request-body';

export type GoogleOAuthProvider = 'google_sheets' | 'gmail' | 'google_calendar' | 'google_drive';
export type OAuthPurpose = 'google_connections' | 'email_agent_gmail';
export interface OAuthContext {
  state: string;
  userId: string;
  provider: GoogleOAuthProvider;
  purpose: OAuthPurpose;
  expiresAt: string;
}
const STATE_KEY = 'oauth_state';
const CONTEXT_KEY = 'oauth_context';

export class OAuthClientError extends Error {
  constructor(readonly status = 0) { super('OAuth connection unavailable'); this.name = 'OAuthClientError'; }
}

function validContext(value: unknown): value is OAuthContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Partial<OAuthContext>;
  return typeof context.state === 'string' && /^[0-9a-f]{64}$/.test(context.state)
    && typeof context.userId === 'string' && context.userId.length > 0
    && ['google_sheets', 'gmail', 'google_calendar', 'google_drive'].includes(context.provider ?? '')
    && (context.purpose === 'google_connections' || (context.purpose === 'email_agent_gmail' && context.provider === 'gmail'))
    && typeof context.expiresAt === 'string' && Number.isFinite(Date.parse(context.expiresAt));
}

export function storeOAuthContext(context: OAuthContext): void {
  if (!validContext(context)) throw new OAuthClientError();
  // If storage is unavailable, the caller must not leave for Google. Neither
  // an unbound state nor a partial write is considered a valid local context.
  sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(context));
  sessionStorage.setItem(STATE_KEY, context.state);
}

export function readOAuthContext(): OAuthContext | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(CONTEXT_KEY) ?? 'null');
    return validContext(value) && sessionStorage.getItem(STATE_KEY) === value.state ? value : null;
  } catch { return null; }
}

export function clearOAuthContext(state: string): void {
  if (sessionStorage.getItem(STATE_KEY) !== state) return;
  const current = readOAuthContext();
  sessionStorage.removeItem(STATE_KEY);
  if (current?.state === state) sessionStorage.removeItem(CONTEXT_KEY);
}

/** A single deadline covers session lookup, HTTP headers and the bounded body.
 * Callers still own UI admission after an account change or unmount. */
export async function invokeOAuth(
  endpoint: 'oauth-google' | 'email-agent-gmail-oauth',
  body: Record<string, unknown>,
  userId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const deadlineAt = performance.now() + 30_000;
  const deadline = createRequestDeadline(30_000, signal);
  let response: Response | undefined;
  try {
    const publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    const baseUrl = import.meta.env.VITE_SUPABASE_URL;
    if (typeof publicKey !== 'string' || !publicKey.trim() || typeof baseUrl !== 'string' || !baseUrl.trim()) {
      throw new OAuthClientError(503);
    }
    const url = new URL(`/functions/v1/${endpoint}`, baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new OAuthClientError(503);
    const { data, error } = await deadline.wait(() => supabase.auth.getSession());
    if (error || !data.session?.access_token || data.session.user.id !== userId) throw new OAuthClientError(401);
    deadline.check();
    response = await deadline.fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: publicKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', credentials: 'omit', cache: 'no-store',
    });
    if (!response.ok || response.redirected) throw new OAuthClientError(response.status);
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    const bytes = await deadline.wait(() => readBoundedBytes({
      body: response!.body, headers: response!.headers, signal: signal ?? new AbortController().signal,
    }, { maxBytes: 64_000, deadline: deadlineAt, matchContentLength: !encoding || encoding === 'identity' }));
    deadline.check();
    const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new OAuthClientError();
    deadline.check();
    return result as Record<string, unknown>;
  } finally { cancelResponseQuietly(response?.body); deadline.close(); }
}
