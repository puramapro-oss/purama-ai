import { act, createElement, StrictMode, type HTMLAttributes, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CinematicIntro } from './CinematicIntro';

// Keep real React/router behavior; only decorative motion is replaced.
// Timer assertions below inspect the introduction's scheduled handles because
// React and the DOM environment may also schedule unrelated housekeeping work.
vi.mock('framer-motion', async () => {
  const React = await import('react');
  type MotionProps = HTMLAttributes<HTMLElement> & {
    initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown;
  };
  function element(tag: 'div' | 'h1' | 'p') {
    return React.forwardRef<HTMLElement, MotionProps>((props, ref) => {
      const attributes = { ...props };
      delete attributes.initial;
      delete attributes.animate;
      delete attributes.exit;
      delete attributes.transition;
      return React.createElement(tag, { ...attributes, ref });
    });
  }
  return {
    motion: { div: element('div'), h1: element('h1'), p: element('p') },
    AnimatePresence: ({ children }: PropsWithChildren) => children,
  };
});

const SEEN_KEY = 'purama_ai_intro_seen';
const INTRO_DELAYS = [800, 2000, 3500];
const mediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
let host: HTMLDivElement;
let previousControl: HTMLButtonElement;
let root: Root | null;
let navigate: NavigateFunction;
let reducedMotion: boolean;
let listeners: Set<(event: MediaQueryListEvent) => void>;
let timerSpies: ReturnType<typeof createTimerSpies>;

function createTimerSpies() {
  return {
    schedule: vi.spyOn(globalThis, 'setTimeout'),
    cancel: vi.spyOn(globalThis, 'clearTimeout'),
  };
}

function scheduledIntroTimers() {
  return timerSpies.schedule.mock.calls.flatMap(([, delay], index) => {
    const result = timerSpies.schedule.mock.results[index];
    return delay !== undefined && INTRO_DELAYS.includes(delay) && result.type === 'return'
      ? [{ delay, handle: result.value }]
      : [];
  });
}

function uncancelledIntroDelays() {
  const cancelled = new Set(timerSpies.cancel.mock.calls.map(([handle]) => handle));
  return scheduledIntroTimers()
    .filter(({ handle }) => !cancelled.has(handle))
    .map(({ delay }) => delay);
}

function expectIntroTimersCancelled() {
  const timers = scheduledIntroTimers();
  expect(timers.length).toBeGreaterThanOrEqual(INTRO_DELAYS.length);
  for (const { handle } of timers) expect(timerSpies.cancel).toHaveBeenCalledWith(handle);
}

function Harness() {
  navigate = useNavigate();
  return createElement(CinematicIntro);
}

async function render(path = '/', strict = false) {
  const app = createElement(MemoryRouter, { initialEntries: [path] }, createElement(Harness));
  await act(async () => root?.render(strict ? createElement(StrictMode, {}, app) : app));
}

function skipButton(): HTMLButtonElement {
  const button = host.querySelector('button');
  if (!button) throw new Error('No keyboard-accessible skip button');
  return button;
}

