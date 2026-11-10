import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './useAuth';

const provider = vi.hoisted(() => ({
  getSession: vi.fn(), onAuthStateChange: vi.fn(), signUp: vi.fn(),
  signInWithOAuth: vi.fn(), unsubscribe: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: provider } }));

const TEMPLATE = '/modeles/230dc59b-3fae-436f-8365-e7d24998281d';
let auth: ReturnType<typeof useAuth>;
let root: Root;
let host: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() { auth = useAuth(); return null; }

beforeEach(async () => {
  vi.clearAllMocks();
  provider.getSession.mockResolvedValue({ data: { session: null } });
  provider.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: provider.unsubscribe } } });
  provider.signUp.mockReset().mockResolvedValue({ data: { user: null, session: null }, error: null });
  provider.signInWithOAuth.mockReset().mockResolvedValue({ data: { url: 'https://accounts.example.test' }, error: null });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('auth provider continuation options', () => {
  it('keeps the original email redirect when the optional argument is omitted', async () => {
    const result = await auth.signUp('person@example.test', 'private-password', 'Person');
    expect(provider.signUp.mock.calls[0][0].options.emailRedirectTo).toBe(window.location.origin);
    expect(result).toEqual({ error: null, hasSession: false });
  });

  it('uses the chosen internal destination for confirmation emails', async () => {
    await auth.signUp('person@example.test', 'private-password', 'Person', TEMPLATE);
    expect(provider.signUp.mock.calls[0][0]).toEqual({
      email: 'person@example.test', password: 'private-password',
      options: { emailRedirectTo: `${window.location.origin}${TEMPLATE}`, data: { full_name: 'Person' } },
    });
  });

  it('reports only the presence of an issued session, without forwarding its tokens', async () => {
    provider.signUp.mockResolvedValueOnce({ data: { session: { access_token: 'private-access', refresh_token: 'private-refresh' } }, error: null });
    const result = await auth.signUp('person@example.test', 'private-password', 'Person', TEMPLATE);
    expect(result).toEqual({ error: null, hasSession: true });
    expect(JSON.stringify(result)).not.toContain('private-access');
    expect(provider.signUp.mock.calls[0][0].options.emailRedirectTo).not.toContain('private-access');
  });

  it('keeps the original Google dashboard destination without a next argument', async () => {
    await auth.signInWithGoogle();
    expect(provider.signInWithOAuth.mock.calls[0][0].options.redirectTo).toBe(`${window.location.origin}/dashboard`);
  });

  it('uses a validated template route for Google and preserves provider options', async () => {
    await auth.signInWithGoogle(TEMPLATE);
    expect(provider.signInWithOAuth.mock.calls[0][0]).toEqual({
      provider: 'google', options: {
        redirectTo: `${window.location.origin}${TEMPLATE}`,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
  });

  it('preserves an explicit referral in both provider destinations without inventing one', async () => {
    const next = `${TEMPLATE}?ref=PARTNER_42-a`;
    await auth.signInWithGoogle(next);
    await auth.signUp('person@example.test', 'private-password', 'Person', next);
    expect(provider.signInWithOAuth.mock.calls[0][0].options.redirectTo).toBe(`${window.location.origin}${next}`);
    expect(provider.signUp.mock.calls[0][0].options.emailRedirectTo).toBe(`${window.location.origin}${next}`);
  });

  it.each(['https://attacker.example', '//attacker.example', '/%5cattacker.example', '/login?next=/signup'])(
    'does not pass unsafe redirects to either provider operation: %s', async (next) => {
      await auth.signInWithGoogle(next);
      await auth.signUp('person@example.test', 'private-password', 'Person', next);
      expect(provider.signInWithOAuth.mock.calls[0][0].options.redirectTo).toBe(`${window.location.origin}/dashboard`);
      expect(provider.signUp.mock.calls[0][0].options.emailRedirectTo).toBe(`${window.location.origin}/dashboard`);
    });

  it('strips token and false-success parameters before calling the auth service', async () => {
    const next = `${TEMPLATE}?access_token=secret&success=true#refresh_token=secret`;
    await auth.signInWithGoogle(next);
    await auth.signUp('person@example.test', 'private-password', 'Person', next);
    expect(provider.signInWithOAuth.mock.calls[0][0].options.redirectTo).toBe(`${window.location.origin}${TEMPLATE}`);
    expect(provider.signUp.mock.calls[0][0].options.emailRedirectTo).toBe(`${window.location.origin}${TEMPLATE}`);
  });

  it('keeps provider errors as errors instead of manufacturing authentication success', async () => {
    const error = new Error('Authentication failed');
    provider.signUp.mockResolvedValueOnce({ data: { session: null }, error });
    provider.signInWithOAuth.mockResolvedValueOnce({ data: { url: null }, error });
    expect(await auth.signUp('person@example.test', 'private-password', 'Person', TEMPLATE))
      .toEqual({ error, hasSession: false });
    expect(await auth.signInWithGoogle(TEMPLATE)).toEqual({ error });
  });
});
