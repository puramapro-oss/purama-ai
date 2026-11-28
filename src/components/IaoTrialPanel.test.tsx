import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import IaoTrialPanel from './IaoTrialPanel';
import { sharedTrial } from '@/lib/iao-trial-entry';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent?.startsWith(text));
  expect(button).toBeTruthy();
  await act(() => button!.click());
}

it('opens a shared trial on its own page, shares only its method, and responds to history navigation', async () => {
  window.history.replaceState(null, '', '/pura-live/essais/?private=private-value#essai/atelier');
  await act(() => root.render(<IaoTrialPanel standalone entry={{ kind: sharedTrial(window.location.hash) }} />));
  expect(host.querySelector('h1')?.textContent).toBe('Préparer un atelier');
  await click('Copier le lien de la méthode');
  const manual = host.querySelector<HTMLInputElement>('input[readonly]')!;
  expect(manual.value).toBe(window.location.origin + '/pura-live/essais/#essai/atelier');

  await click('Tous les essais');
  expect(window.location.hash).toBe('');
  expect(window.location.search).toBe('');
  await click('Comparer des médias');
  expect(window.location.hash).toBe('#essai/media');
  await act(() => {
    window.history.replaceState(null, '', '/pura-live/essais/#essai/panier');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(host.querySelector('h1')?.textContent).toBe('Composer un panier');
});
