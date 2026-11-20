import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import Workshop from './Workshop';
import { saveWorkshopDraft } from '@/lib/workshop';

const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
const auth = vi.hoisted(() => ({ user: { id: 'alice' } as { id: string } | null }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: transport } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));

const ID = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-000000000002';
const project = { id: 'website', name: 'Mon site', ready: true, maxParallel: 2 };
function detail(state = 'active') {
  const done = state === 'verified_done';
  return {
    id: ID, projectId: 'website', title: 'Site restaurant', state,
    createdAt: '2026-11-12T12:00:00Z', updatedAt: '2026-11-12T12:00:00Z', finishedAt: done ? '2026-11-12T12:00:00Z' : null,
    verifiedTasks: done ? 1 : 0, totalTasks: 1, usage: { tokens: 10, costMicros: 0 },
    tasks: [{ id: TASK, key: 'implementation', title: 'Réaliser le site', state: done ? 'verified_done' : state === 'cancelled' ? 'cancelled' : 'ready', provider: null, attempt: 0, outputSha: done ? 'a'.repeat(40) : null, evidenceCount: done ? 2 : 0 }],
    previewUrl: done ? 'https://preview.example/site' : undefined,
  };
}
const ok = (mission: ReturnType<typeof detail>) => ({ data: { ok: true, mission }, error: null });
const list = (missions: ReturnType<typeof detail>[] = [], projects = [project]) => ({ data: { ok: true, projects, missions }, error: null });
let root: Root;
let host: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const render = async () => { await act(async () => root.render(<MemoryRouter initialEntries={['/dashboard/atelier']}><Workshop /></MemoryRouter>)); };
const button = (text: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.includes(text))!;
const submit = () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
function fill(text = 'Un site pour mon restaurant avec réservations et menu') {
  const input = host.querySelector<HTMLTextAreaElement>('#workshop-goal')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const startCalls = () => transport.invoke.mock.calls.filter(([, options]) => options.body.action === 'start');
const createObjectURL = vi.fn(() => 'blob:verified-archive');
const revokeObjectURL = vi.fn();
function artifactEnvelope(withPreview = true) {
  const content = '<h1 id="private-output">Projet privé Alice</h1>';
  const data = new Uint8Array([80, 75, 5, 6, ...Array(18).fill(0)]);
  return { data: { ok: true, artifact: {
    missionId: ID, commitSha: 'a'.repeat(40),
    archive: { fileName: 'restaurant.zip', mediaType: 'application/zip', bytes: data.length, base64: Buffer.from(data).toString('base64'), sha256: createHash('sha256').update(data).digest('hex') },
    ...(withPreview ? { preview: { fileName: 'index.html', mediaType: 'text/html', content, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') } } : {}),
  } }, error: null };
}
async function loadArtifact() {
  await act(async () => button('Accéder aux fichiers').click());
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(createObjectURL).toHaveBeenCalled();
  }, { timeout: 2000 });
}

beforeEach(() => {
  transport.invoke.mockReset();
  createObjectURL.mockClear(); revokeObjectURL.mockClear();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
  auth.user = { id: 'alice' };
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  transport.invoke.mockImplementation((_name, { body }) => Promise.resolve(body.action === 'list' ? list() : ok(detail())));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('workshop lifecycle', () => {
  it('opens existing missions after reload and shows readiness without inventing activity', async () => {
    transport.invoke.mockImplementation((_name, { body }) => Promise.resolve(body.action === 'list' ? list([detail()]) : ok(detail())));
    await render();
    expect(host.textContent).toContain('Site restaurant');
    expect(host.textContent).toContain('En attente ou en cours');
    expect(host.textContent).not.toContain('Agents au travail');
    expect(host.querySelector('[data-testid="workshop-result"]')).toBeNull();
    expect(startCalls()).toHaveLength(0);
  });
  it('does not launch when the runtime is unavailable', async () => {
    transport.invoke.mockResolvedValue(list([], [{ ...project, ready: false }]));
    await render(); fill();
    expect(button('Lancer la création').disabled).toBe(true);
    await act(async () => submit());
    expect(startCalls()).toHaveLength(0);
  });
  it('prevents duplicate starts and retains the idempotency key on transport failure', async () => {
    const first = deferred<{ data: null; error: Error }>();
    let attempts = 0;
    transport.invoke.mockImplementation((_name, { body }) => {
      if (body.action === 'list') return Promise.resolve(list());
      if (body.action === 'start' && ++attempts === 1) return first.promise;
      return Promise.resolve(ok(detail()));
    });
    await render(); fill();
    await act(async () => { submit(); submit(); });
    expect(startCalls()).toHaveLength(1);
    await act(async () => first.resolve({ data: null, error: new Error('network') }));
    expect(host.textContent).toContain('peut avoir été reçue');
    expect(host.querySelector('[data-testid="workshop-result"]')).toBeNull();
    await act(async () => submit());
    expect(startCalls()).toHaveLength(2);
    expect(startCalls()[0][1].body.requestId).toBe(startCalls()[1][1].body.requestId);
    expect(host.textContent).toContain('Site restaurant');
  });
  it('only reveals the result after the server reports verified completion', async () => {
    vi.useFakeTimers();
    let statuses = 0;
    transport.invoke.mockImplementation((_name, { body }) => Promise.resolve(
      body.action === 'list' ? list([detail()]) : ok(detail(++statuses > 1 ? 'verified_done' : 'active')),
    ));
    await render();
    expect(host.querySelector('[data-testid="workshop-result"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(host.querySelector('[data-testid="workshop-result"]')?.textContent).toContain('Création vérifiée');
    expect(button('Accéder aux fichiers')).toBeDefined();
    expect(host.querySelector<HTMLAnchorElement>('a[href="https://preview.example/site"]')).toBeNull();
    const count = transport.invoke.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(transport.invoke).toHaveBeenCalledTimes(count);
  });
  it('distinguishes a stop request from confirmed cancellation and ignores an older poll', async () => {
    vi.useFakeTimers();
    const stale = deferred<ReturnType<typeof ok>>();
    let statuses = 0;
    let stopping = false;
    transport.invoke.mockImplementation((_name, { body }) => {
      if (body.action === 'list') return Promise.resolve(list([detail()]));
      if (body.action === 'cancel') { stopping = true; return Promise.resolve(ok(detail('cancelling'))); }
      statuses++;
      if (statuses === 2) return stale.promise;
      return Promise.resolve(ok(detail(stopping ? 'cancelling' : 'active')));
    });
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    await act(async () => button('Arrêter cette mission').click());
    expect(host.textContent).toContain('Arrêt demandé');
    expect(host.textContent).not.toContain('Arrêt confirmé');
    await act(async () => stale.resolve(ok(detail('verified_done'))));
    expect(host.querySelector('[data-testid="workshop-result"]')).toBeNull();
    expect(host.textContent).toContain('Arrêt demandé');
    transport.invoke.mockResolvedValue(ok(detail('cancelled')));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(host.textContent).toContain('Arrêt confirmé');
  });
  it('aborts requests and clears private state when the principal changes', async () => {
    const old = deferred<ReturnType<typeof list>>();
    transport.invoke.mockReturnValueOnce(old.promise);
    await render();
    const oldSignal = transport.invoke.mock.calls[0][1].signal as AbortSignal;
    auth.user = { id: 'bob' };
    transport.invoke.mockResolvedValue(list());
    await render();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => old.resolve(list([{ ...detail(), title: 'Projet privé Alice' }])));
    expect(host.textContent).not.toContain('Projet privé Alice');
    expect(host.textContent).toContain('Tout commence par votre idée');
  });
  it('restores the brief through authentication without putting it in the URL', async () => {
    saveWorkshopDraft('Créer un site privé de restaurant', null);
    await render();
    expect(host.querySelector<HTMLTextAreaElement>('#workshop-goal')?.value).toBe('Créer un site privé de restaurant');
    expect(sessionStorage.getItem('purama.workshop.draft.v1')).toBeNull();
    expect(startCalls()).toHaveLength(0);
  });
  it('offers an explicit retry on a failed status request without claiming success', async () => {
    transport.invoke.mockImplementation((_name, { body }) => Promise.resolve(body.action === 'list'
      ? list([detail()]) : { data: null, error: new Error('provider log secret') }));
    await render();
    expect(host.textContent).toContain('Réessayer le suivi');
    expect(host.textContent).not.toContain('provider log secret');
    expect(host.querySelector('[data-testid="workshop-result"]')).toBeNull();
    transport.invoke.mockResolvedValue(ok(detail('verified_done')));
    await act(async () => button('Réessayer le suivi').click());
    expect(host.querySelector('[data-testid="workshop-result"]')).not.toBeNull();
  });
  it('offers the verified source archive and renders HTML only in an opaque iframe', async () => {
    transport.invoke.mockImplementation((_name, { body }) => Promise.resolve(body.action === 'list' ? list([detail('verified_done')])
      : body.action === 'artifact' ? artifactEnvelope() : ok(detail('verified_done'))));
    await render();
    expect(transport.invoke.mock.calls.some(([, options]) => options.body.action === 'artifact')).toBe(false);
    await loadArtifact();
    expect(host.querySelector<HTMLAnchorElement>('a[download]')?.download).toBe('restaurant.zip');
    expect(host.querySelector<HTMLAnchorElement>('a[download]')?.href).toBe('blob:verified-archive');
    await act(async () => button('Afficher l’aperçu').click());
    const preview = host.querySelector('iframe')!;
    expect(preview.getAttribute('sandbox')).toBe('allow-scripts');
    expect(preview.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(preview.srcdoc).toContain("connect-src 'none'");
    expect(preview.srcdoc).toContain('Projet privé Alice');
    expect(host.querySelector('#private-output')).toBeNull();
    expect(host.textContent).not.toContain('Projet privé Alice');
    auth.user = { id: 'bob' };
    transport.invoke.mockResolvedValue(list());
    await render();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:verified-archive');
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('a[download]')).toBeNull();
  });
  it('keeps source-only projects downloadable without inventing an interactive preview', async () => {
    transport.invoke.mockImplementation((_name, { body }) => Promise.resolve(body.action === 'list' ? list([detail('verified_done')])
      : body.action === 'artifact' ? artifactEnvelope(false) : ok(detail('verified_done'))));
    await render(); await loadArtifact();
    expect(host.textContent).toContain('Aucun aperçu HTML autonome');
    expect(button('Afficher l’aperçu')).toBeUndefined();
    expect(host.querySelector('a[download]')).not.toBeNull();
  });
  it('aborts an in-flight artifact and ignores its late response on account switch', async () => {
    const pending = deferred<ReturnType<typeof artifactEnvelope>>();
    transport.invoke.mockImplementation((_name, { body }) => body.action === 'artifact' ? pending.promise
      : Promise.resolve(body.action === 'list' ? list([detail('verified_done')]) : ok(detail('verified_done'))));
    await render();
    await act(async () => button('Accéder aux fichiers').click());
    const signal = transport.invoke.mock.calls.find(([, options]) => options.body.action === 'artifact')![1].signal as AbortSignal;
    auth.user = { id: 'bob' }; transport.invoke.mockResolvedValue(list());
    await render();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(artifactEnvelope()));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(host.querySelector('a[download]')).toBeNull();
  });
  it('keeps corrupted files unavailable and offers an explicit retry', async () => {
    const corrupted = artifactEnvelope(); corrupted.data.artifact.archive.sha256 = '0'.repeat(64);
    transport.invoke.mockImplementation((_name, { body }) => Promise.resolve(body.action === 'list' ? list([detail('verified_done')])
      : body.action === 'artifact' ? corrupted : ok(detail('verified_done'))));
    await render();
    await act(async () => button('Accéder aux fichiers').click());
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('empreinte');
    }, { timeout: 2000 });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(host.querySelector('iframe')).toBeNull();
    expect(button('Réessayer les fichiers')).toBeDefined();
  });
});