beforeEach(() => {
  vi.useFakeTimers();
  timerSpies = createTimerSpies();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.localStorage.clear();
  reducedMotion = false;
  listeners = new Set();
  const media = {
    get matches() { return reducedMotion; },
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    dispatchEvent: vi.fn(),
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => media as unknown as MediaQueryList),
  });
  previousControl = document.createElement('button');
  previousControl.textContent = 'Accueil';
  document.body.append(previousControl);
  previousControl.focus();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  previousControl.remove();
  vi.restoreAllMocks();
  window.localStorage.clear();
  if (mediaDescriptor) Object.defineProperty(window, 'matchMedia', mediaDescriptor);
  else Reflect.deleteProperty(window, 'matchMedia');
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CinematicIntro', () => {
  it.each([
    '/modeles/a6211822-fc3c-4c77-854a-3bc79dd4405d',
    '/login', '/signup', '/oauth/callback?code=private', '/dashboard', '/forge',
    '/?code=private', '/#creation',
  ])('laisse immédiatement accessible la destination %s', async (path) => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    await render(path);
    expect(host.childElementCount).toBe(0);
    expect(scheduledIntroTimers()).toEqual([]);
    expect(get).not.toHaveBeenCalledWith(SEEN_KEY);
  });

  it('garde une introduction sur le premier accueil avec un bouton immédiatement utilisable', async () => {
    await render();
    const button = skipButton();
    expect(button.type).toBe('button');
    expect(button.textContent).toMatch(/passer.*introduction/i);
    expect(document.activeElement).toBe(button);
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(uncancelledIntroDelays()).toEqual(INTRO_DELAYS);
  });

  it('respecte la préférence de mouvement réduit dès la première visite', async () => {
    reducedMotion = true;
    await render();
    expect(host.childElementCount).toBe(0);
    expect(scheduledIntroTimers()).toEqual([]);
  });

  it('ferme immédiatement la séquence si le mouvement réduit est activé', async () => {
    await render();
    expect(listeners.size).toBe(1);
    reducedMotion = true;
    await act(async () => {
      for (const listener of [...listeners]) listener({ matches: true } as MediaQueryListEvent);
    });
    expect(host.childElementCount).toBe(0);
    expectIntroTimersCancelled();
    expect(listeners.size).toBe(0);
  });

  it('privilégie l’accès direct si la lecture du stockage est refusée', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    await render();
    expect(host.childElementCount).toBe(0);
    expect(scheduledIntroTimers()).toEqual([]);
  });

  it('ferme sans erreur si la mémorisation de la préférence est refusée', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    await render();
    await act(async () => skipButton().click());
    expect(host.childElementCount).toBe(0);
    expectIntroTimersCancelled();
    await act(async () => navigate('/login'));
    await act(async () => navigate('/'));
    expect(host.childElementCount).toBe(0);
  });

  it('ne rejoue pas une introduction déjà mémorisée', async () => {
    window.localStorage.setItem(SEEN_KEY, '1');
    await render();
    expect(host.childElementCount).toBe(0);
    expect(scheduledIntroTimers()).toEqual([]);
  });

  it('permet de passer au clavier et restitue le focus', async () => {
    await render();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => { skipButton().dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(host.childElementCount).toBe(0);
    expect(document.activeElement).toBe(previousControl);
    expect(window.localStorage.getItem(SEEN_KEY)).toBe('1');
  });

  it('maintient le focus sur le bouton pendant la courte fenêtre modale', async () => {
    await render();
    const button = skipButton();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => { button.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it('annule les transitions dès que l’utilisateur passe la séquence', async () => {
    const remember = vi.spyOn(Storage.prototype, 'setItem');
    await render();
    await act(async () => skipButton().click());
    expectIntroTimersCancelled();
    expect(listeners.size).toBe(0);
    expect(remember).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(host.childElementCount).toBe(0);
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it('conserve les étapes visuelles puis ferme proprement après 3,5 secondes', async () => {
    await render();
    await act(async () => vi.advanceTimersByTime(800));
    expect(host.querySelector('h1')?.textContent).toContain('PURAMA');
    await act(async () => vi.advanceTimersByTime(1200));
    expect(host.textContent).toContain('Tes agents IA autonomes');
    await act(async () => vi.advanceTimersByTime(1500));
    expect(host.childElementCount).toBe(0);
    expectIntroTimersCancelled();
    expect(listeners.size).toBe(0);
    expect(window.localStorage.getItem(SEEN_KEY)).toBe('1');
  });

  it('retire l’écran et tous ses minuteurs lors d’une navigation', async () => {
    await render();
    await act(async () => navigate('/modeles/a6211822-fc3c-4c77-854a-3bc79dd4405d'));
    expect(host.childElementCount).toBe(0);
    expectIntroTimersCancelled();
    expect(listeners.size).toBe(0);
    await act(async () => vi.advanceTimersByTime(5000));
    await act(async () => navigate('/'));
    expect(host.childElementCount).toBe(0);
  });

  it('retire les minuteurs et l’écoute de préférence au démontage', async () => {
    const remember = vi.spyOn(Storage.prototype, 'setItem');
    await render();
    expect(uncancelledIntroDelays()).toEqual(INTRO_DELAYS);
    await act(async () => { root?.unmount(); root = null; });
    expectIntroTimersCancelled();
    expect(listeners.size).toBe(0);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(host.childElementCount).toBe(0);
    expect(remember).not.toHaveBeenCalled();
  });

  it('reste utilisable sans API de préférence disponible', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    await render();
    expect(host.childElementCount).toBe(0);
    expect(scheduledIntroTimers()).toEqual([]);
  });

  it('supporte la répétition des effets de React StrictMode', async () => {
    await render('/', true);
    expect(skipButton()).toBeDefined();
    expect(uncancelledIntroDelays()).toEqual(INTRO_DELAYS);
    expect(listeners.size).toBe(1);
    await act(async () => skipButton().click());
    expectIntroTimersCancelled();
    expect(listeners.size).toBe(0);
  });
});
