import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: client }));

import { cloneTemplate, getPublicCreatorModel, listPublicAgents, listTemplates } from './creator-agent';

const MODEL_ID = '81000000-0000-4000-8000-000000000001';
const OWNER_ID = '82000000-0000-4000-8000-000000000001';
const COPY_ID = '83000000-0000-4000-8000-000000000001';
const REQUEST_BUDGET_MS = 20_000;
const model = {
  id: MODEL_ID, name: 'Préparer ma semaine', description: null, emoji: '🗓️',
  color: '#8B5CF6', category: 'productivity', is_public: true, is_template: false, is_active: true,
};
const copy = { id: COPY_ID, user_id: OWNER_ID, cloned_from: MODEL_ID };
type RpcResult = { data: unknown; error: unknown };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

// Match PostgREST's lazy, chainable PromiseLike at the transport boundary.
// This deliberately ignores abort: the caller must settle even when a transport does not.
function transport() {
  const response = deferred<RpcResult>();
  let signal: AbortSignal | undefined;
  const query = {
    then: response.promise.then.bind(response.promise),
    abortSignal: vi.fn((value: AbortSignal) => { signal = value; return query; }),
    single: vi.fn(() => query),
  };
  return { query, response, signal: () => signal };
}

function observe(promise: Promise<unknown>) {
  const outcome: { state: 'pending' | 'fulfilled' | 'rejected'; value?: unknown; reason?: unknown } = { state: 'pending' };
  void promise.then(
    value => { outcome.state = 'fulfilled'; outcome.value = value; },
    reason => { outcome.state = 'rejected'; outcome.reason = reason; },
  );
  return outcome;
}

async function flushMicrotasks() {
  // Await only microtasks. A missing production deadline must fail an assertion,
  // not keep this test waiting until Vitest's real-time timeout.
  for (let step = 0; step < 12; step++) await Promise.resolve();
}

