import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/components/auth/AuthProvider';
import { useAuth } from './useAuth';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfil, fail) => { resolve = fulfil; reject = fail; });
  return { promise, resolve, reject };
}

function sessionFor(id: string): Session {
  return {
    access_token: `test-access-${id}`, refresh_token: `test-refresh-${id}`,
    expires_in: 3600, token_type: 'bearer',
    user: {
      id, aud: 'authenticated', app_metadata: {}, user_metadata: {},
      created_at: '2026-11-10T00:00:00.000Z',
    },
  };
}

type InitialSession = { data: { session: Session | null } };
type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;

async function mountProvider() {
  await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>));
}

beforeEach(() => {
  vi.clearAllMocks();
  provider.getSession.mockReset().mockResolvedValue({ data: { session: null } });
  provider.onAuthStateChange.mockReset().mockReturnValue({ data: { subscription: { unsubscribe: provider.unsubscribe } } });
  provider.signUp.mockReset().mockResolvedValue({ data: { user: null, session: null }, error: null });
  provider.signInWithOAuth.mockReset().mockResolvedValue({ data: { url: 'https://accounts.example.test' }, error: null });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('auth provider continuation options', () => {
  beforeEach(mountProvider);

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

describe('auth provider initialization and event ordering', () => {
  it('subscribes before the deferred initial read and continues receiving later events', async () => {
    const initial = deferred<InitialSession>();
    provider.getSession.mockReturnValueOnce(initial.promise);
    await mountProvider();
    expect(provider.onAuthStateChange.mock.invocationCallOrder[0])
      .toBeLessThan(provider.getSession.mock.invocationCallOrder[0]);
    expect(auth.loading).toBe(true);

    const first = sessionFor('initial-account');
    await act(async () => initial.resolve({ data: { session: first } }));
    expect(auth.session).toBe(first);
    expect(auth.loading).toBe(false);

    const later = sessionFor('later-account');
    const onAuth = provider.onAuthStateChange.mock.calls[0][0] as AuthListener;
    await act(async () => onAuth('SIGNED_IN', later));
    expect(auth.session).toBe(later);
    expect(auth.user?.id).toBe('later-account');
  });

  it('does not overwrite a newer sign-in with a delayed initial snapshot', async () => {
    const initial = deferred<InitialSession>();
    provider.getSession.mockReturnValueOnce(initial.promise);
    await mountProvider();
    const onAuth = provider.onAuthStateChange.mock.calls[0][0] as AuthListener;
    const current = sessionFor('current-account');
    await act(async () => onAuth('SIGNED_IN', current));

    await act(async () => initial.resolve({ data: { session: sessionFor('old-account') } }));
    expect(auth.session).toBe(current);
    expect(auth.user?.id).toBe('current-account');
    expect(auth.loading).toBe(false);
  });

  it('does not restore an old account after a sign-out event during initialization', async () => {
    const initial = deferred<InitialSession>();
    provider.getSession.mockReturnValueOnce(initial.promise);
    await mountProvider();
    const onAuth = provider.onAuthStateChange.mock.calls[0][0] as AuthListener;
    await act(async () => onAuth('SIGNED_OUT', null));

    await act(async () => initial.resolve({ data: { session: sessionFor('signed-out-account') } }));
    expect(auth.session).toBeNull();
    expect(auth.user).toBeNull();
    expect(auth.loading).toBe(false);
  });

  it('does not clear a newer session when the initial read rejects', async () => {
    const initial = deferred<InitialSession>();
    provider.getSession.mockReturnValueOnce(initial.promise);
    await mountProvider();
    const current = sessionFor('current-account');
    const onAuth = provider.onAuthStateChange.mock.calls[0][0] as AuthListener;
    await act(async () => onAuth('SIGNED_IN', current));

    await act(async () => initial.reject(new Error('Initial session unavailable')));
    expect(auth.session).toBe(current);
    expect(auth.user?.id).toBe('current-account');
    expect(auth.loading).toBe(false);
  });

  it('ignores events and reads from a retired StrictMode subscription', async () => {
    const retiredRead = deferred<InitialSession>();
    const currentRead = deferred<InitialSession>();
    provider.getSession.mockReturnValueOnce(retiredRead.promise).mockReturnValueOnce(currentRead.promise);
    await act(async () => root.render(<StrictMode><AuthProvider><Probe /></AuthProvider></StrictMode>));
    expect(provider.onAuthStateChange).toHaveBeenCalledTimes(2);
    expect(provider.unsubscribe).toHaveBeenCalledTimes(1);
    const retired = provider.onAuthStateChange.mock.calls[0][0] as AuthListener;
    const current = provider.onAuthStateChange.mock.calls[1][0] as AuthListener;
    const session = sessionFor('current-account');
    await act(async () => current('SIGNED_IN', session));

    await act(async () => retired('SIGNED_OUT', null));
    expect(auth.session).toBe(session);
    await act(async () => retiredRead.resolve({ data: { session: sessionFor('retired-account') } }));
    expect(auth.session).toBe(session);
    await act(async () => currentRead.resolve({ data: { session: sessionFor('old-current-snapshot') } }));
    expect(auth.session).toBe(session);

    await act(async () => root.render(null));
    expect(provider.unsubscribe).toHaveBeenCalledTimes(2);
  });
});
