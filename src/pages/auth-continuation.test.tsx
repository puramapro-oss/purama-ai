import { act, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Login from './Login';
import Signup from './Signup';

const auth = vi.hoisted(() => ({ signIn: vi.fn(), signUp: vi.fn(), signInWithGoogle: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('sonner', () => ({ toast }));
vi.mock('framer-motion', () => ({
  motion: { div: ({ children, className }: PropsWithChildren<{ className?: string }>) => <div className={className}>{children}</div> },
}));

const TEMPLATE = '/modeles/230dc59b-3fae-436f-8365-e7d24998281d';
let root: Root;
let host: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function LocationProbe() {
  const location = useLocation();
  return <output data-location>{location.pathname}{location.search}{location.hash}</output>;
}

async function render(path: string, from?: unknown) {
  const url = new URL(path, 'https://app.example');
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[{
      pathname: url.pathname, search: url.search, hash: url.hash, state: from ? { from } : null,
    }]}>
      <LocationProbe />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="*" element={<p>Page choisie</p>} />
      </Routes>
    </MemoryRouter>);
  });
}

function location() { return host.querySelector('[data-location]')?.textContent; }

function input(id: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`#${id}`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function fillLogin() { input('email', 'person@example.test'); input('password', 'private-password'); }
function fillSignup() {
  input('fullName', 'Person Test'); fillLogin(); input('confirmPassword', 'private-password');
  act(() => host.querySelector<HTMLButtonElement>('#terms')!.click());
}
function submitEvent() { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
async function submit() { await act(async () => submitEvent()); }
function googleButton() { return host.querySelector<HTMLButtonElement>('button[aria-label*="Google"]')!; }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  // JSDOM has no layout observer; keep the real Radix checkbox behavior while
  // supplying only its unrelated size-observation dependency.
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  });
  auth.signIn.mockReset().mockResolvedValue({ error: null });
  auth.signUp.mockReset().mockResolvedValue({ error: null, hasSession: false });
  auth.signInWithGoogle.mockReset().mockResolvedValue({ error: null });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('login continuation', () => {
  it('returns to the chosen public template after password login', async () => {
    await render(`/login?next=${encodeURIComponent(TEMPLATE)}`);
    fillLogin(); await submit();
    expect(auth.signIn).toHaveBeenCalledWith('person@example.test', 'private-password');
    expect(location()).toBe(TEMPLATE);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('preserves the supplied public referral when returning to the template', async () => {
    const target = `${TEMPLATE}?ref=PARTNER_42-a`;
    await render(`/login?next=${encodeURIComponent(target)}`); fillLogin(); await submit();
    expect(location()).toBe(target);
  });

  it('preserves ProtectedRoute state.from and drops false business flags', async () => {
    await render('/login', { pathname: '/dashboard', search: '?tab=billing&success=true&token=secret', hash: '#usage' });
    fillLogin(); await submit();
    expect(location()).toBe('/dashboard?tab=billing#usage');
  });

  it('does not return to an external URL or an ambiguous next', async () => {
    await render('/login?next=https%3A%2F%2Fattacker.example&next=%2Fpricing');
    fillLogin(); await submit();
    expect(location()).toBe('/dashboard');
  });

  it('preserves the route while switching to signup and back', async () => {
    await render(`/login?next=${encodeURIComponent(TEMPLATE)}`);
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href^="/signup"]')!.click());
    expect(new URL(location()!, 'https://app.example').searchParams.get('next')).toBe(TEMPLATE);
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href^="/login"]')!.click());
    expect(location()).toBe(`/login?next=${encodeURIComponent(TEMPLATE)}`);
  });

  it('recovers from a rejected login without a false success or losing the route', async () => {
    auth.signIn.mockRejectedValueOnce(new Error('Réseau indisponible'));
    await render(`/login?next=${encodeURIComponent(TEMPLATE)}`);
    fillLogin(); await submit();
    expect(toast.error).toHaveBeenCalledWith('Erreur de connexion', { description: 'Réseau indisponible' });
    expect(toast.success).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(location()).toContain('/login?next=');
    await submit();
    expect(location()).toBe(TEMPLATE);
  });

  it('prevents duplicate password submissions and concurrent Google login', async () => {
    const pending = deferred<{ error: null }>(); auth.signIn.mockReturnValue(pending.promise);
    await render('/login?next=%2Fpricing'); fillLogin();
    act(() => { submitEvent(); submitEvent(); googleButton().click(); });
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    expect(auth.signInWithGoogle).not.toHaveBeenCalled();
    expect(googleButton().disabled).toBe(true);
    await act(async () => pending.resolve({ error: null }));
    expect(location()).toBe('/pricing');
  });

  it('passes the validated route to Google without claiming authentication succeeded', async () => {
    await render(`/login?next=${encodeURIComponent(`${TEMPLATE}?access_token=secret`)}`);
    await act(async () => googleButton().click());
    expect(auth.signInWithGoogle).toHaveBeenCalledWith(TEMPLATE);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('recovers from Google rejection and releases both login controls', async () => {
    auth.signInWithGoogle.mockRejectedValueOnce(new Error('Google indisponible'));
    await render('/login?next=%2Fpricing');
    await act(async () => googleButton().click());
    expect(toast.error).toHaveBeenCalledWith('Erreur Google', { description: 'Google indisponible' });
    expect(toast.success).not.toHaveBeenCalled();
    expect(googleButton().disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });

  it('does not override navigation away when a pending login finishes', async () => {
    const pending = deferred<{ error: null }>(); auth.signIn.mockReturnValue(pending.promise);
    await render(`/login?next=${encodeURIComponent(TEMPLATE)}`); fillLogin();
    act(() => submitEvent());
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href="/"]')!.click());
    await act(async () => pending.resolve({ error: null }));
    expect(location()).toBe('/');
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('signup continuation', () => {
  it('retains the chosen route after requesting email confirmation, without claiming a session', async () => {
    await render(`/signup?next=${encodeURIComponent(TEMPLATE)}`); fillSignup(); await submit();
    expect(auth.signUp).toHaveBeenCalledWith('person@example.test', 'private-password', 'Person Test', TEMPLATE);
    expect(location()).toBe(`/login?next=${encodeURIComponent(TEMPLATE)}`);
    expect(location()).not.toContain('person');
    expect(location()).not.toContain('private-password');
    expect(toast.success.mock.calls[0][0]).toBe('Vérifiez votre email pour continuer');
  });

  it('returns to the route only when signup actually yields a session', async () => {
    auth.signUp.mockResolvedValue({ error: null, hasSession: true });
    await render(`/signup?next=${encodeURIComponent(TEMPLATE)}`); fillSignup(); await submit();
    expect(location()).toBe(TEMPLATE);
  });

  it('preserves the forge CTA route across the email-confirmation flow', async () => {
    await render('/signup?next=/dashboard/creator-agent/new'); fillSignup(); await submit();
    expect(location()).toBe('/login?next=%2Fdashboard%2Fcreator-agent%2Fnew');
    fillLogin(); await submit();
    expect(location()).toBe('/dashboard/creator-agent/new');
  });

  it('does not report signup success after a provider error or rejected promise', async () => {
    auth.signUp.mockResolvedValueOnce({ error: new Error('Inscription refusée') });
    await render(`/signup?next=${encodeURIComponent(TEMPLATE)}`); fillSignup(); await submit();
    expect(toast.error).toHaveBeenCalledWith('Erreur d\'inscription', { description: 'Inscription refusée' });
    expect(toast.success).not.toHaveBeenCalled();
    auth.signUp.mockRejectedValueOnce(new Error('Connexion interrompue'));
    await submit();
    expect(toast.success).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(location()).toContain('/signup?next=');
  });

  it('passes the same route to Google signup and handles a thrown error', async () => {
    auth.signInWithGoogle.mockRejectedValueOnce(new Error('Google indisponible'));
    await render(`/signup?next=${encodeURIComponent(TEMPLATE)}`);
    await act(async () => googleButton().click());
    expect(auth.signInWithGoogle).toHaveBeenCalledWith(TEMPLATE);
    expect(toast.error).toHaveBeenCalledWith('Erreur Google', { description: 'Google indisponible' });
    expect(toast.success).not.toHaveBeenCalled();
    expect(googleButton().disabled).toBe(false);
  });
});
