import type { Session } from '@supabase/supabase-js';
import { supabase } from '../../src/integrations/supabase/client';

type SessionSnapshot = { userId: string | null; error: string | null };
type RefreshSnapshot = { state: 'idle' | 'pending' | 'settled'; userId: string | null; error: string | null };
const state = {
  boot: 'pending' as 'pending' | 'ready' | 'failed',
  bootError: null as string | null,
  reads: [] as SessionSnapshot[][],
  events: [] as { event: string; userId: string | null }[],
  visibility: [] as DocumentVisibilityState[],
  refresh: { state: 'idle', userId: null, error: null } as RefreshSnapshot,
};

const userId = (session: Session | null) => session?.user?.id ?? null;
const failureName = (error: unknown) => error instanceof Error ? error.name : String(error);

/** Observe actual SDK events without calling another auth operation from the subscriber. */
supabase.auth.onAuthStateChange((event, session) => {
  state.events.push({ event, userId: userId(session) });
});

async function readConcurrently(): Promise<SessionSnapshot[]> {
  const results = await Promise.all(Array.from({ length: 3 }, () => supabase.auth.getSession()));
  const snapshots = results.map(result => ({ userId: userId(result.data.session), error: result.error?.name ?? null }));
  state.reads.push(snapshots);
  return snapshots;
}

/** Let scheduled boot work and browser tasks finish; no fake clock or lock override. */
async function afterPendingTasks(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

async function simulateVisibilityReturn(): Promise<SessionSnapshot[]> {
  const ownDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  try {
    for (const visibility of ['hidden', 'visible'] as const) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
      state.visibility.push(visibility);
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    const result = await readConcurrently();
    await afterPendingTasks();
    return result;
  } finally {
    if (ownDescriptor) Object.defineProperty(document, 'visibilityState', ownDescriptor);
    else Reflect.deleteProperty(document, 'visibilityState');
  }
}

async function signOut(): Promise<{ error: string | null }> {
  const result = await supabase.auth.signOut();
  await afterPendingTasks();
  return { error: result.error?.name ?? null };
}

function startRefresh(): void {
  if (state.refresh.state === 'pending') throw new Error('Refresh already pending in the fixture');
  state.refresh = { state: 'pending', userId: null, error: null };
  void supabase.auth.refreshSession().then(result => {
    state.refresh = { state: 'settled', userId: userId(result.data.session), error: result.error?.name ?? null };
  }).catch(error => {
    state.refresh = { state: 'settled', userId: null, error: failureName(error) };
  });
}

async function readDatabase(schema: 'purama_ai' | 'public', actor: string) {
  const result = schema === 'public'
    ? await supabase.schema('public').from('user_tax_profiles').select('user_id').eq('user_id', actor).maybeSingle()
    : await supabase.from('subscriptions').select('user_id').eq('user_id', actor).maybeSingle();
  return { status: result.status, data: result.data, error: result.error?.code ?? null };
}

export const authProbe = { state, readConcurrently, afterPendingTasks, simulateVisibilityReturn, signOut, startRefresh, readDatabase };
declare global { interface Window { __sdkAuthProbe: typeof authProbe } }
window.__sdkAuthProbe = authProbe;

void readConcurrently().then(afterPendingTasks).then(() => {
  state.boot = 'ready';
  document.querySelector('[data-testid="sdk-status"]')!.textContent = 'ready';
}).catch(error => {
  state.boot = 'failed';
  state.bootError = failureName(error);
  document.querySelector('[data-testid="sdk-status"]')!.textContent = 'failed';
});
