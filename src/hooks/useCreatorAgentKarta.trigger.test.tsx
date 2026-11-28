import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTriggerCustomAgent } from './useCreatorAgentKarta';
import { customTriggerHarness, OWNER, OTHER_OWNER, AGENT, OTHER_AGENT, TOKEN } from '../../tests/helpers/custom-trigger-harness.mjs';

// The React hook, request scope/deadline and QueryClient are real. Supabase's
// session/invoke boundary is inert; the integrated case executes the real Edge,
// KARTA API and queue identity through the documented inert harness ports.
const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  token: '', invoke: vi.fn(), getSession: vi.fn(),
}));
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: h.invoke }, auth: { getSession: h.getSession } },
}));

const SESSION_A = '84000000-0000-4000-8000-000000000001';
const SESSION_B = '84000000-0000-4000-8000-000000000002';
const key = (owner = OWNER, agent = AGENT) => `purama:karta-custom-trigger:v1:${owner}:${agent}`;
const jobId = `karta-v2-dedupe-${'a'.repeat(64)}`;
const acknowledgement = (requestId: string, extra = {}) => ({
  data: { ok: true, queued: true, requestId, jobId, executionKey: `queue:v2:${jobId}`, ...extra }, error: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let hook: ReturnType<typeof useTriggerCustomAgent>;
let locksDescriptor: PropertyDescriptor | undefined;
const heldLocks = new Set<string>();
const requestLock = vi.fn((name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) => {
  if (heldLocks.has(name)) return Promise.resolve().then(() => callback(null));
  heldLocks.add(name);
  return Promise.resolve().then(() => callback({ name, mode: 'exclusive' } as Lock)).finally(() => heldLocks.delete(name));
});
function Probe({ agent, session }: { agent: string; session: string }) {
  hook = useTriggerCustomAgent(agent, session);
  return null;
}
async function render(agent = AGENT, session = SESSION_A) {
  await act(async () => root.render(<StrictMode><QueryClientProvider client={client}>
    <Probe agent={agent} session={session} />
  </QueryClientProvider></StrictMode>));
}
async function launch(agent = AGENT) {
  let pending!: ReturnType<typeof hook.mutateAsync>;
  await act(async () => {
    pending = hook.mutateAsync(agent);
    void pending.catch(() => {});
    await flush();
  });
  return { pending };
}
async function trigger(agent = AGENT) {
  let value!: Awaited<ReturnType<typeof hook.mutateAsync>>;
  await act(async () => { value = await hook.mutateAsync(agent); });
  return value;
}
async function refused(pending: ReturnType<typeof hook.mutateAsync>) {
  let reason: unknown;
  await act(async () => { try { await pending; } catch (error) { reason = error; } });
  expect(reason).toBeInstanceOf(Error);
  expect(String(reason)).not.toContain('PRIVATE_');
  expect(String(reason)).not.toContain(TOKEN);
  return reason as Error;
}

beforeEach(async () => {
  vi.clearAllMocks();
  heldLocks.clear();
  locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: requestLock } });
  localStorage.clear();
  h.user = { id: OWNER }; h.token = TOKEN;
  h.getSession.mockReset().mockImplementation(async () => ({
    data: { session: h.user ? { user: { ...h.user }, access_token: h.token } : null }, error: null,
  }));
  h.invoke.mockReset().mockImplementation(async (_name, options) => acknowledgement(options.body.requestId));
  // The hook must opt out of inherited automatic mutation retries.
  client = new QueryClient({ defaultOptions: { mutations: { retry: 3, retryDelay: 0 }, queries: { retry: false } } });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear(); host.remove();
  if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor);
  else Reflect.deleteProperty(navigator, 'locks');
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('custom trigger delivery continuity', () => {
  it('keeps an uncertain intention for explicit retry and creates a new one only after a correlated receipt', async () => {
    h.invoke.mockRejectedValueOnce(new Error('PRIVATE_LOST_ACK'));
    const first = await launch();
    await refused(first.pending);
    const original = h.invoke.mock.calls[0][1].body.requestId;
    expect(localStorage.getItem(key())).toBe(original);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key())).not.toContain(TOKEN);
    const receipt = await trigger();
    expect(h.invoke.mock.calls[1][1].body.requestId).toBe(original);
    expect(receipt.requestId).toBe(original);
    expect(localStorage.getItem(key())).toBeNull();
    await trigger();
    expect(h.invoke.mock.calls[2][1].body.requestId).not.toBe(original);
  });

  it('binds the explicit token to the captured owner and returns only projected metadata', async () => {
    h.invoke.mockImplementationOnce(async (_name, options) => acknowledgement(options.body.requestId, { token: TOKEN, raw: 'PRIVATE_RAW' }));
    const receipt = await trigger();
    expect(h.invoke.mock.calls[0][0]).toBe('karta-trigger-custom');
    expect(h.invoke.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(h.invoke.mock.calls[0][1].body.agentId).toBe(AGENT);
    expect(h.invoke.mock.calls[0][1].signal.aborted).toBe(true);
    expect(Object.keys(receipt).sort()).toEqual(['executionKey', 'jobId', 'ok', 'queued', 'requestId']);
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_');
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
  });

  it('blocks simultaneous admissions in the same hook before the SDK dispatch', async () => {
    const response = deferred<ReturnType<typeof acknowledgement>>();
    h.invoke.mockReturnValueOnce(response.promise);
    const first = await launch();
    const second = await launch();
    expect((await refused(second.pending)).message).toContain('déjà en cours');
    expect(h.invoke).toHaveBeenCalledTimes(1);
    const requestId = h.invoke.mock.calls[0][1].body.requestId;
    await act(async () => { response.resolve(acknowledgement(requestId)); await first.pending; });
  });

  it('refuses a competing hook/tab while the native owner/agent lock is held', async () => {
    heldLocks.add(key());
    const error = await refused((await launch()).pending);
    expect(error.message).toContain('déjà en cours');
    expect(requestLock.mock.calls[0][1]).toEqual({ mode: 'exclusive', ifAvailable: true });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem(key())).toBeNull();
    heldLocks.delete(key());
    await trigger();
    expect(heldLocks.size).toBe(0);
  });

  it('keeps one native lock around reservation, admission and confirmed retirement', async () => {
    const read = Storage.prototype.getItem;
    const write = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (name) {
      if (name === key()) expect(heldLocks.has(key())).toBe(true);
      return read.call(this, name);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (name, value) {
      if (name === key()) expect(heldLocks.has(key())).toBe(true);
      return write.call(this, name, value);
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (name) {
      if (name === key()) expect(heldLocks.has(key())).toBe(true);
      return remove.call(this, name);
    });
    await trigger();
    expect(requestLock).toHaveBeenCalledTimes(1);
    expect(heldLocks.size).toBe(0);
  });

  it('fails closed with an explicit message when Web Locks is unavailable', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const error = await refused((await launch()).pending);
    expect(error.message).toContain('navigateur');
    expect(h.invoke).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('rechecks the scope after delayed lock delivery without reserving an intention', async () => {
    const delayed = deferred<Lock>();
    requestLock.mockImplementationOnce((_name, _options, callback) => delayed.promise.then(callback));
    const old = await launch();
    await render(AGENT, SESSION_B);
    await refused(old.pending);
    await act(async () => { delayed.resolve({ name: key(), mode: 'exclusive' } as Lock); await flush(); });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('never downgrades a confirmed receipt when the outer lock handoff exceeds its deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const released = deferred<void>();
    requestLock.mockImplementationOnce(async (name, _options, callback) => {
      const accepted = await callback({ name, mode: 'exclusive' } as Lock);
      await released.promise;
      return accepted;
    });
    const old = await launch();
    const original = h.invoke.mock.calls[0][1].body.requestId;
    expect(localStorage.getItem(key())).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    await expect(old.pending).resolves.toMatchObject({ ok: true, requestId: original });
    await act(async () => { released.resolve(); await flush(); });
    await trigger();
    expect(h.invoke.mock.calls[1][1].body.requestId).not.toBe(original);
  });

  it.each([400, 401, 403, 404, 409, 429, 500, 502, 503, 504])('preserves identity and fixed messages after HTTP %s', async status => {
    h.invoke.mockResolvedValueOnce({ data: null, error: {
      message: 'PRIVATE_TRANSPORT', context: new Response('PRIVATE_BODY', { status }),
    } });
    const first = await launch();
    await refused(first.pending);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    const requestId = localStorage.getItem(key());
    await trigger();
    expect(h.invoke.mock.calls[1][1].body.requestId).toBe(requestId);
  });

  it.each([
    { ok: false }, { queued: false }, { requestId: 'another-intent' }, { jobId: 'legacy' },
    { executionKey: 'wrong' }, { requestId: undefined },
  ])('never rotates the intention on an invalid acceptance receipt %j', async change => {
    h.invoke.mockImplementationOnce(async (_name, options) => acknowledgement(options.body.requestId, change));
    const first = await launch();
    await refused(first.pending);
    const requestId = localStorage.getItem(key());
    expect(requestId).toBeTruthy();
    await trigger();
    expect(h.invoke.mock.calls[1][1].body.requestId).toBe(requestId);
  });

  it('cancels old account transport, isolates the new account, and recovers the old key on return', async () => {
    const oldResponse = deferred<ReturnType<typeof acknowledgement>>();
    h.invoke.mockReturnValueOnce(oldResponse.promise);
    const old = await launch();
    const oldId = h.invoke.mock.calls[0][1].body.requestId;
    const oldSignal = h.invoke.mock.calls[0][1].signal;
    h.user = { id: OTHER_OWNER }; h.token = 'synthetic-other-token';
    await render();
    expect(oldSignal.aborted).toBe(true);
    await refused(old.pending);
    const nextResponse = deferred<ReturnType<typeof acknowledgement>>();
    h.invoke.mockReturnValueOnce(nextResponse.promise);
    const current = await launch();
    const nextId = h.invoke.mock.calls[1][1].body.requestId;
    expect(nextId).not.toBe(oldId);
    expect(h.invoke.mock.calls[1][1].headers.Authorization).toBe('Bearer synthetic-other-token');
    await act(async () => { oldResponse.resolve(acknowledgement(oldId)); await flush(); });
    expect(localStorage.getItem(key())).toBe(oldId);
    expect(localStorage.getItem(key(OTHER_OWNER))).toBe(nextId);
    await act(async () => { nextResponse.resolve(acknowledgement(nextId)); await current.pending; });
    h.user = { id: OWNER }; h.token = TOKEN; await render();
    await trigger();
    expect(h.invoke.mock.calls[2][1].body.requestId).toBe(oldId);
  });

  it('isolates agents while recovering an unknown intention after navigating away and back', async () => {
    h.invoke.mockRejectedValueOnce(new Error('PRIVATE_LOST_ACK'));
    await refused((await launch()).pending);
    const original = localStorage.getItem(key());
    await render(OTHER_AGENT);
    const other = await trigger(OTHER_AGENT);
    expect(other.requestId).not.toBe(original);
    expect(h.invoke.mock.calls[1][1].body.agentId).toBe(OTHER_AGENT);
    await render(AGENT, SESSION_B);
    await trigger();
    expect(h.invoke.mock.calls[2][1].body.requestId).toBe(original);
  });

  it('a new chat fences the old completion without inventing another agent-level intention', async () => {
    const oldResponse = deferred<ReturnType<typeof acknowledgement>>();
    h.invoke.mockReturnValueOnce(oldResponse.promise);
    const old = await launch();
    const original = localStorage.getItem(key());
    await render(AGENT, SESSION_B);
    await refused(old.pending);
    await act(async () => { oldResponse.resolve(acknowledgement(original!)); await flush(); });
    expect(localStorage.getItem(key())).toBe(original);
    await trigger();
    expect(h.invoke.mock.calls[1][1].body.requestId).toBe(original);
  });

  it('logout before the session lookup finishes prevents any dispatch, including after a same-account return', async () => {
    const session = deferred<{ data: { session: { user: { id: string }; access_token: string } }; error: null }>();
    h.getSession.mockReturnValueOnce(session.promise);
    const old = await launch();
    const original = localStorage.getItem(key());
    h.user = null; await render();
    await refused(old.pending);
    h.user = { id: OWNER }; await render();
    await act(async () => { session.resolve({ data: { session: { user: { id: OWNER }, access_token: TOKEN } }, error: null }); await flush(); });
    expect(h.invoke).not.toHaveBeenCalled();
    await trigger();
    expect(h.invoke.mock.calls[0][1].body.requestId).toBe(original);
  });

  it('refuses a fresh SDK session belonging to another owner', async () => {
    h.getSession.mockResolvedValueOnce({ data: { session: { user: { id: OTHER_OWNER }, access_token: 'PRIVATE_WRONG_ACCOUNT' } }, error: null });
    expect((await refused((await launch()).pending)).message).toContain('session');
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('a token refresh retains the intention and uses the refreshed token', async () => {
    h.invoke.mockRejectedValueOnce(new Error('PRIVATE_LOST_ACK'));
    await refused((await launch()).pending);
    const original = localStorage.getItem(key());
    h.token = 'synthetic-refreshed-token'; await render();
    await trigger();
    expect(h.invoke.mock.calls[1][1].body.requestId).toBe(original);
    expect(h.invoke.mock.calls[1][1].headers.Authorization).toBe('Bearer synthetic-refreshed-token');
  });

  it('a stalled transport is bounded, aborted, and retried with the original intention', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const response = deferred<ReturnType<typeof acknowledgement>>();
    h.invoke.mockReturnValueOnce(response.promise);
    const first = await launch();
    const original = localStorage.getItem(key());
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    await refused(first.pending);
    expect(h.invoke.mock.calls[0][1].signal.aborted).toBe(true);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { response.resolve(acknowledgement(original!)); await flush(); });
    expect(localStorage.getItem(key())).toBe(original);
    await trigger();
    expect(h.invoke.mock.calls[1][1].body.requestId).toBe(original);
  });

  it('the total timeout includes a session lookup which never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    h.getSession.mockReturnValueOnce(new Promise(() => {}));
    const pending = await launch();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    await refused(pending.pending);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem(key())).toBeTruthy();
  });

  it('a remount retains pending identity and does not replay automatically', async () => {
    h.invoke.mockRejectedValueOnce(new Error('PRIVATE_LOST_ACK'));
    await refused((await launch()).pending);
    const original = localStorage.getItem(key());
    await act(async () => root.unmount());
    root = createRoot(host); await render();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    await trigger();
    expect(h.invoke.mock.calls[1][1].body.requestId).toBe(original);
  });

  it('refuses stale agent arguments and missing chat scope without creating an intention', async () => {
    await refused((await launch(OTHER_AGENT)).pending);
    await render(AGENT, '');
    await refused((await launch()).pending);
    expect(h.getSession).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('never replaces an unreadable pending record with another identity', async () => {
    localStorage.setItem(key(), 'PRIVATE_CORRUPTED_RECORD');
    const error = await refused((await launch()).pending);
    expect(error.message).toContain('conservé');
    expect(localStorage.getItem(key())).toBe('PRIVATE_CORRUPTED_RECORD');
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('fails closed before dispatch if the identifier cannot be persisted', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('PRIVATE_QUOTA'); });
    expect((await refused((await launch()).pending)).message).toContain('conservé');
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('integrates the actual hook and handler/API/queue through loss of acknowledgement and manual retry', async () => {
    let lose = true;
    const edge = customTriggerHarness({ transport: async (url, init, api) => {
      const response = await api(url, init);
      if (lose) { lose = false; throw new Error('PRIVATE_LOST_ACK'); }
      return response;
    } });
    h.invoke.mockImplementation(async (_name, options) => {
      const response = await edge.handler(edge.request(options.body, { headers: options.headers, signal: options.signal }));
      return response.ok ? { data: await response.json(), error: null } : { data: null, error: { context: response } };
    });
    await refused((await launch()).pending);
    const original = localStorage.getItem(key());
    expect(edge.state.jobs.size).toBe(1);
    const received = await trigger();
    expect(received.requestId).toBe(original);
    expect(edge.state.jobs.size).toBe(1);
    expect(edge.state.internal.map(call => call.headers['Idempotency-Key'])).toEqual([original, original]);
    await trigger();
    expect(edge.state.jobs.size).toBe(2);
  });
});
