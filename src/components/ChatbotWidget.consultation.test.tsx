import { act, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatbotWidget } from './ChatbotWidget';
import { catalogFixture, deferred, operationFixture, OWNER, OTHER_OWNER } from '@/test/consultation-fixtures';

const { auth, invoke, from, legacyFetch } = vi.hoisted(() => ({
  auth: { user: null as { id: string; is_anonymous?: boolean } | null, session: null as { access_token: string } | null, loading: false },
  invoke: vi.fn(), from: vi.fn(), legacyFetch: vi.fn(),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  type Props = HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown };
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: { div: React.forwardRef<HTMLDivElement, Props>((props, ref) => {
      const attributes = { ...props };
      delete attributes.initial; delete attributes.animate; delete attributes.exit; delete attributes.transition;
      return React.createElement('div', { ...attributes, ref });
    }), span: ({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }: Props) => React.createElement('span', props) },
  };
});

let host: HTMLDivElement;
let root: Root;
let scrollTo: PropertyDescriptor | undefined;
async function render() { await act(async () => { root.render(<MemoryRouter><ChatbotWidget /></MemoryRouter>); }); }
function button(name: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(element => element.getAttribute('aria-label') === name || element.textContent?.trim() === name);
  if (!found) throw new Error(`Bouton absent : ${name}`);
  return found;
}
async function click(name: string) { await act(async () => { button(name).click(); }); }
async function fill(name: string, value: string) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${name}"]`);
  if (!input) throw new Error(`Champ absent : ${name}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.resetAllMocks(); sessionStorage.clear();
  auth.user = { id: OWNER }; auth.session = { access_token: 'first-token' }; auth.loading = false;
  invoke.mockImplementation(async (_name, { body }) => ({ data: body.action === 'catalog' ? { ok: true, catalog: catalogFixture() }
    : { ok: true, operation: operationFixture(body.operationId) }, error: null }));
  from.mockImplementation(() => ({ insert: () => ({
    select: () => ({ abortSignal: () => ({ single: async () => ({ data: { id: 'public-conversation' }, error: null }) }) }),
    abortSignal: async () => ({ error: null }),
  }) }));
  legacyFetch.mockImplementation(async () => new Response('data: {"choices":[{"delta":{"content":"Réponse du chat habituel."}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  vi.stubEnv('VITE_SUPABASE_URL', 'https://project.supabase.co'); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'public-key');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/iao-consultation')) {
      const response = await invoke('iao-consultation', { ...init, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify(response.data), { headers: { 'Content-Type': 'application/json' } });
    }
    return legacyFetch(url, init);
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); host.remove(); sessionStorage.clear();
  if (scrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollTo); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('ChatbotWidget — connected private consultation mode', () => {
  it('mounts the real consultation client without forwarding the existing chat history and restores the chat', async () => {
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Ancienne discussion privée'); await click('Envoyer le message');
    expect(host.textContent).toContain('Réponse du chat habituel.');
    expect(legacyFetch).toHaveBeenCalledTimes(1);
    await click('Consultation IA');
    expect(host.querySelector('[aria-label="Consultation entre modèles"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Votre message"]')).toBeNull();
    expect(host.textContent).not.toContain('Ancienne discussion privée');
    await fill('Question de consultation', 'Question indépendante'); await click('Lancer la consultation');
    const request = invoke.mock.calls.find(call => call[1].body.action === 'consult');
    expect(request?.[0]).toBe('iao-consultation');
    expect(request?.[1].headers).toMatchObject({ Authorization: 'Bearer first-token' });
    expect(request?.[1].body).toMatchObject({ action: 'consult', question: 'Question indépendante', reviewerModels: [], research: { queries: [], urls: [] } });
    expect(JSON.stringify(request?.[1].body)).not.toMatch(/Ancienne|chat habituel|messages|userId|budget/);
    expect(host.textContent).toContain('Une réponse utile.');
    expect(legacyFetch).toHaveBeenCalledTimes(1);
    await click('Conversation');
    expect(host.textContent).toContain('Ancienne discussion privée'); expect(host.textContent).toContain('Réponse du chat habituel.');
    expect(host.textContent).not.toContain('Une réponse utile.');
    await fill('Votre message', 'Suite de la conversation'); await click('Envoyer le message');
    expect(JSON.parse(legacyFetch.mock.calls[1][1].body).messages).toEqual([
      { role: 'user', content: 'Ancienne discussion privée' }, { role: 'assistant', content: 'Réponse du chat habituel.' },
      { role: 'user', content: 'Suite de la conversation' },
    ]);
    expect(invoke.mock.calls.filter(call => call[1].body.action === 'consult')).toHaveLength(1);
  });

  it('keeps public chat usable without exposing private consultation to visitors or anonymous sessions', async () => {
    auth.user = null; auth.session = null;
    await render(); await click("Ouvrir l'assistant PURA");
    expect(host.querySelector('[aria-label="Mode de conversation"]')).toBeNull();
    await fill('Votre message', 'Question du visiteur'); await click('Envoyer le message');
    expect(host.textContent).toContain('Réponse du chat habituel.');
    expect(legacyFetch).toHaveBeenCalledTimes(1); expect(from).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
    auth.user = { id: OWNER, is_anonymous: true }; auth.session = { access_token: 'anonymous-token' };
    await render();
    expect(host.querySelector('[aria-label="Mode de conversation"]')).toBeNull(); expect(invoke).not.toHaveBeenCalled();
  });

  it('aborts and clears the old private panel when the account changes, keeping old results out of the new account', async () => {
    const pending = deferred<unknown>();
    invoke.mockImplementation(async (_name, { body }) => body.action === 'consult' ? pending.promise : { data: { ok: true, catalog: catalogFixture() }, error: null });
    await render(); await click("Ouvrir l'assistant PURA"); await click('Consultation IA');
    await fill('Question de consultation', 'Secret du premier compte'); await click('Lancer la consultation');
    const request = invoke.mock.calls.find(call => call[1].body.action === 'consult')![1];
    auth.user = { id: OTHER_OWNER }; auth.session = { access_token: 'second-token' };
    await render();
    expect(request.signal.aborted).toBe(true);
    expect(host.textContent).not.toContain('Secret du premier compte');
    expect(host.querySelector('[aria-label="Consultation entre modèles"]')).toBeNull();
    await act(async () => { pending.resolve({ data: { ok: true, operation: operationFixture(request.body.operationId) }, error: null }); });
    await click('Consultation IA');
    expect(host.textContent).not.toContain('Une réponse utile.');
    expect(host.textContent).not.toContain('Vérifier le résultat');
    expect(invoke.mock.calls.at(-1)?.[1].headers).toMatchObject({ Authorization: 'Bearer second-token' });
    expect(invoke.mock.calls.filter(call => call[1].body.action === 'consult')).toHaveLength(1);
  });
});
