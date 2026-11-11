import { act, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PublicCreatorModel from './PublicCreatorModel';
import CreatorAgentTemplates from './CreatorAgentTemplates';
import type { PublicCreatorModel as PublicModel } from '@/lib/public-creator-model';

const { auth, api, toast, referral } = vi.hoisted(() => ({
  auth: { user: null as { id: string } | null, loading: false },
  api: {
    getPublicCreatorModel: vi.fn(),
    listTemplates: vi.fn(),
    listPublicAgents: vi.fn(),
    cloneTemplate: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn() },
  referral: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useInfluencer', () => ({
  useReferralTracking: () => ({ checkAndStoreReferral: referral }),
}));
vi.mock('@/lib/creator-agent', () => ({
  ...api,
  CATEGORIES: [{ value: 'productivity', label: 'Productivité', emoji: '⚡', color: '#8B5CF6' }],
}));
vi.mock('sonner', () => ({ toast }));

// The real components and React/router lifecycle remain active. Only decorative
// motion is replaced, as in the existing component tests.
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
  };
});

const USER_A = { id: 'a3715760-353c-414d-a782-5d3efaf02eb9' };
const USER_B = { id: 'b648fb21-132c-48e4-aee2-f17ae77bcaca' };
const MODEL: PublicModel = {
  id: '81000000-0000-4000-8000-000000000001',
  name: 'Préparer ma semaine',
  description: 'Une présentation publique disponible.',
  emoji: '🗓️', color: '#8B5CF6', category: 'productivity',
  is_public: true, is_template: false, is_active: true,
};
const OTHER_MODEL: PublicModel = {
  ...MODEL, id: '81000000-0000-4000-8000-000000000002', name: 'Préparer mon voyage',
};
const MODEL_PATH = `/modeles/${MODEL.id}`;
const OTHER_MODEL_PATH = `/modeles/${OTHER_MODEL.id}`;
const CATALOG_PATH = '/dashboard/creator-agent/templates';
type CopyResult = { id: string; name: string; user_id: string; cloned_from: string };

let root: Root | null;
let host: HTMLDivElement;
let navigate: NavigateFunction;
let initialPath: string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function LocationProbe() {
  navigate = useNavigate();
  const location = useLocation();
  return <output data-location>{location.pathname}{location.search}{location.hash}</output>;
}

function Harness() {
  return <>
    <LocationProbe />
    <Routes>
      <Route path="/modeles/:id" element={<PublicCreatorModel />} />
      <Route path={CATALOG_PATH} element={<CreatorAgentTemplates />} />
      <Route path="*" element={<p>Autre destination</p>} />
    </Routes>
  </>;
}

async function render(path = initialPath) {
  initialPath = path;
  await act(async () => {
    root?.render(<MemoryRouter initialEntries={[initialPath]}><Harness /></MemoryRouter>);
  });
}

async function changeAccount(user: { id: string } | null) {
  auth.user = user;
  await render();
}

function location() { return host.querySelector('[data-location]')?.textContent; }

function copyButton(): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find(element =>
    /^(Créer ma copie privée|Création de votre copie…|Cloner)$/.test(element.textContent?.trim() ?? ''));
  if (!button) throw new Error('Le contrôle de copie du modèle est absent.');
  return button;
}

async function clickCopy() { await act(async () => { copyButton().click(); }); }

function request(index = 0) {
  const args = api.cloneTemplate.mock.calls[index];
  if (!args) throw new Error(`Demande de copie ${index + 1} absente.`);
  return { owner: args[0] as string, source: args[1] as string, id: args[2] as string };
}

