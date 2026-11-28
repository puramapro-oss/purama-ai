import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareButtons } from './ShareButtons';

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }));
// A signed-in account must never become an implicitly invented referral code.
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'd62d6630-95a4-4583-9244-c814e8156779' } }),
}));

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, 'share');
let host: HTMLDivElement;
let root: Root | null;
let writeText: ReturnType<typeof vi.fn>;
let share: ReturnType<typeof vi.fn>;

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function render(props: ComponentProps<typeof ShareButtons> = {}) {
  await act(async () => root?.render(createElement(ShareButtons, props)));
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((element) =>
    element.getAttribute('aria-label') === label || element.textContent?.trim() === label,
  );
  if (!found) throw new Error('Button not found: ' + label);
  return found;
}

function linkedinUrl() {
  const link = [...host.querySelectorAll('a')].find((element) =>
    element.textContent?.includes('LinkedIn'),
  );
  if (!link) throw new Error('LinkedIn link not found');
  return new URL(link.href).searchParams.get('url');
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  toastSuccess.mockReset();
  writeText = vi.fn().mockResolvedValue(undefined);
  share = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  window.history.replaceState(null, '', '/');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
  if (shareDescriptor) Object.defineProperty(navigator, 'share', shareDescriptor);
  else Reflect.deleteProperty(navigator, 'share');
  window.history.replaceState(null, '', '/');
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ShareButtons', () => {
  it('partage l’accueil public sans identifiant ni données de la page courante', async () => {
    window.history.replaceState(null, '', '/dashboard?access_token=private&ref=untrusted#private');
    await render();
    expect(linkedinUrl()).toBe(window.location.origin + '/');
    expect(host.innerHTML).not.toContain('d62d6630');
    expect(host.innerHTML).not.toContain('access_token');
    expect(host.innerHTML).not.toContain('untrusted');
  });

  it('partage la destination explicite et le seul code de recommandation fourni', async () => {
    await render({ path: '/forge', referralCode: 'partenaire_42' });
    const expected = window.location.origin + '/forge?ref=partenaire_42';
    expect(linkedinUrl()).toBe(expected);
    await click(button('Partager'));
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: expected }));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('attend la confirmation du presse-papiers avant de signaler une copie', async () => {
    const pending = deferred();
    writeText.mockReturnValue(pending.promise);
    await render();
    await click(button('Copier le lien'));
    try {
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(host.textContent).not.toContain('Copié !');
      expect(button('Copier le lien').disabled).toBe(true);
    } finally {
      await act(async () => pending.resolve());
    }
    expect(toastSuccess).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Copié !');
    expect(writeText).toHaveBeenCalledWith(window.location.origin + '/');
  });

  it('propose un lien sélectionnable si la copie est refusée, sans faux succès', async () => {
    writeText.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    await render({ path: '/ecosystem' });
    await click(button('Copier le lien'));
    const input = host.querySelector('input');
    expect(input?.value).toBe(window.location.origin + '/ecosystem');
    expect(input?.readOnly).toBe(true);
    expect(input?.selectionStart).toBe(0);
    expect(input?.selectionEnd).toBe(input?.value.length);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Copié !');
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/copie.*indisponible/i);
    expect(button('Copier le lien').disabled).toBe(false);
  });

  it('propose la même solution lorsque le presse-papiers est absent', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await render({ compact: true });
    await click(button('Copier le lien'));
    expect(host.querySelector('input')?.value).toBe(window.location.origin + '/');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('traite une annulation du partage comme une action neutre', async () => {
    share.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    await render();
    await click(button('Partager'));
    expect(writeText).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(host.querySelector('input')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('');
    expect(button('Partager').disabled).toBe(false);
  });

  it('propose le lien après un vrai échec du partage sans écrire le presse-papiers', async () => {
    share.mockRejectedValue(new DOMException('Not permitted', 'NotAllowedError'));
    await render({ path: '/forge' });
    await click(button('Partager'));
    expect(host.querySelector('input')?.value).toBe(window.location.origin + '/forge');
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/partage.*indisponible/i);
    expect(writeText).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('copie le lien quand le navigateur ne fournit pas le partage natif', async () => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    await render({ path: '/parrainage' });
    await click(button('Partager'));
    expect(writeText).toHaveBeenCalledWith(window.location.origin + '/parrainage');
    expect(toastSuccess).toHaveBeenCalledOnce();
  });

  it('bloque immédiatement deux clics de copie même avant un nouveau rendu', async () => {
    const pending = deferred();
    writeText.mockReturnValue(pending.promise);
    await render();
    const copy = button('Copier le lien');
    await act(async () => { copy.click(); copy.click(); });
    expect(writeText).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
  });

  it('bloque les actions concurrentes pendant un partage natif', async () => {
    const pending = deferred();
    share.mockReturnValue(pending.promise);
    await render();
    const native = button('Partager');
    const copy = button('Copier le lien');
    await act(async () => { native.click(); native.click(); copy.click(); });
    expect(share).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    expect(button('Partager').disabled).toBe(false);
  });

  it('ne confirme pas une copie terminée après démontage', async () => {
    const pending = deferred();
    writeText.mockReturnValue(pending.promise);
    await render();
    await click(button('Copier le lien'));
    await act(async () => { root?.unmount(); root = null; });
    await act(async () => pending.resolve());
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('ne transporte pas l’état ou la confirmation d’une ancienne destination', async () => {
    const pending = deferred();
    writeText.mockReturnValueOnce(pending.promise);
    await render({ path: '/forge' });
    await click(button('Copier le lien'));
    await render({ path: '/ecosystem' });
    expect(button('Copier le lien').disabled).toBe(false);
    await act(async () => pending.resolve());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Copié !');
    await click(button('Copier le lien'));
    expect(writeText).toHaveBeenLastCalledWith(window.location.origin + '/ecosystem');
  });

  it('nettoie le minuteur de confirmation au démontage', async () => {
    vi.useFakeTimers();
    await render();
    await click(button('Copier le lien'));
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { root?.unmount(); root = null; });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('réinitialise le message de copie après son délai', async () => {
    vi.useFakeTimers();
    await render();
    await click(button('Copier le lien'));
    await act(async () => vi.advanceTimersByTime(2000));
    expect(host.textContent).not.toContain('Copié !');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('');
  });

  it.each([
    '/dashboard',
    '/forge?access_token=secret',
    '/forge#secret',
    'https://evil.example/forge',
    '//evil.example/forge',
    '',
  ])('désactive un chemin interdit au lieu de partager autre chose : %s', async (path) => {
    await render({ path });
    expect(host.textContent).toMatch(/partage indisponible/i);
    expect(host.querySelectorAll('a')).toHaveLength(0);
    for (const control of host.querySelectorAll('button')) expect(control.disabled).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  it('refuse un code de recommandation mal formé sans le remplacer', async () => {
    await render({ path: '/forge', referralCode: 'valid&token=secret' });
    expect(host.textContent).toMatch(/partage indisponible/i);
    expect(host.querySelectorAll('a')).toHaveLength(0);
    expect(host.innerHTML).not.toContain('token=secret');
  });

  it('conserve six liens nommés sans bouton imbriqué dans une ancre', async () => {
    await render();
    expect(host.querySelectorAll('a')).toHaveLength(6);
    expect(host.querySelector('a button')).toBeNull();
    for (const link of host.querySelectorAll('a')) {
      expect(link.textContent?.trim()).not.toBe('');
      expect(link.rel).toContain('noopener');
      expect(link.rel).toContain('noreferrer');
    }
  });

  it('gère les emojis et un fragment Unicode incomplet sans faire tomber la page', async () => {
    await render({ title: 'Création 🕊️\ud800', text: 'Exemple 🕊️\ud800' });
    const link = [...host.querySelectorAll('a')].find((element) => element.textContent?.includes('WhatsApp'));
    expect(link).toBeDefined();
    const sharedText = new URL(link!.href).searchParams.get('text');
    expect(sharedText).toBe('Exemple 🕊️\ufffd\n' + window.location.origin + '/');
  });

  it('encode les espaces et les signes plus distinctement pour les clients de courriel', async () => {
    await render({ title: 'Créer ensemble + partager' });
    const link = [...host.querySelectorAll('a')].find((element) => element.textContent?.includes('Email'));
    expect(link?.href).toContain('subject=Cr%C3%A9er%20ensemble%20%2B%20partager');
    expect(link?.href).not.toContain('+');
  });

  it('donne un nom accessible et un type explicite aux boutons compacts', async () => {
    await render({ compact: true });
    expect(button('Partager le lien').type).toBe('button');
    expect(button('Copier le lien').type).toBe('button');
    expect(host.querySelectorAll('button')).toHaveLength(2);
  });
});
