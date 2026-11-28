import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIaoRoutines } from './useIaoRoutines';
import type { Routine, RoutineInput } from '@/lib/iao-routines-client';

const h = vi.hoisted(() => ({ owner: null as string | null, invoke: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: h.owner ? { id: h.owner } : null,
  session: h.owner ? { user: { id: h.owner }, access_token: `session-${h.owner}` } : null }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: h.invoke } } }));

const A = '84000000-0000-4000-8000-000000000001';
const B = '84000000-0000-4000-8000-000000000002';
const ID = '94000000-0000-4000-8000-000000000001';
const OCCURRENCE = '94000000-0000-4000-8000-000000000003';
const at = '2026-11-28T09:00:00.000Z';
const config = (): RoutineInput => ({ name: 'Matin', instruction: 'Présente les résultats et les blocages.', enabled: true,
  schedule: { kind: 'daily', time: '08:30', timezone: 'Europe/Paris' }, channels: ['in_app'], deliveryMode: 'parallel',
  agentTypes: [], length: 'standard', quietHours: null, pausedUntil: null, onlyIfNew: true, maxCallMinutes: 2, monthlyCallMinutes: 30 });
const routine = (ownerId = A, extra = {}): Routine => ({ id: ID, userId: ownerId, revision: 1, config: config(),
  createdAt: at, updatedAt: at, lastOccurrenceAt: null, ...extra });
const listing = (ownerId = A, name = 'Matin') => ({ ok: true, routines: [routine(ownerId, { config: { ...config(), name } })], history: [],
  capabilities: { routines: true, calls: false, verifiedPhone: null, phoneBlockedReason: null,
    voiceCommands: 'confirmation_required', email: true, push: true, agents: [] } });
