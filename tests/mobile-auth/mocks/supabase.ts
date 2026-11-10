import type { AuthChangeEvent, Session } from "@supabase/supabase-js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type ProfileResult = { data: { id: string; full_name: string | null } | null; error: Error | null };
type Listener = (event: AuthChangeEvent, session: Session | null) => unknown;
const listeners = new Set<Listener>();
const snapshots: ReturnType<typeof deferred<{ data: { session: Session | null }; error: Error | null }>>[] = [];
const queries: {
  userId: string;
  result: ReturnType<typeof deferred<ProfileResult>>;
  ready?: ProfileResult;
  failure?: Error;
  settled: boolean;
}[] = [];
const signOuts: ReturnType<typeof deferred<{ error: null }>>[] = [];
let heldLocks = 0;
let callbackDepth = 0;
let callsInsideCallback = 0;
let callsWhileLocked = 0;

function sessionFor(userId: string | null): Session | null {
  if (!userId) return null;
  return {
    access_token: `synthetic-access-${userId}`,
    refresh_token: `synthetic-refresh-${userId}`,
    token_type: "bearer",
    expires_in: 3600,
    user: { id: userId, email: `${userId}@example.invalid`, aud: "authenticated", created_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {} },
  };
}

function flushQueries() {
  if (heldLocks) return;
  for (const query of queries) {
    if (query.settled) continue;
    if (query.failure) {
      query.settled = true;
      query.result.reject(query.failure);
    } else if (query.ready) {
      query.settled = true;
      query.result.resolve(query.ready);
    }
  }
}

export const control = {
  listenerCount: () => listeners.size,
  snapshotCount: () => snapshots.length,
  queryCount: () => queries.length,
  queryUsers: () => queries.map((query) => query.userId),
  signOutCount: () => signOuts.length,
  stats: () => ({ heldLocks, callsInsideCallback, callsWhileLocked }),
  resolveSnapshot(userId: string | null, index = 0) {
    snapshots[index].resolve({ data: { session: sessionFor(userId) }, error: null });
  },
  rejectSnapshot(index = 0) {
    snapshots[index].reject(new Error("Synthetic session read failure"));
  },
  emit(userId: string | null, locked = false) {
    const returns: string[] = [];
    for (const listener of listeners) {
      if (locked) heldLocks += 1;
      callbackDepth += 1;
      const result = listener(userId ? "SIGNED_IN" : "SIGNED_OUT", sessionFor(userId));
      callbackDepth -= 1;
      returns.push(result instanceof Promise ? "promise" : typeof result);
      // Like Supabase, release the auth lock only after its listener returns.
      // A profile query requested by an awaited listener therefore deadlocks.
      void Promise.resolve(result).finally(() => {
        if (locked) heldLocks -= 1;
        flushQueries();
      });
    }
    return { returns, callsInsideCallback, callsWhileLocked };
  },
  resolveProfile(index: number, label = `profile-${index}`, owner?: string) {
    const query = queries[index];
    query.ready = { data: { id: owner ?? query.userId, full_name: label }, error: null };
    flushQueries();
  },
  rejectProfile(index: number) {
    queries[index].failure = new Error("Synthetic profile read failure");
    flushQueries();
  },
  resolveSignOut(index = 0) {
    signOuts[index].resolve({ error: null });
  },
};

export const supabase = {
  auth: {
    onAuthStateChange(callback: Listener) {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe: () => { listeners.delete(callback); } } } };
    },
    getSession() {
      const snapshot = deferred<{ data: { session: Session | null }; error: Error | null }>();
      snapshots.push(snapshot);
      return snapshot.promise;
    },
    async signUp(_options: unknown) { return { error: null as { message: string } | null }; },
    async signInWithPassword(_options: unknown) { return { error: null as { message: string } | null }; },
    async signInWithOAuth(_options: unknown) { return { data: { url: null }, error: null as { message: string } | null }; },
    async setSession(_tokens: unknown) { return { error: null }; },
    signOut() {
      const pending = deferred<{ error: null }>();
      signOuts.push(pending);
      return pending.promise;
    },
  },
  from(table: string) {
    if (table !== "profiles") throw new Error(`Unexpected table: ${table}`);
    if (callbackDepth) callsInsideCallback += 1;
    if (heldLocks) callsWhileLocked += 1;
    let userId = "";
    const query = {
      select(_columns: string) { return query; },
      eq(column: string, value: string) {
        if (column !== "id") throw new Error(`Unexpected filter: ${column}`);
        userId = value;
        return query;
      },
      single() {
        const result = deferred<ProfileResult>();
        queries.push({ userId, result, settled: false });
        return result.promise;
      },
    };
    return query;
  },
};