const operations = [
  { label: 'présentation publique', run: (signal?: AbortSignal) => getPublicCreatorModel(MODEL_ID, signal), data: [model], expected: model },
  { label: 'catalogue officiel', run: (signal?: AbortSignal) => listTemplates(signal), data: [model], expected: [model] },
  { label: 'catalogue communautaire', run: (signal?: AbortSignal) => listPublicAgents(signal), data: [model], expected: [model] },
  { label: 'copie privée', run: (signal?: AbortSignal) => cloneTemplate(OWNER_ID, MODEL_ID, COPY_ID, signal), data: copy, expected: copy },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.setSystemTime(new Date('2026-11-10T21:30:00.000Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(operations)('requête de modèle bornée : $label', ({ run, data, expected }) => {
  it('rend la main après 20 secondes même si le transport ignore son annulation', async () => {
    const pending = transport();
    client.rpc.mockReturnValue(pending.query);
    const outcome = observe(run());
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(REQUEST_BUDGET_MS - 1);
    expect(outcome.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(outcome.state).toBe('rejected');
    expect(outcome.reason).toBeDefined();
    expect(pending.signal()?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ne contacte jamais le serveur avec un contexte déjà annulé', async () => {
    const pending = transport();
    client.rpc.mockReturnValue(pending.query);
    const controller = new AbortController();
    controller.abort(new Error('Contexte quitté avant le départ'));
    const outcome = observe(run(controller.signal));
    await flushMicrotasks();
    expect(outcome.state).toBe('rejected');
    expect(client.rpc).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('interrompt immédiatement l’attente quand le contexte est annulé', async () => {
    const pending = transport();
    client.rpc.mockReturnValue(pending.query);
    const controller = new AbortController();
    const outcome = observe(run(controller.signal));
    await flushMicrotasks();
    expect(outcome.state).toBe('pending');
    controller.abort(new Error('Changement de compte ou de page'));
    await flushMicrotasks();
    expect(outcome.state).toBe('rejected');
    expect(pending.signal()?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuse une réponse expirée avant même que le timer retardé puisse s’exécuter', async () => {
    const pending = transport();
    client.rpc.mockReturnValue(pending.query);
    const outcome = observe(run());
    await flushMicrotasks();
    const elapsed = performance.now();
    // Simulate a suspended event loop without invoking the queued timer callback.
    vi.setSystemTime(Date.now() + REQUEST_BUDGET_MS + 1);
    vi.spyOn(performance, 'now').mockReturnValue(elapsed + REQUEST_BUDGET_MS + 1);
    pending.response.resolve({ data, error: null });
    await flushMicrotasks();
    expect(outcome.state).toBe('rejected');
    expect(outcome.reason).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepte une réponse dans le budget et retire ses timers et écouteurs externes', async () => {
    const pending = transport();
    client.rpc.mockReturnValue(pending.query);
    const controller = new AbortController();
    const subscribe = vi.spyOn(controller.signal, 'addEventListener');
    const unsubscribe = vi.spyOn(controller.signal, 'removeEventListener');
    const outcome = observe(run(controller.signal));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(REQUEST_BUDGET_MS - 1);
    pending.response.resolve({ data, error: null });
    await flushMicrotasks();
    expect(outcome.state).toBe('fulfilled');
    expect(outcome.value).toEqual(expected);
    expect(vi.getTimerCount()).toBe(0);
    for (const [event, listener] of subscribe.mock.calls.filter(([event]) => event === 'abort')) {
      expect(unsubscribe.mock.calls.some(([removedEvent, removedListener]) => removedEvent === event && removedListener === listener)).toBe(true);
    }
    controller.abort(new Error('Annulation ultérieure'));
    await flushMicrotasks();
    expect(outcome.state).toBe('fulfilled');
  });

  it('préserve une erreur serveur et retire le délai restant', async () => {
    const pending = transport();
    client.rpc.mockReturnValue(pending.query);
    const failure = { code: 'P0002', message: 'Source retirée' };
    const outcome = observe(run());
    pending.response.resolve({ data: null, error: failure });
    await flushMicrotasks();
    expect(outcome.state).toBe('rejected');
    expect(outcome.reason).toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('préserve un échec réseau et retire le délai restant', async () => {
    const pending = transport();
    client.rpc.mockReturnValue(pending.query);
    const failure = new Error('Transport interrompu');
    const outcome = observe(run());
    pending.response.reject(failure);
    await flushMicrotasks();
    expect(outcome.state).toBe('rejected');
    expect(outcome.reason).toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retire aussi le délai si la création de la requête échoue immédiatement', async () => {
    const failure = new Error('Le client refuse de démarrer la requête');
    client.rpc.mockImplementation(() => { throw failure; });
    const outcome = observe(run());
    await flushMicrotasks();
    expect(outcome.state).toBe('rejected');
    expect(outcome.reason).toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('réutilise l’UUID de copie après un résultat incertain et ignore le résultat tardif de la première tentative', async () => {
  const first = transport();
  const retry = transport();
  client.rpc.mockReturnValueOnce(first.query).mockReturnValueOnce(retry.query);
  const firstOutcome = observe(cloneTemplate(OWNER_ID, MODEL_ID, COPY_ID));
  await vi.advanceTimersByTimeAsync(REQUEST_BUDGET_MS);
  await flushMicrotasks();
  expect(firstOutcome.state).toBe('rejected');

  const retryOutcome = observe(cloneTemplate(OWNER_ID, MODEL_ID, COPY_ID));
  await flushMicrotasks();
  first.response.resolve({ data: copy, error: null });
  await flushMicrotasks();
  expect(firstOutcome.state).toBe('rejected');
  expect(retryOutcome.state).toBe('pending');
  retry.response.resolve({ data: copy, error: null });
  await flushMicrotasks();
  expect(retryOutcome.state).toBe('fulfilled');
  expect(retryOutcome.value).toEqual(copy);
  expect(client.rpc.mock.calls).toEqual(Array(2).fill([
    'clone_public_creator_model', { p_source_id: MODEL_ID, p_copy_id: COPY_ID, p_expected_user_id: OWNER_ID },
  ]));
  expect(vi.getTimerCount()).toBe(0);
});
