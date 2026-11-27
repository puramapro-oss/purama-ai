import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNotifications, useNotificationPreferences } from './useNotifications';

// Real React and QueryClient; only database, realtime and toast effects are inert.
const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  from: vi.fn(), channel: vi.fn(), removeChannel: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: h }));
vi.mock('sonner', () => ({ toast: h.toast }));

const OWNER = '84000000-0000-4000-8000-000000000001';
const OTHER = '84000000-0000-4000-8000-000000000002';
const ID = '94000000-0000-4000-8000-000000000001';
const date = '2026-11-27T00:00:00Z';
const notification = (extra = {}) => ({ id: ID, user_id: OWNER, agent_slug: null,
  type: 'alert', title: 'Une information', message: 'Message privé', read: false,
  action_url: '/dashboard', created_at: date, ...extra });
const preferences = (owner = OWNER, extra = {}) => ({ id: ID, user_id: owner,
  email_enabled: true, task_completed_enabled: true, question_enabled: true,
  daily_report_enabled: true, alert_enabled: true, created_at: date, updated_at: date, ...extra });

type Reply = { data: unknown; error: unknown };
type Operation = { table: string; action: string; values?: Record<string, unknown>; filters: Array<[string, unknown]> };
type Channel = { name: string; filter?: Record<string, unknown>; callback?: (payload: { new: unknown }) => void;
  on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let calls: Operation[];
let channels: Channel[];
let writeReply: Reply | Promise<Reply> | undefined;
let readRows: unknown[];
let readPreferences: Reply | undefined;
const hooks = new Map<string, { notifications: ReturnType<typeof useNotifications>; preferences: ReturnType<typeof useNotificationPreferences> }>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function Probe({ name }: { name: string }) {
  const notifications = useNotifications();
  const prefs = useNotificationPreferences();
  hooks.set(name, { notifications, preferences: prefs });
  return <div data-probe={name}>{notifications.notifications.map(row =>
    <a key={row.id} href={row.action_url ?? undefined}>{row.title}</a>)}</div>;
}

async function render(owner: string | null = OWNER, count = 1) {
  h.user = owner ? { id: owner } : null;
  await act(async () => {
    root.render(<StrictMode><QueryClientProvider client={client}>
      {Array.from({ length: count }, (_, index) => <Probe key={index} name={String(index)} />)}
    </QueryClientProvider></StrictMode>);
  });
}

function emit(channel: Channel, row = notification()) {
  channel.callback?.({ new: row });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.user = { id: OWNER }; calls = []; channels = []; hooks.clear();
  writeReply = undefined; readPreferences = undefined; readRows = [];
  client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: Infinity }, mutations: { retry: 2, retryDelay: 0 },
  } });
  for (const owner of [OWNER, OTHER]) {
    client.setQueryData(['notifications', owner], []);
    client.setQueryData(['notification-preferences', owner], preferences(owner));
  }
  vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
  h.removeChannel.mockResolvedValue('ok');
  h.channel.mockImplementation((name: string) => {
    const channel: Channel = { name, on: vi.fn(), subscribe: vi.fn() };
    channel.on.mockImplementation((_event, filter, callback) => {
      channel.filter = filter; channel.callback = callback; return channel;
    });
    channel.subscribe.mockReturnValue(channel); channels.push(channel); return channel;
  });
  h.from.mockImplementation((table: string) => {
    const op: Operation = { table, action: 'read', filters: [] };
    const finish = async (single = false): Promise<Reply> => {
      calls.push({ ...op, filters: [...op.filters] });
      const owner = op.filters.find(([key]) => key === 'user_id')?.[1] as string | undefined;
      if (op.action === 'read') return table === 'notifications'
        ? { data: readRows, error: null }
        : (readPreferences ?? { data: preferences(owner), error: null });
      if (writeReply) return await writeReply;
      if (table === 'notification_preferences') return {
        data: preferences(String(op.values?.user_id ?? owner ?? OWNER), op.values), error: null,
      };
      const row = notification({ user_id: owner ?? OWNER, ...(op.values ?? {}) });
      return { data: single ? row : [row], error: null };
    };
    const builder = {
      select: vi.fn(() => builder), order: vi.fn(() => builder),
      eq: vi.fn((key, value) => { op.filters.push([key, value]); return builder; }),
      or: vi.fn(value => { op.filters.push(['or', value]); return builder; }),
      update: vi.fn(values => { op.action = 'update'; op.values = values; return builder; }),
      insert: vi.fn(values => { op.action = 'insert'; op.values = values; return builder; }),
      upsert: vi.fn((values, options) => {
        expect(options).toEqual({ onConflict: 'user_id' });
        op.action = 'upsert'; op.values = values; return builder;
      }),
      delete: vi.fn(() => { op.action = 'delete'; return builder; }),
      maybeSingle: vi.fn(() => finish(true)), single: vi.fn(() => finish(true)),
      then: (resolve: (value: Reply) => unknown, reject: (reason: unknown) => unknown) => finish().then(resolve, reject),
    };
    return builder;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear(); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('notification realtime ownership and navigation', () => {
  it('subscribes to the same dedicated schema and current owner as database reads', () => {
    expect(channels.at(-1)?.filter).toMatchObject({ schema: 'purama_ai', table: 'notifications', filter: `user_id=eq.${OWNER}` });
  });

  it('gives each mounted subscription and StrictMode lifetime its own channel', async () => {
    await render(OWNER, 2);
    expect(new Set(channels.map(item => item.name)).size).toBe(channels.length);
  });

  it('accepts a current insertion and refreshes only its owner cache', async () => {
    await act(async () => emit(channels.at(-1)!));
    expect(h.toast).toHaveBeenCalledWith('Une information', expect.objectContaining({
      description: 'Message privé', id: `notification:${OWNER}:${ID}`,
    }));
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['notifications', OWNER] });
  });

  it('does not deliver a callback from the previous StrictMode effect', async () => {
    await act(async () => emit(channels[0]));
    expect(h.toast).not.toHaveBeenCalled();
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });

  it('does not deliver old account callbacks across A to B to A', async () => {
    const previous = channels.at(-1)!;
    await render(OTHER); await render(OWNER);
    await act(async () => emit(previous));
    expect(h.toast).not.toHaveBeenCalled();
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });

  it('does not deliver a current channel payload belonging to another account', async () => {
    await act(async () => emit(channels.at(-1)!, notification({ user_id: OTHER })));
    expect(h.toast).not.toHaveBeenCalled();
  });

  it.each(['javascript:alert(1)', '//attacker.invalid/', '/\\attacker.invalid/', 'https://name:password@example.org'])('removes unsafe historical action %s from realtime', async action_url => {
    await act(async () => emit(channels.at(-1)!, notification({ action_url })));
    expect(h.toast.mock.calls[0]?.[1].action).toBeUndefined();
  });

  it('sanitizes fetched historical links and filters foreign/malformed rows before rendering', async () => {
    client.removeQueries({ queryKey: ['notifications', OWNER], exact: true });
    readRows = [notification({ action_url: 'javascript:alert(1)' }), notification({ id: 'foreign', user_id: OTHER }), notification({ id: 'broken', created_at: 'invalid' })];
    await render();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(hooks.get('0')!.notifications.notifications).toHaveLength(1);
    expect(hooks.get('0')!.notifications.notifications[0].action_url).toBeNull();
    expect(host.querySelector('a')?.getAttribute('href')).toBeNull();
  });

  it('cleans up its subscriptions on logout and ignores a late callback', async () => {
    const previous = channels.at(-1)!;
    await render(null);
    expect(h.removeChannel).toHaveBeenCalledWith(previous);
    await act(async () => emit(previous));
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('dismisses only private toasts created by the departing account', async () => {
    await act(async () => emit(channels.at(-1)!));
    await render(OTHER);
    expect(h.toast.dismiss).toHaveBeenCalledWith(`notification:${OWNER}:${ID}`);
    expect(h.toast.dismiss.mock.calls.every(([id]) => typeof id === 'string' && id.includes(OWNER))).toBe(true);
  });
});

describe('notification mutation receipts', () => {
  it.each(['markAsRead', 'deleteNotification'] as const)('scopes %s to both the notification and current account', async operation => {
    await act(async () => { await hooks.get('0')!.notifications[operation].mutateAsync(ID); });
    const write = calls.find(call => call.action !== 'read')!;
    expect(write.filters).toContainEqual(['id', ID]);
    expect(write.filters).toContainEqual(['user_id', OWNER]);
  });

  it.each(['markAsRead', 'deleteNotification'] as const)('rejects an absent receipt for %s', async operation => {
    writeReply = { data: null, error: null };
    await act(async () => { await expect(hooks.get('0')!.notifications[operation].mutateAsync(ID)).rejects.toBeDefined(); });
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });

  it('does not retry mutation effects automatically after a database error', async () => {
    writeReply = { data: null, error: { message: 'PRIVATE_PROVIDER_DETAIL' } };
    await act(async () => { await expect(hooks.get('0')!.notifications.markAsRead.mutateAsync(ID)).rejects.toBeDefined(); });
    expect(calls.filter(call => call.action === 'update')).toHaveLength(1);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(JSON.stringify(h.toast.error.mock.calls)).not.toContain('PRIVATE_PROVIDER_DETAIL');
  });

  it('rejects mark-all-read while logged out without a false success message', async () => {
    await render(null);
    await act(async () => { await expect(hooks.get('0')!.notifications.markAllAsRead.mutateAsync()).rejects.toBeDefined(); });
    expect(calls.filter(call => call.action !== 'read')).toHaveLength(0);
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it('marks SQL NULL read flags as unread in the same owner-bound operation', async () => {
    await act(async () => { await hooks.get('0')!.notifications.markAllAsRead.mutateAsync(); });
    expect(calls[0].filters).toContainEqual(['or', 'read.eq.false,read.is.null']);
    expect(calls[0].filters).toContainEqual(['user_id', OWNER]);
    expect(h.toast.success).toHaveBeenCalledWith('1 notification marquée comme lue');
  });

  it('does not claim all notifications were changed when the receipt is empty', async () => {
    writeReply = { data: [], error: null };
    await act(async () => { await hooks.get('0')!.notifications.markAllAsRead.mutateAsync(); });
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('Aucune notification modifiée');
  });

  it('does not confirm an old mutation in a newly authenticated account', async () => {
    const deferredReply = deferred<Reply>(); writeReply = deferredReply.promise;
    let pending!: Promise<unknown>;
    await act(async () => { pending = hooks.get('0')!.notifications.markAllAsRead.mutateAsync(); await Promise.resolve(); });
    await render(OTHER);
    await act(async () => { deferredReply.resolve({ data: [notification({ read: true })], error: null }); await pending; });
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(client.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ['notifications', OTHER] });
  });

  it('does not show an old mutation failure in a new account', async () => {
    const response = deferred<Reply>(); writeReply = response.promise;
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = hooks.get('0')!.notifications.markAllAsRead.mutateAsync();
      void pending.catch(() => {}); await Promise.resolve();
    });
    await render(OTHER);
    await act(async () => {
      response.resolve({ data: null, error: { message: 'PRIVATE_OLD_ERROR' } });
      await expect(pending).rejects.toBeDefined();
    });
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it('does not let a retained callback modify the newly selected account', async () => {
    const oldMarkAll = hooks.get('0')!.notifications.markAllAsRead.mutateAsync;
    await render(OTHER);
    await act(async () => { await expect(oldMarkAll()).rejects.toBeDefined(); });
    expect(calls.filter(call => call.action !== 'read')).toHaveLength(0);
  });
});

describe('notification preferences', () => {
  it('saves only preference booleans with one atomic owner-bound upsert', async () => {
    await act(async () => { await hooks.get('0')!.preferences.updatePreferences.mutateAsync({ email_enabled: false }); });
    expect(calls).toEqual([{ table: 'notification_preferences', action: 'upsert', values: { user_id: OWNER, email_enabled: false }, filters: [] }]);
    expect(h.toast.success).toHaveBeenCalledOnce();
  });

  it.each([{ user_id: OTHER }, { email_enabled: 'false' }, {}])('rejects an invalid preference patch without writes: %j', async patch => {
    await act(async () => {
      await expect(hooks.get('0')!.preferences.updatePreferences.mutateAsync(patch as never)).rejects.toBeDefined();
    });
    expect(calls).toHaveLength(0);
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it('requires a persisted matching value and owner before success', async () => {
    writeReply = { data: preferences(OTHER, { email_enabled: false }), error: null };
    await act(async () => {
      await expect(hooks.get('0')!.preferences.updatePreferences.mutateAsync({ email_enabled: false })).rejects.toBeDefined();
    });
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it('rejects a preference mutation after logout', async () => {
    await render(null);
    await act(async () => {
      await expect(hooks.get('0')!.preferences.updatePreferences.mutateAsync({ email_enabled: false })).rejects.toBeDefined();
    });
    expect(calls).toHaveLength(0);
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it('keeps old preference acknowledgements out of a later A to B to A lifetime', async () => {
    const response = deferred<Reply>(); writeReply = response.promise;
    let pending!: Promise<unknown>;
    await act(async () => { pending = hooks.get('0')!.preferences.updatePreferences.mutateAsync({ email_enabled: false }); await Promise.resolve(); });
    await render(OTHER); await render(OWNER);
    await act(async () => { response.resolve({ data: preferences(OWNER, { email_enabled: false }), error: null }); await pending; });
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it('does not apply a retained preference callback to a new account', async () => {
    const oldSave = hooks.get('0')!.preferences.updatePreferences.mutateAsync;
    await render(OTHER);
    await act(async () => { await expect(oldSave({ email_enabled: false })).rejects.toBeDefined(); });
    expect(calls).toHaveLength(0);
  });

  it('does not apply a retained preference callback after A to B to A', async () => {
    const oldSave = hooks.get('0')!.preferences.updatePreferences.mutateAsync;
    await render(OTHER); await render(OWNER);
    await act(async () => { await expect(oldSave({ email_enabled: false })).rejects.toBeDefined(); });
    expect(calls).toHaveLength(0);
  });

  it.each([undefined, false, 0])('does not turn a malformed preference response into enabled defaults: %j', async data => {
    client.removeQueries({ queryKey: ['notification-preferences', OWNER], exact: true });
    readPreferences = { data, error: null };
    await render();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(hooks.get('0')!.preferences.isError).toBe(true);
    expect(hooks.get('0')!.preferences.preferences).toBeUndefined();
  });
});