function resultFor(call: ReturnType<typeof request>): CopyResult {
  return { id: call.id, name: MODEL.name, user_id: call.owner, cloned_from: call.source };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getPublicCreatorModel.mockReset().mockImplementation(async (id: string) =>
    id === OTHER_MODEL.id ? OTHER_MODEL : MODEL);
  api.listTemplates.mockReset().mockResolvedValue([MODEL]);
  api.listPublicAgents.mockReset().mockResolvedValue([]);
  api.cloneTemplate.mockReset().mockImplementation(async (owner: string, source: string, id: string) =>
    resultFor({ owner, source, id }));
  auth.user = USER_A;
  auth.loading = false;
  initialPath = MODEL_PATH;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  { label: 'présentation publique', path: MODEL_PATH },
  { label: 'catalogue existant', path: CATALOG_PATH },
])('cycle de copie — $label', ({ path }) => {
  it('ignore le succès ancien après A → B → A sans nouvelle action', async () => {
    const pending = deferred<CopyResult>();
    api.cloneTemplate.mockReturnValueOnce(pending.promise);
    await render(path);
    await clickCopy();
    expect(api.cloneTemplate).toHaveBeenCalledTimes(1);
    const original = request();

    await changeAccount(USER_B);
    await changeAccount(USER_A);
    await act(async () => { pending.resolve(resultFor(original)); });

    expect(location()).toBe(path);
    expect(toast.success).not.toHaveBeenCalled();
    expect(copyButton().disabled).toBe(false);
  });

  it('ignore un ancien retrait P0002 après A → B → A', async () => {
    const pending = deferred<CopyResult>();
    api.cloneTemplate.mockReturnValueOnce(pending.promise);
    await render(path);
    await clickCopy();

    await changeAccount(USER_B);
    await changeAccount(USER_A);
    await act(async () => { pending.reject({ code: 'P0002', message: 'Source retirée dans une ancienne requête' }); });

    expect(location()).toBe(path);
    expect(host.textContent).toContain(MODEL.name);
    expect(toast.error).not.toHaveBeenCalled();
    expect(copyButton().disabled).toBe(false);
  });

  it('permet au compte B de copier pendant que la réponse du compte A reste suspendue', async () => {
    const first = deferred<CopyResult>();
    const second = deferred<CopyResult>();
    api.cloneTemplate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render(path);
    await clickCopy();
    const original = request();

    await changeAccount(USER_B);
    expect(copyButton().disabled).toBe(false);
    await clickCopy();

    expect(api.cloneTemplate).toHaveBeenCalledTimes(2);
    const current = request(1);
    expect(current.owner).toBe(USER_B.id);
    expect(current.source).toBe(MODEL.id);
    expect(current.id).not.toBe(original.id);
    await act(async () => { second.resolve(resultFor(current)); });
    expect(location()).toBe(`/dashboard/creator-agent/${current.id}`);

    await act(async () => { first.resolve(resultFor(original)); });
    expect(location()).toBe(`/dashboard/creator-agent/${current.id}`);
  });

  it.each(['succès', 'échec'] as const)(
    'le finally ancien (%s) ne libère pas la copie B et ne permet pas un second envoi B',
    async outcome => {
      const first = deferred<CopyResult>();
      const second = deferred<CopyResult>();
      api.cloneTemplate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      await render(path);
      await clickCopy();
      const original = request();

      await changeAccount(USER_B);
      await clickCopy();
      expect(api.cloneTemplate).toHaveBeenCalledTimes(2);
      const current = request(1);
      expect(current.owner).toBe(USER_B.id);
      expect(copyButton().disabled).toBe(true);

      await act(async () => {
        if (outcome === 'succès') first.resolve(resultFor(original));
        else first.reject(new Error('Ancienne réponse perdue'));
      });

      expect(location()).toBe(path);
      expect(copyButton().disabled).toBe(true);
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      await act(async () => { copyButton().click(); copyButton().click(); });
      expect(api.cloneTemplate).toHaveBeenCalledTimes(2);

      await act(async () => { second.resolve(resultFor(current)); });
      expect(location()).toBe(`/dashboard/creator-agent/${current.id}`);
    },
  );

  it('conserve le même UUID pour une reprise explicite après résultat incertain dans le même contexte', async () => {
    api.cloneTemplate.mockRejectedValueOnce(new Error('Réponse perdue après traitement'));
    await render(path);
    await clickCopy();
    expect(api.cloneTemplate).toHaveBeenCalledTimes(1);
    const original = request();
    expect(location()).toBe(path);
    expect(copyButton().disabled).toBe(false);

    await clickCopy();
    expect(api.cloneTemplate).toHaveBeenCalledTimes(2);
    expect(request(1)).toEqual(original);
    expect(location()).toBe(`/dashboard/creator-agent/${original.id}`);
  });

  it('ne reprend pas la navigation et ne notifie pas après avoir quitté la page', async () => {
    const pending = deferred<CopyResult>();
    api.cloneTemplate.mockReturnValueOnce(pending.promise);
    await render(path);
    await clickCopy();
    const original = request();

    await act(async () => { navigate('/elsewhere'); });
    expect(location()).toBe('/elsewhere');
    await act(async () => { pending.resolve(resultFor(original)); });

    expect(location()).toBe('/elsewhere');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('continuité du modèle public', () => {
  it('ne quitte pas le nouveau modèle quand la copie de l’ancien se termine', async () => {
    const pending = deferred<CopyResult>();
    api.cloneTemplate.mockReturnValueOnce(pending.promise);
    await render(MODEL_PATH);
    await clickCopy();
    const original = request();

    await act(async () => { navigate(OTHER_MODEL_PATH); });
    expect(location()).toBe(OTHER_MODEL_PATH);
    expect(host.querySelector('h1')?.textContent).toBe(OTHER_MODEL.name);
    expect(copyButton().disabled).toBe(false);
    await act(async () => { pending.resolve(resultFor(original)); });

    expect(location()).toBe(OTHER_MODEL_PATH);
    expect(host.querySelector('h1')?.textContent).toBe(OTHER_MODEL.name);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('ignore la lecture tardive de l’ancien modèle après un changement de lien', async () => {
    const previousRead = deferred<PublicModel | null>();
    api.getPublicCreatorModel.mockReturnValueOnce(previousRead.promise);
    await render(MODEL_PATH);
    const previousSignal = api.getPublicCreatorModel.mock.calls[0][1] as AbortSignal;

    await act(async () => { navigate(OTHER_MODEL_PATH); });
    expect(previousSignal.aborted).toBe(true);
    expect(host.querySelector('h1')?.textContent).toBe(OTHER_MODEL.name);
    await act(async () => { previousRead.resolve(MODEL); });

    expect(location()).toBe(OTHER_MODEL_PATH);
    expect(host.querySelector('h1')?.textContent).toBe(OTHER_MODEL.name);
  });
});

describe('disponibilité indépendante du catalogue', () => {
  it('rend le catalogue officiel utilisable avant la fin de la lecture communautaire', async () => {
    const community = deferred<PublicModel[]>();
    api.listPublicAgents.mockReturnValueOnce(community.promise);
    await render(CATALOG_PATH);

    try {
      expect(host.textContent).toContain(MODEL.name);
      expect(copyButton().disabled).toBe(false);
      await clickCopy();
      expect(api.cloneTemplate).toHaveBeenCalledTimes(1);
      expect(location()).toBe(`/dashboard/creator-agent/${request().id}`);
    } finally {
      await act(async () => { community.resolve([]); });
    }
  });
});

describe('retraits du catalogue pendant une reprise', () => {
  async function reloadCatalogue() {
    const button = [...host.querySelectorAll('button')].find(element =>
      element.textContent?.trim() === 'Recharger le catalogue');
    if (!button) throw new Error('La reprise explicite du catalogue est absente.');
    await act(async () => { button.click(); });
  }

  it('ne réintroduit pas un modèle retiré avec P0002 depuis une lecture déjà en attente', async () => {
    const staleRead = deferred<PublicModel[]>();
    api.listTemplates.mockResolvedValueOnce([MODEL]).mockReturnValueOnce(staleRead.promise);
    api.listPublicAgents.mockRejectedValue(new Error('Catalogue communautaire temporairement indisponible'));
    api.cloneTemplate.mockRejectedValueOnce({ code: 'P0002', message: 'Modèle retiré' });
    await render(CATALOG_PATH);
    expect(host.textContent).toContain(MODEL.name);

    await reloadCatalogue();
    expect(api.listTemplates).toHaveBeenCalledTimes(2);
    expect(copyButton().disabled).toBe(false);
    await clickCopy();
    expect(api.cloneTemplate).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('Ce modèle n’est plus disponible.');
    expect(host.textContent).not.toContain(MODEL.name);

    // This snapshot was requested before the copy authoritatively reported
    // withdrawal. Its later arrival must not undo that newer observation.
    await act(async () => { staleRead.resolve([MODEL]); });
    expect(location()).toBe(CATALOG_PATH);
    expect(host.textContent).not.toContain(MODEL.name);
    expect([...host.querySelectorAll('button')].some(element => element.textContent?.trim() === 'Cloner')).toBe(false);
  });

  it('permet une republication après une nouvelle reprise explicite sans accepter la génération antérieure', async () => {
    const staleRead = deferred<PublicModel[]>();
    const republished = { ...MODEL, name: 'Préparer ma semaine — nouvelle publication' };
    api.listTemplates.mockResolvedValueOnce([MODEL]).mockReturnValueOnce(staleRead.promise)
      .mockResolvedValueOnce([republished]);
    api.listPublicAgents.mockRejectedValue(new Error('Catalogue communautaire temporairement indisponible'));
    api.cloneTemplate.mockRejectedValueOnce({ code: 'P0002', message: 'Modèle retiré' });
    await render(CATALOG_PATH);
    await reloadCatalogue();
    await clickCopy();
    expect(host.textContent).not.toContain(MODEL.name);

    // A distinct user-requested refresh starts after the withdrawal. It may
    // discover a genuine republication of the same source identifier.
    await reloadCatalogue();
    expect(api.listTemplates).toHaveBeenCalledTimes(3);
    expect(host.textContent).toContain(republished.name);
    expect(copyButton().disabled).toBe(false);

    await act(async () => { staleRead.resolve([MODEL]); });
    expect(host.textContent).toContain(republished.name);
    expect(location()).toBe(CATALOG_PATH);
  });
});
