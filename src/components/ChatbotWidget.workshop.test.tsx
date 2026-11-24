import { act, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, type Location } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatbotWidget } from './ChatbotWidget';
import { OriginForgeDemo } from './OriginForgeDemo';

const { auth, from, modelFetch } = vi.hoisted(() => ({
  auth: { user: { id: 'alice' } as { id: string; is_anonymous?: boolean } | null, loading: false, session: { access_token: 'test-token' } },
  from: vi.fn(), modelFetch: vi.fn(),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from, functions: { invoke: vi.fn() } } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  type Props = HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown; whileInView?: unknown; viewport?: unknown };
  const clean = (props: Props) => {
    const attributes = { ...props };
    delete attributes.initial; delete attributes.animate; delete attributes.exit; delete attributes.transition;
    delete attributes.whileInView; delete attributes.viewport;
    return attributes;
  };
  return { AnimatePresence: ({ children }: { children: ReactNode }) => children, motion: {
    div: React.forwardRef<HTMLDivElement, Props>((props, ref) => React.createElement('div', { ...clean(props), ref })),
    span: (props: Props) => React.createElement('span', clean(props)),
  } };
});

let root: Root;
let host: HTMLDivElement;
let route: Location;
let scrollTo: PropertyDescriptor | undefined;
function LocationProbe() { route = useLocation(); return null; }
async function render(origin = false) {
  await act(async () => root.render(<MemoryRouter>{origin ? <OriginForgeDemo /> : <ChatbotWidget />}<LocationProbe /></MemoryRouter>));
}
function button(name: string) {
  const element = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === name || item.textContent?.trim() === name || item.textContent?.includes(name));
  if (!element) throw new Error('Missing button: ' + name);
  return element;
}
async function click(name: string) { await act(async () => button(name).click()); }
async function fill(value: string, origin = false) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(origin ? '#origin-workshop-prompt' : '[aria-label="Votre message"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(origin ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.resetAllMocks(); sessionStorage.clear();
  auth.user = { id: 'alice' }; auth.loading = false;
  from.mockImplementation(() => ({ insert: () => ({
    select: () => ({ abortSignal: () => ({ single: async () => ({ data: { id: 'conversation-alice' }, error: null }) }) }),
    abortSignal: async () => ({ error: null }),
  }) }));
  modelFetch.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"Prévoir un menu accessible et une confirmation."}}]}\n\ndata: [DONE]\n\n'));
  vi.stubGlobal('fetch', modelFetch);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  if (scrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollTo); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear();
});

describe('ChatbotWidget workshop preparation', () => {
  it('copies the current completed conversation without another model call or losing its source', async () => {
    await render(); await click("Ouvrir l'assistant PURA");
    const goal = 'Créer un site pour mon restaurant avec réservation accessible.';
    await fill(goal); await click('Envoyer le message');
    expect(host.textContent).toContain('Prévoir un menu accessible');
    await click('Préparer dans l’atelier');
    expect(route.pathname).toBe('/dashboard/atelier');
    expect(route.search).toBe('');
    expect(route.state.workshopDraft).toMatchObject({ ownerId: 'alice', id: expect.any(String) });
    expect(route.state.workshopDraft.prompt).toContain(goal);
    expect(route.state.workshopDraft.prompt).toContain('PURA : Prévoir un menu accessible');
    expect(route.state.workshopDraft.prompt).not.toContain('Bonjour, je suis PURA');
    expect(modelFetch).toHaveBeenCalledTimes(1);
    await click("Ouvrir l'assistant PURA");
    expect(host.textContent).toContain(goal);
    expect(host.textContent).toContain('Prévoir un menu accessible');
  });
  it('prepares an unsent editable idea locally and preserves it in the composer', async () => {
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Construire une application pour les réservations de groupes.');
    await click('Préparer dans l’atelier');
    expect(modelFetch).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
    expect(route.state.workshopDraft.prompt).toContain('Objectif à réaliser :\nConstruire une application');
    await click("Ouvrir l'assistant PURA");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Votre message"]')?.value).toBe('Construire une application pour les réservations de groupes.');
  });
  it('refuses preparation during a stream and excludes the partial answer after stopping it', async () => {
    modelFetch.mockImplementation(async (_url, init: RequestInit) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Fragment provisoire"}}]}\n\n'));
      init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } })));
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Créer un site pour mon restaurant et ses réservations.');
    await click('Envoyer le message');
    expect(button('Préparer dans l’atelier').disabled).toBe(true);
    await click('Préparer dans l’atelier'); expect(route.pathname).toBe('/');
    await click('Arrêter la réponse');
    await click('Préparer dans l’atelier');
    expect(route.state.workshopDraft.prompt).not.toMatch(/Fragment provisoire|Réponse arrêtée/);
    expect(route.state.workshopDraft.prompt.match(/Créer un site/g)).toHaveLength(1);
    expect(modelFetch).toHaveBeenCalledTimes(1);
  });
  it('blocks an authentication transition and removes the previous account context', async () => {
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Demande privée Alice qui doit rester dans son compte.');
    auth.loading = true; await render();
    expect(button('Préparer dans l’atelier').disabled).toBe(true);
    await click('Préparer dans l’atelier'); expect(route.pathname).toBe('/');
    auth.user = { id: 'bob' }; auth.loading = false; await render();
    expect(host.textContent).not.toContain('Demande privée Alice');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Votre message"]')?.value).toBe('');
    expect(sessionStorage.getItem('purama.workshop.draft.v1')).toBeNull();
    expect(modelFetch).not.toHaveBeenCalled();
  });
});

describe('OriginForge authenticated and pre-authentication handoff', () => {
  it('keeps a guest on the page with an actionable error when storage cannot preserve the idea', async () => {
    auth.user = null; await render(true);
    const goal = 'Une idée de site rédigée avant de me connecter.';
    await fill(goal, true);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    await click('Ouvrir l’atelier');
    expect(route.pathname).toBe('/');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Votre texte reste ici');
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(goal);
    expect(modelFetch).not.toHaveBeenCalled();
  });
  it('passes a fresh bound route for a signed-in owner despite storage failure', async () => {
    await render(true); await fill('Une demande fraîche à préparer dans mon atelier.', true);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    await click('Ouvrir l’atelier');
    expect(route.pathname).toBe('/dashboard/atelier');
    expect(route.state.workshopDraft).toMatchObject({ ownerId: 'alice', prompt: 'Une demande fraîche à préparer dans mon atelier.' });
    expect(route.state.workshopPrompt).toBeUndefined();
  });
  it('stores a short-lived guest draft for authentication without placing private text in route state', async () => {
    auth.user = null; await render(true); await fill('Une idée à reprendre après ma connexion au compte.', true);
    await click('Ouvrir l’atelier');
    expect(route.pathname).toBe('/dashboard/atelier');
    expect(route.state).toBeNull();
    expect(route.search).toBe('');
    expect(JSON.parse(sessionStorage.getItem('purama.workshop.draft.v1')!)).toMatchObject({ ownerId: null, id: expect.any(String), createdAt: expect.any(Number) });
  });
});
