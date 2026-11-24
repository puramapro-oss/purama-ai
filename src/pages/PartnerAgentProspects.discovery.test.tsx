import { act, useLayoutEffect, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PartnerAgentProspects from './PartnerAgentProspects';

const { auth, api, toast } = vi.hoisted(() => ({
  auth: { user: null as { id: string } | null },
  api: { list: vi.fn(), invoke: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: api.invoke } } }));
vi.mock('@/lib/partner', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/partner')>(), listProspects: api.list,
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  return { motion: { div: React.forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown }>((props, ref) => {
    const attributes = { ...props }; delete attributes.initial; delete attributes.animate;
    return React.createElement('div', { ...attributes, ref });
  }) } };
});

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const response = (inserted = 2) => ({ data: {
  inserted, prospects: Array.from({ length: inserted }, (_, index) => ({ id: `confirmed-${index}` })),
}, error: null });
function failureResponse(status: 'failed' | 'partial' | 'unknown', confirmed: number, code = 'discovery_timeout') {
  const bytes = new Uint8Array(new TextEncoder().encode(JSON.stringify({
    status, code, inserted: confirmed, confirmed_inserted: confirmed,
    prospects: Array.from({ length: confirmed }, (_, index) => ({ id: `confirmed-${index}` })),
    error: 'PRIVATE-PROVIDER-DIAGNOSTIC api_key=DO-NOT-DISPLAY',
  })));
  // Preserve real SDK/Response behavior with byte views from the JSDOM realm.
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  return { data: null, error: new FunctionsHttpError(new Response(body, {
    status: 503, headers: { 'Content-Type': 'application/json' },
  })) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let root: Root;
let host: HTMLDivElement;
let mounted: boolean;
async function render(owner: string | null = auth.user?.id ?? null) {
  auth.user = owner === null ? null : { id: owner };
  await act(async () => { root.render(<MemoryRouter><PartnerAgentProspects /></MemoryRouter>); });
}
function button(name: string): HTMLButtonElement {
  const value = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent?.trim() === name);
  if (!value) throw new Error(`Missing button: ${name}`);
  return value;
}
function queryInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="ex : meilleurs influenceurs finance personnelle France"]');
  if (!input) throw new Error('Missing prospect discovery query');
  return input;
}
function dialog() { return document.querySelector<HTMLElement>('[role="dialog"]'); }
async function click(name: string) { await act(async () => button(name).click()); }
async function fill(value: string) {
  await act(async () => {
    const input = queryInput();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function open(value?: string) {
  await click('Trouver via IA');
  if (value !== undefined) await fill(value);
}
async function choose(index: number, label: string) {
  const trigger = dialog()?.querySelectorAll<HTMLButtonElement>('[role="combobox"]')[index];
  if (!trigger) throw new Error(`Missing discovery select ${index}`);
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find(value => value.textContent?.trim() === label);
  if (!option) throw new Error(`Missing discovery option ${label}`);
  await act(async () => option.click());
}
function noNotifications() {
  for (const notify of Object.values(toast)) expect(notify).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  auth.user = { id: A };
  api.list.mockResolvedValue([]);
  api.invoke.mockResolvedValue(response());
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network access'); }));
  // JSDOM has no viewport scrolling; retain the real Radix selects and dialogs.
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView;
});

describe('partner discovery operation ownership with real UI and client helper', () => {
  it('opens the real discovery dialog with a valid all-niches choice', async () => {
    await render(); await open();
    expect(dialog()?.textContent).toContain('Recherche IA de prospects');
    expect(queryInput().value).toBe('');
    expect(button('Lancer la recherche').disabled).toBe(true);
    await choose(1, 'Toutes');
    expect(api.invoke).not.toHaveBeenCalled();
  });

  it('submits the current request once, then closes and refreshes only after success', async () => {
    const pending = deferred<ReturnType<typeof response>>(); api.invoke.mockReturnValueOnce(pending.promise);
    await render(); await open('Sites de création indépendants'); await click('Lancer la recherche');
    expect(api.invoke).toHaveBeenCalledExactlyOnceWith('partner-find-prospects', {
      body: { query: 'Sites de création indépendants', niche: undefined, type: 'influencer' },
    });
    expect(button('Lancer la recherche').disabled).toBe(true); noNotifications();
    expect(api.list).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(response(3)));
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('✨ 3 prospects ajoutés');
    expect(dialog()).toBeNull();
    expect(api.list).toHaveBeenCalledTimes(2); expect(api.list).toHaveBeenLastCalledWith(A);
    await open(); expect(queryInput().value).toBe('');
  });

  it('keeps a current failed query available for correction and retry', async () => {
    const pending = deferred<ReturnType<typeof failureResponse>>(); api.invoke.mockReturnValueOnce(pending.promise);
    await render(); await open('Sites spécialisés'); await click('Lancer la recherche');
    await act(async () => pending.resolve(failureResponse('failed', 0, 'provider_unavailable')));
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Erreur recherche', { description: 'Le service de recherche est temporairement indisponible.' });
    expect(toast.success).not.toHaveBeenCalled();
    expect(queryInput().value).toBe('Sites spécialisés'); expect(button('Lancer la recherche').disabled).toBe(false);
    expect(api.list).toHaveBeenCalledTimes(1);
    await click('Lancer la recherche'); expect(api.invoke).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown', 1, 'Recherche à vérifier'],
    ['partial', 2, 'Recherche partiellement enregistrée'],
  ] as const)('keeps the draft and refreshes confirmed work when an HTTP error is %s', async (status, count, title) => {
    api.invoke.mockResolvedValueOnce(failureResponse(status, count));
    await render(); await open('SITES-TO-VERIFY'); await click('Lancer la recherche');
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(title, { description: expect.stringContaining('Vérifiez la liste des prospects avant de relancer') });
    const message = toast.warning.mock.calls[0][1].description;
    expect(message).toContain(count === 1 ? '1 prospect est confirmé enregistré' : '2 prospects sont confirmés enregistrés');
    expect(message).not.toMatch(/PRIVATE-PROVIDER|api_key/u);
    expect(toast.success).not.toHaveBeenCalled(); expect(toast.error).not.toHaveBeenCalled();
    expect(queryInput().value).toBe('SITES-TO-VERIFY'); expect(button('Lancer la recherche').disabled).toBe(false);
    expect(api.list).toHaveBeenCalledTimes(2); expect(api.list).toHaveBeenLastCalledWith(A);
    expect(api.invoke).toHaveBeenCalledTimes(1);
  });

  it('does not show a raw transport diagnostic or claim a rollback when the response is missing', async () => {
    api.invoke.mockRejectedValueOnce(new Error('PRIVATE secret=unexpected-provider-body'));
    await render(); await open('UNCONFIRMED-QUERY'); await click('Lancer la recherche');
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith('Recherche à vérifier', {
      description: expect.stringContaining('Vérifiez la liste des prospects avant de relancer'),
    });
    expect(JSON.stringify(toast.warning.mock.calls)).not.toMatch(/PRIVATE|secret=/u);
    expect(toast.success).not.toHaveBeenCalled(); expect(toast.error).not.toHaveBeenCalled();
    expect(queryInput().value).toBe('UNCONFIRMED-QUERY'); expect(api.invoke).toHaveBeenCalledTimes(1);
  });

  it('does not report or refresh an old account partial HTTP receipt in the new account', async () => {
    const pending = deferred<ReturnType<typeof failureResponse>>(); api.invoke.mockReturnValueOnce(pending.promise);
    await render(); await open('PRIVATE-A'); await click('Lancer la recherche');
    await render(B); await open('CURRENT-B');
    await act(async () => pending.resolve(failureResponse('partial', 2)));
    noNotifications(); expect(queryInput().value).toBe('CURRENT-B');
    expect(api.list).toHaveBeenCalledTimes(2); expect(api.invoke).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a newer draft with an unknown HTTP receipt', async () => {
    const pending = deferred<ReturnType<typeof failureResponse>>(); api.invoke.mockReturnValueOnce(pending.promise);
    await render(); await open('ORIGINAL'); await click('Lancer la recherche');
    await fill('NEW-DRAFT');
    await act(async () => pending.resolve(failureResponse('unknown', 1)));
    noNotifications(); expect(queryInput().value).toBe('NEW-DRAFT');
    expect(button('Lancer la recherche').disabled).toBe(false); expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('admits only one request when two click events occur before React commits busy state', async () => {
    const pending = deferred<ReturnType<typeof response>>(); api.invoke.mockReturnValue(pending.promise);
    await render(); await open('Sites spécialisés');
    const launch = button('Lancer la recherche');
    await act(async () => { launch.click(); launch.click(); });
    expect(api.invoke).toHaveBeenCalledTimes(1);
    expect(launch.disabled).toBe(true);
    await act(async () => pending.resolve(response()));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('does not start discovery without a current account', async () => {
    await render(null); await open('Sites spécialisés'); await click('Lancer la recherche');
    expect(api.invoke).not.toHaveBeenCalled(); noNotifications();
  });

  it('retains a valid pending request across a same-account auth rerender', async () => {
    const pending = deferred<ReturnType<typeof response>>(); api.invoke.mockReturnValueOnce(pending.promise);
    await render(); await open('UNCHANGED-A'); await click('Lancer la recherche');
    await render(A);
    expect(queryInput().value).toBe('UNCHANGED-A'); expect(button('Lancer la recherche').disabled).toBe(true);
    await act(async () => pending.resolve(response()));
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('✨ 2 prospects ajoutés');
    expect(dialog()).toBeNull(); expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('closes and clears the old account draft, and ignores its receipt while B is searching', async () => {
    const old = deferred<ReturnType<typeof response>>(); const current = deferred<ReturnType<typeof response>>();
    api.invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await render(); await open('PRIVATE-A-QUERY'); await click('Lancer la recherche');
    await render(B); expect(dialog()).toBeNull();
    await open(); expect(queryInput().value).toBe('');
    await fill('CURRENT-B-QUERY'); await click('Lancer la recherche');
    expect(api.invoke).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(response(99)));
    noNotifications(); expect(queryInput().value).toBe('CURRENT-B-QUERY');
    expect(button('Lancer la recherche').disabled).toBe(true);
    expect(api.list).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(response(4)));
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('✨ 4 prospects ajoutés');
    expect(api.list).toHaveBeenLastCalledWith(B);
  });

  it('hides and rejects the old account draft during commit before passive effects reset it', async () => {
    const pending = deferred<ReturnType<typeof response>>(); api.invoke.mockReturnValue(pending.promise);
    let draftDuringCommit: string | null | undefined;
    function Parent({ owner }: { owner: string }) {
      useLayoutEffect(() => {
        if (owner !== B) return;
        draftDuringCommit = document.querySelector<HTMLInputElement>(
          'input[placeholder="ex : meilleurs influenceurs finance personnelle France"]',
        )?.value ?? null;
        const launch = [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find(item => item.textContent?.trim() === 'Lancer la recherche');
        launch?.click();
      }, [owner]);
      return <MemoryRouter><PartnerAgentProspects /></MemoryRouter>;
    }
    auth.user = { id: A };
    await act(async () => root.render(<Parent owner={A} />));
    await open('PRIVATE-A-DRAFT');
    auth.user = { id: B };
    await act(async () => root.render(<Parent owner={B} />));
    expect(api.invoke).not.toHaveBeenCalled();
    expect(draftDuringCommit).toBeNull();
    noNotifications();
  });

  it('does not accept an earlier A receipt or unlock a new A search after A to B to A', async () => {
    const old = deferred<ReturnType<typeof response>>(); const current = deferred<ReturnType<typeof response>>();
    api.invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await render(); await open('FIRST-A'); await click('Lancer la recherche');
    await render(B); await render(A); await open('NEW-A'); await click('Lancer la recherche');
    expect(api.invoke).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(response(99)));
    noNotifications(); expect(queryInput().value).toBe('NEW-A');
    expect(button('Lancer la recherche').disabled).toBe(true);
    expect(api.list).toHaveBeenCalledTimes(3);
    await act(async () => current.resolve(response(1)));
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('✨ 1 prospects ajoutés');
    expect(dialog()).toBeNull();
  });

  it('suppresses an old account failure without releasing the current account request', async () => {
    const old = deferred<ReturnType<typeof response>>(); const current = deferred<ReturnType<typeof response>>();
    api.invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await render(); await open('PRIVATE-A'); await click('Lancer la recherche');
    await render(B); await open('CURRENT-B'); await click('Lancer la recherche');
    await act(async () => old.reject(new Error('PRIVATE-A-ERROR')));
    noNotifications(); expect(queryInput().value).toBe('CURRENT-B');
    expect(button('Lancer la recherche').disabled).toBe(true);
    await act(async () => current.resolve(response()));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'])('ignores %s after the page has unmounted', async outcome => {
    const pending = deferred<ReturnType<typeof response>>(); api.invoke.mockReturnValueOnce(pending.promise);
    await render(); await open('Sites spécialisés'); await click('Lancer la recherche');
    await act(async () => root.unmount()); mounted = false;
    await act(async () => outcome === 'success' ? pending.resolve(response()) : pending.reject(new Error('LATE-FAILURE')));
    noNotifications(); expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('preserves a newer query without closing its dialog when the earlier result arrives', async () => {
    const pending = deferred<ReturnType<typeof response>>(); api.invoke.mockReturnValueOnce(pending.promise);
    await render(); await open('ORIGINAL'); await click('Lancer la recherche');
    await fill('NEW-DRAFT');
    await act(async () => pending.resolve(response()));
    noNotifications(); expect(queryInput().value).toBe('NEW-DRAFT');
    expect(button('Lancer la recherche').disabled).toBe(false); expect(api.list).toHaveBeenCalledTimes(1);
    await click('Lancer la recherche');
    expect(api.invoke).toHaveBeenLastCalledWith('partner-find-prospects', {
      body: { query: 'NEW-DRAFT', niche: undefined, type: 'influencer' },
    });
  });

  it('keeps a revised draft even if the user changes its text back to the original', async () => {
    const pending = deferred<ReturnType<typeof response>>(); api.invoke.mockReturnValueOnce(pending.promise);
    await render(); await open('ORIGINAL'); await click('Lancer la recherche');
    await fill('TEMPORARY'); await fill('ORIGINAL');
    await act(async () => pending.resolve(response()));
    noNotifications(); expect(queryInput().value).toBe('ORIGINAL');
    expect(button('Lancer la recherche').disabled).toBe(false); expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('keeps a reopened dialog and does not duplicate an outstanding search', async () => {
    const pending = deferred<ReturnType<typeof response>>(); api.invoke.mockReturnValueOnce(pending.promise);
    await render(); await open('SAME-DRAFT'); await click('Lancer la recherche');
    await click('Annuler'); expect(dialog()).toBeNull();
    await open(); expect(queryInput().value).toBe('SAME-DRAFT');
    expect(button('Lancer la recherche').disabled).toBe(true);
    await click('Lancer la recherche'); expect(api.invoke).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(response()));
    noNotifications(); expect(queryInput().value).toBe('SAME-DRAFT');
    expect(button('Lancer la recherche').disabled).toBe(false); expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('keeps new type and niche choices after an older discovery settles', async () => {
    const pending = deferred<ReturnType<typeof response>>(); api.invoke.mockReturnValueOnce(pending.promise);
    await render(); await open('Sites spécialisés'); await click('Lancer la recherche');
    await choose(0, '🌐 Site / blog'); await choose(1, 'tech');
    await act(async () => pending.resolve(response()));
    noNotifications(); expect(queryInput().value).toBe('Sites spécialisés');
    expect(button('Lancer la recherche').disabled).toBe(false);
    await click('Lancer la recherche');
    expect(api.invoke).toHaveBeenLastCalledWith('partner-find-prospects', {
      body: { query: 'Sites spécialisés', niche: 'tech', type: 'website' },
    });
  });
});
