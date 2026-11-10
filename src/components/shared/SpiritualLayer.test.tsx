import { act, createElement, type HTMLAttributes, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpiritualLayer } from './SpiritualLayer';

const { authState, recordAffirmation, useAwakeningMock } = vi.hoisted(() => {
  const recordAffirmation = vi.fn();
  return {
    authState: { user: null as { id: string } | null, loading: false },
    recordAffirmation,
    useAwakeningMock: vi.fn(() => ({ recordAffirmation })),
  };
});

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => authState }));
vi.mock('@/hooks/useAwakening', () => ({ useAwakening: useAwakeningMock }));

// Preserve React and router lifecycles; decorative animation alone is mocked.
vi.mock('framer-motion', async () => {
  const React = await import('react');
  type MotionProps = HTMLAttributes<HTMLDivElement> & {
    initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown;
  };
  return {
    motion: {
      div: React.forwardRef<HTMLDivElement, MotionProps>((props, ref) => {
        const attributes = { ...props };
        delete attributes.initial;
        delete attributes.animate;
        delete attributes.exit;
        delete attributes.transition;
        return React.createElement('div', { ...attributes, ref });
      }),
    },
    AnimatePresence: ({ children }: PropsWithChildren) => children,
  };
});

const SESSION_KEY = 'purama_affirmation_shown';
const MODEL_PATH = '/modeles/a6211822-fc3c-4c77-854a-3bc79dd4405d';
const USER_A = { id: 'a3715760-353c-414d-a782-5d3efaf02eb9' };
const USER_B = { id: 'b648fb21-132c-48e4-aee2-f17ae77bcaca' };
let host: HTMLDivElement;
let root: Root | null;
let navigate: NavigateFunction;
let initialPath: string;
let timerSpies: ReturnType<typeof createTimerSpies>;

function createTimerSpies() {
  return {
    schedule: vi.spyOn(globalThis, 'setTimeout'),
    cancel: vi.spyOn(globalThis, 'clearTimeout'),
  };
}

// Inspect the actual handles of the affirmation's 1,500 ms delay. A global
// fake-timer count also includes React/DOM housekeeping and is not a leak test.
function scheduledAffirmationTimers() {
  return timerSpies.schedule.mock.calls.flatMap(([, delay], index) => {
    const result = timerSpies.schedule.mock.results[index];
    return delay === 1500 && result.type === 'return' ? [result.value] : [];
  });
}

function expectCancelled(handles: ReturnType<typeof scheduledAffirmationTimers>) {
  expect(handles.length).toBeGreaterThan(0);
  for (const handle of handles) expect(timerSpies.cancel).toHaveBeenCalledWith(handle);
}

function Harness() {
  navigate = useNavigate();
  return createElement(SpiritualLayer);
}

async function render(path = initialPath) {
  initialPath = path;
  await act(async () => {
    root?.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(Harness)));
  });
}

async function advance(milliseconds: number) {
  await act(async () => { vi.advanceTimersByTime(milliseconds); });
}

function dialog() {
  return host.querySelector('[role="dialog"]');
}

function acceptButton(): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')]
    .find(element => element.textContent?.trim().startsWith("J'integre"));
  if (!button) throw new Error('Affirmation acceptance button unavailable');
  return button;
}

function closeButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label]');
  if (!button) throw new Error('Affirmation close button unavailable');
  expect(button.getAttribute('aria-label')).toBe("Fermer l'affirmation du jour");
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  timerSpies = createTimerSpies();
  authState.user = USER_A;
  authState.loading = false;
  initialPath = '/dashboard';
  window.sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SpiritualLayer', () => {
  it.each([
    MODEL_PATH,
    `/login?next=${MODEL_PATH}`,
    `/signup?next=${MODEL_PATH}`,
    '/forgot-password',
    '/reset-password#access_token=private',
    '/oauth/callback?code=private',
    '/dashboard/creator-agent/templates',
    '/dashboard/creator-agent/a6211822-fc3c-4c77-854a-3bc79dd4405d',
    '/dashboard/creator-agent/new',
    '/dashboard?next=model',
    '/dashboard#agents',
    '/',
    '/?code=private',
    '/go/AMB-42',
    '/forge',
    '/ecosystem',
    '/parrainage',
    '/purama-compta',
  ])('diffère l’affirmation sur la destination %s, même pour un compte connecté', async path => {
    await render(path);
    await advance(5000);
    expect(dialog()).toBeNull();
    expect(scheduledAffirmationTimers()).toEqual([]);
    expect(useAwakeningMock).not.toHaveBeenCalled();
    expect(recordAffirmation).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it.each([
    { label: 'sans utilisateur', user: null, loading: false },
    { label: 'pendant le chargement de l’authentification', user: USER_A, loading: true },
  ])('ne monte pas l’affirmation $label', async ({ user, loading }) => {
    authState.user = user;
    authState.loading = loading;
    await render();
    await advance(5000);
    expect(dialog()).toBeNull();
    expect(scheduledAffirmationTimers()).toEqual([]);
    expect(useAwakeningMock).not.toHaveBeenCalled();
    expect(recordAffirmation).not.toHaveBeenCalled();
  });

  it('préserve le délai de 1 500 ms sur l’accueil connecté', async () => {
    await render();
    expect(dialog()).toBeNull();
    expect(scheduledAffirmationTimers()).toHaveLength(1);
    await advance(1499);
    expect(dialog()).toBeNull();
    await advance(1);
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(host.querySelector('#daily-affirmation-title')?.textContent).toContain('Affirmation du jour');
    expect(recordAffirmation).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('commence le délai seulement quand le compte est chargé', async () => {
    authState.loading = true;
    await render();
    await advance(2000);
    expect(dialog()).toBeNull();
    authState.loading = false;
    await render();
    expect(scheduledAffirmationTimers()).toHaveLength(1);
    await advance(1499);
    expect(dialog()).toBeNull();
    await advance(1);
    expect(dialog()).not.toBeNull();
    expect(recordAffirmation).not.toHaveBeenCalled();
  });

  it.each([1000, 1500])('retire l’overlay et annule son minuteur en quittant l’accueil à %i ms', async elapsed => {
    await render();
    const handles = scheduledAffirmationTimers();
    await advance(elapsed);
    expect(dialog() !== null).toBe(elapsed === 1500);
    await act(async () => { navigate(MODEL_PATH); });
    expect(dialog()).toBeNull();
    expectCancelled(handles);
    await advance(5000);
    expect(dialog()).toBeNull();
    expect(recordAffirmation).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('peut proposer l’affirmation au retour à l’accueil après un simple report', async () => {
    await render();
    await advance(1000);
    await act(async () => { navigate(MODEL_PATH); });
    await advance(5000);
    await act(async () => { navigate('/dashboard'); });
    expect(dialog()).toBeNull();
    await advance(1500);
    expect(dialog()).not.toBeNull();
    expect(recordAffirmation).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it.each([1000, 1500])('retire immédiatement l’affirmation lors d’une déconnexion à %i ms', async elapsed => {
    await render();
    const handles = scheduledAffirmationTimers();
    await advance(elapsed);
    authState.user = null;
    await render();
    expect(dialog()).toBeNull();
    expectCancelled(handles);
    await advance(5000);
    expect(dialog()).toBeNull();
    expect(recordAffirmation).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it.each([1000, 1500])('isole le délai du nouveau compte après un changement à %i ms', async elapsed => {
    await render();
    const oldHandles = scheduledAffirmationTimers();
    await advance(elapsed);
    authState.user = USER_B;
    await render();
    expect(dialog()).toBeNull();
    expectCancelled(oldHandles);
    expect(scheduledAffirmationTimers()).toHaveLength(2);
    await advance(1499);
    expect(dialog()).toBeNull();
    await advance(1);
    expect(dialog()).not.toBeNull();
    expect(recordAffirmation).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('ne comptabilise une affirmation qu’après son acceptation explicite', async () => {
    await render();
    await advance(1500);
    expect(recordAffirmation).not.toHaveBeenCalled();
    await act(async () => { acceptButton().click(); });
    expect(dialog()).toBeNull();
    expect(recordAffirmation).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe('true');
    await advance(5000);
    expect(recordAffirmation).toHaveBeenCalledTimes(1);
  });

  it('ferme et mémorise un refus sans comptabiliser une acceptation', async () => {
    await render();
    await advance(1500);
    await act(async () => { closeButton().click(); });
    expect(dialog()).toBeNull();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe('true');
    await advance(5000);
    expect(recordAffirmation).not.toHaveBeenCalled();
  });

  it('respecte la mémorisation de session sur l’accueil admissible', async () => {
    window.sessionStorage.setItem(SESSION_KEY, 'true');
    await render();
    await advance(5000);
    expect(dialog()).toBeNull();
    expect(scheduledAffirmationTimers()).toEqual([]);
    expect(recordAffirmation).not.toHaveBeenCalled();
  });

  it('annule le minuteur au démontage sans enregistrer une acceptation', async () => {
    await render();
    const handles = scheduledAffirmationTimers();
    await act(async () => { root?.unmount(); root = null; });
    expectCancelled(handles);
    await advance(5000);
    expect(dialog()).toBeNull();
    expect(recordAffirmation).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});
