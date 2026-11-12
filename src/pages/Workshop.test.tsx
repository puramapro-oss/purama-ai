import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    tasks: [{ id: TASK, key: 'build', title: 'Réaliser le site', state: done ? 'verified_done' : state === 'cancelled' ? 'cancelled' : 'ready', provider: null, attempt: 0, outputSha: done ? 'a'.repeat(40) : null, evidenceCount: done ? 2 : 0 }],
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

beforeEach(() => {
  transport.invoke.mockReset();
  auth.user = { id: 'alice' };
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  transport.invoke.mockImplementation((_name, { body }) => Promise.resolve(body.action === 'list' ? list() : ok(detail())));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

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
    expect(host.querySelector<HTMLAnchorElement>('a[href="https://preview.example/site"]')?.rel).toBe('noopener noreferrer');
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
});