type Reply = { data: unknown; error: unknown };
let api: ReturnType<typeof useIaoRoutines>;
let root: Root;
let host: HTMLDivElement;
let writer: (body: Record<string, unknown>, ownerId: string) => Reply | Promise<Reply>;
let reader: (ownerId: string) => Reply | Promise<Reply>;

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function Probe() { api = useIaoRoutines(); return <div>{api.ownerId ? api.data?.routines.map(row => row.config.name).join(', ') : 'Déconnecté'}</div>; }
async function render(owner: string | null = A) {
  h.owner = owner;
  await act(async () => root.render(<StrictMode><Probe /></StrictMode>));
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.invoke.mockReset();
  reader = owner => ({ data: listing(owner), error: null });
  writer = (body, owner) => ({ data: body.action === 'preview' ? { ok: true, occurrences: [at] }
    : body.action === 'pause' ? { ok: true, routine: routine(owner, { revision: 2, config: { ...config(), enabled: false } }) }
      : body.action === 'save' ? { ok: true, routine: routine(owner, { id: body.id, revision: Number(body.expectedRevision) + 1, config: body.config }) }
        : body.action === 'run-now' ? { ok: true, occurrence: { id: OCCURRENCE, routineId: ID, scheduledAt: at, status: 'pending' } }
          : { ok: true, updatedCount: 1 }, error: null });
  h.invoke.mockImplementation((_name, options) => {
    const owner = options.headers.Authorization.slice('Bearer session-'.length);
    return options.body.action === 'list' ? reader(owner) : writer(options.body, owner);
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render();
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('routines account lifetimes and confirmation', () => {
  it('hides private routines on logout and does not make anonymous requests', async () => {
    expect(host.textContent).toContain('Matin');
    h.invoke.mockClear(); await render(null);
    expect(host.textContent).toBe('Déconnecté'); expect(api.data).toBeNull(); expect(h.invoke).not.toHaveBeenCalled();
  });

  it('does not start retained actions across A to B to A', async () => {
    const retained = api.pause;
    await render(B); await render(A); h.invoke.mockClear();
    await expect(retained(routine())).rejects.toThrow('session a changé');
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('does not start a retained refresh in a later account lifetime', async () => {
    const retained = api.refresh;
    await render(B); await render(A); h.invoke.mockClear();
    await retained(); expect(h.invoke).not.toHaveBeenCalled();
  });

  it('ignores a late mutation and does not refresh or announce success for another account', async () => {
    const pending = deferred<Reply>(); writer = () => pending.promise;
    let result!: Promise<unknown>;
    await act(async () => { result = api.pause(routine()).catch(error => error); });
    const request = h.invoke.mock.calls.find(([, options]) => options.body.action === 'pause')![1];
    await render(B);
    const calls = h.invoke.mock.calls.length;
    await act(async () => pending.resolve({ data: { ok: true, routine: routine(A, { revision: 2, config: { ...config(), enabled: false } }) }, error: null }));
    expect(await result).toBeInstanceOf(Error);
    expect(request.headers.Authorization).toBe(`Bearer session-${A}`);
    expect(request.signal.aborted).toBe(true);
    expect(h.invoke).toHaveBeenCalledTimes(calls);
    expect(api.ownerId).toBe(B); expect(api.notice).toBeNull(); expect(api.operationError).toBeNull(); expect(api.busy).toBeNull();
  });

  it('allows a new account to act while a retired account request is unresolved', async () => {
    const pending = deferred<Reply>(); writer = (_body, owner) => owner === A ? pending.promise
      : { data: { ok: true, routine: routine(B, { revision: 2, config: { ...config(), enabled: false } }) }, error: null };
    let previous!: Promise<unknown>;
    await act(async () => { previous = api.pause(routine()).catch(error => error); });
    await render(B);
    await act(async () => { await api.pause(routine(B)); });
    expect(api.notice).toContain('mise en pause');
    await act(async () => pending.resolve({ data: null, error: { context: { status: 500 } } }));
    await previous; expect(api.notice).toContain('mise en pause'); expect(api.operationError).toBeNull();
  });

  it('ignores an older read that finishes after a newer refresh', async () => {
    const pending = deferred<Reply>(); let count = 0;
    reader = () => ++count === 1 ? pending.promise : { data: listing(A, 'Bilan récent'), error: null };
    let first!: Promise<void>;
    await act(async () => { first = api.refresh(); });
    await act(async () => { await api.refresh(); });
    await act(async () => pending.resolve({ data: listing(A, 'Ancien bilan'), error: null }));
    await first; expect(host.textContent).toBe('Bilan récent');
  });

  it('requires a preview of the exact active settings before saving', async () => {
    const input = config(); h.invoke.mockClear();
    await act(async () => { await expect(api.save(ID, 1, input)).rejects.toThrow('occurrences'); });
    expect(h.invoke).not.toHaveBeenCalled();
    await act(async () => { await api.preview(input); });
    await act(async () => { await expect(api.save(ID, 1, { ...input, channels: ['call'] })).rejects.toThrow('occurrences'); });
    expect(h.invoke.mock.calls.filter(([, options]) => options.body.action === 'save')).toHaveLength(0);
    await act(async () => { await api.save(ID, 1, input); });
    expect(api.notice).toContain('enregistrée et activée');
  });

  it('permits an inactive draft without a scheduling preview', async () => {
    await act(async () => { await api.save(ID, 0, { ...config(), enabled: false }); });
    expect(api.notice).toBe('Routine enregistrée en pause.');
  });

  it('refuses two concurrent writes before a second request can start', async () => {
    const pending = deferred<Reply>(); writer = () => pending.promise;
    let first!: Promise<unknown>;
    await act(async () => { first = api.pause(routine()); });
    await expect(api.pauseAll()).rejects.toThrow('déjà en cours');
    expect(h.invoke.mock.calls.filter(([, options]) => options.body.action === 'pause-all')).toHaveLength(0);
    await act(async () => pending.resolve({ data: { ok: true, routine: routine(A, { revision: 2, config: { ...config(), enabled: false } }) }, error: null }));
    await first;
  });

  it('keeps the same identity after an unconfirmed run and never retries automatically', async () => {
    writer = () => ({ data: null, error: { context: { status: 502 } } });
    await act(async () => { await expect(api.runNow(routine())).rejects.toThrow('Résultat non confirmé'); });
    const first = h.invoke.mock.calls.filter(([, options]) => options.body.action === 'run-now');
    expect(first).toHaveLength(1); expect(api.uncertainRuns).toEqual([ID]);
    writer = () => ({ data: { ok: true, occurrence: { id: OCCURRENCE, routineId: ID, scheduledAt: at, status: 'pending' } }, error: null });
    await act(async () => { await api.runNow(routine()); });
    const attempts = h.invoke.mock.calls.filter(([, options]) => options.body.action === 'run-now');
    expect(attempts).toHaveLength(2);
    expect(attempts[0][1].body.requestId).toBe(attempts[1][1].body.requestId);
    expect(api.uncertainRuns).toEqual([]);
  });

  it('does not accept a previous lifetime preview when account A returns', async () => {
    await act(async () => { await api.preview(config()); });
    await render(B); await render(A); h.invoke.mockClear();
    await act(async () => { await expect(api.save(ID, 1, config())).rejects.toThrow('occurrences'); });
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
