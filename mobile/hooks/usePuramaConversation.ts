import { useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { offlineAccount, type OfflineAccount } from "@/lib/offline-account";
import { createIaoConversation, type ConversationView, type IaoConversation } from "@/lib/iao-conversation";
import { createSmaranaSync, type SmaranaSyncState } from "@/lib/smarana-sync";
import type { SmaranaStore } from "@/lib/smarana-store";
import type { IaoLocalEngine } from "@/lib/iao-local-engine";

type Runtime = {
  account: OfflineAccount;
  ledgerTicket: number;
  store: SmaranaStore;
  engine: IaoLocalEngine;
  conversation: IaoConversation;
  sync: ReturnType<typeof createSmaranaSync>;
  unsubscribe: () => void;
  ready: boolean;
  permissionCurrent: boolean;
  leaving: boolean;
  retiring: boolean;
};
type Preparation = { controller: AbortController; lifetime: symbol; kind: "account" | "pack" };
const emptyView: ConversationView = { record: null, conversations: [], draft: "", dirty: false,
  busy: false, transitioning: false, liveText: "", error: null, contextTruncated: false, hasMoreHistory: false };
const AUTH_BUDGET_MS = 30_000;

/** Native resources are process-wide. A new screen must wait for the previous
 * transcript to drain. A failed save stays retryable here; it never closes its
 * database merely because React has unmounted its view. */
let runtimeTransitions: Promise<void> = Promise.resolve();
let engineOwner: Runtime | null = null;
const retirements: { instance: Runtime; released: Promise<void> }[] = [];
async function drainRetirements(): Promise<void> {
  while (retirements.length) {
    const pending = retirements[0];
    await pending.instance.conversation.close();
    await pending.released;
    await pending.instance.store.close();
    retirements.shift();
  }
}
function serializedRuntime<T>(work: () => Promise<T>): Promise<T> {
  const result = runtimeTransitions.then(async () => { await drainRetirements(); return work(); });
  runtimeTransitions = result.then(() => {}, () => {});
  return result;
}
function retire(instance: Runtime): void {
  if (instance.retiring) return;
  instance.retiring = true;
  instance.permissionCurrent = false;
  instance.sync.stop();
  instance.unsubscribe();
  instance.conversation.stop();
  // Capture the owned operation NOW. A delayed release() would instead abort
  // whatever a later screen had started on the singleton native engine.
  let released = Promise.resolve();
  if (engineOwner === instance) {
    engineOwner = null;
    try { released = instance.engine.release(); }
    catch (error) { released = Promise.reject(error); }
  }
  void released.catch(() => {});
  retirements.push({ instance, released });
}

function readableError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === "cipher_unavailable") return "Cette version de l’application ne contient pas encore la mémoire protégée. Une nouvelle installation native est nécessaire.";
  if (code === "missing_key" || code === "invalid_key" || code === "unlock_failed") return "La mémoire de ce compte ne peut pas être déverrouillée. Les données existantes sont conservées ; aucune base n’a été remplacée.";
  if (code === "closed") return "Le compte a changé. Rouvrez votre conversation.";
  return error instanceof Error ? error.message : "L’opération n’a pas abouti. Vos données déjà enregistrées restent conservées.";
}
function interrupted(): Error { return new Error("L’opération a été interrompue. Réessayez lorsque votre compte est disponible."); }
async function scopedWait<T>(start: () => PromiseLike<T>, signal: AbortSignal, current: () => boolean,
  deadline = Number.POSITIVE_INFINITY): Promise<T> {
  const assertCurrent = () => {
    if (signal.aborted || !current()) throw interrupted();
    if (performance.now() >= deadline) throw new Error("La vérification a pris trop de temps. Réessayez avec une connexion disponible.");
  };
  assertCurrent();
  let abort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(interrupted());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const value = await Promise.race([Promise.resolve().then(() => { assertCurrent(); return start(); }), cancelled]);
    assertCurrent();
    return value;
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

export function usePuramaConversation() {
  const focused = useIsFocused();
  const [account, setAccount] = useState<OfflineAccount | null>(null);
  const [view, setView] = useState<ConversationView>(emptyView);
  const [phase, setPhase] = useState<"loading" | "account" | "ready" | "unavailable" | "error">("loading");
  const [pack, setPack] = useState<ReturnType<IaoLocalEngine["getState"]> | null>(null);
  const [syncState, setSyncState] = useState<SmaranaSyncState>("paused");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const runtime = useRef<Runtime | null>(null);
  const preparation = useRef<Preparation | null>(null);
  const lifetime = useRef<symbol | null>(null);
  const foreground = useRef(AppState.currentState === "active");
  const refreshIdentity = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!focused) return;
    const scope = Symbol("purama-conversation-screen");
    lifetime.current = scope;
    foreground.current = AppState.currentState === "active";
    let sequence = 0;
    let ledgerTicket = offlineAccount.verificationTicket();
    let reconcileTask: Promise<void> | null = null;
    let reconcileAgain = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const active = () => lifetime.current === scope;
    const abortPreparation = (includeAccount = true) => {
      const previous = preparation.current;
      if (!includeAccount && previous?.kind === "account") return;
      preparation.current = null;
      previous?.controller.abort();
      if (active()) setPreparing(false);
    };
    const clearRuntime = (cancelVerification = true) => {
      abortPreparation(cancelVerification);
      clearTimeout(expiry);
      const previous = runtime.current;
      runtime.current = null;
      if (previous) retire(previous);
      if (active()) {
        setView(emptyView); setPack(null); setAccount(null);
        setSyncState("paused"); setSyncMessage(null); setError(null);
      }
      // The next opening also retries this drain if saving failed.
      void serializedRuntime(async () => {}).catch(() => {});
    };
    const armExpiry = (next: OfflineAccount) => {
      clearTimeout(expiry);
      expiry = setTimeout(() => {
        if (!active()) return;
        clearRuntime(); setPhase("account");
        void reconcile();
      }, Math.max(0, next.validUntil - Date.now()));
    };
    const reconcileOnce = async (ticket: number) => {
      if (!active()) return;
      if (Platform.OS === "web") { setPhase("unavailable"); return; }
      try {
        const next = await offlineAccount.read();
        if (!active() || ticket !== sequence) return;
        if (!next || next.validUntil <= Date.now()) { clearRuntime(); setPhase("account"); return; }
        const current = runtime.current;
        if (current?.account.ownerId === next.ownerId && !current.retiring) {
          current.account = next; current.permissionCurrent = true;
          setAccount(next); armExpiry(next);
          if (!next.autoSync) current.sync.stop();
          else if (foreground.current && current.ready) void current.sync.run();
          return;
        }
        clearRuntime(false);
        setPhase("loading");
        await serializedRuntime(async () => {
          if (!active() || ticket !== sequence) return;
          const [native, engines, crypto] = await Promise.all([
            import("@/lib/smarana-native"), import("@/lib/iao-local-engine"), import("expo-crypto"),
          ]);
          if (!active() || ticket !== sequence) return;
          const store = await native.openSmaranaStore(next.ownerId);
          if (!active() || ticket !== sequence) { await store.close(); return; }
          const engine = engines.getIaoLocalEngine();
          let instance: Runtime | null = null;
          try {
            const conversation = createIaoConversation({ store, engine, uuid: () => crypto.randomUUID() });
            const currentScope = () => active() && instance !== null && runtime.current === instance
              && instance.ledgerTicket === offlineAccount.verificationTicket() && !instance.retiring;
            const allowed = () => {
              if (!currentScope() || !instance?.ready || !instance.permissionCurrent || instance.leaving
                || !foreground.current || !instance.account.autoSync || instance.account.validUntil <= Date.now()) return false;
              const state = conversation.getState();
              return !state.busy && !state.dirty && !state.transitioning && !state.liveText;
            };
            const sync = createSmaranaSync({
              store, allowed, fetch: (...args) => fetch(...args),
              credentials: async signal => {
                const { supabase } = await scopedWait(() => import("@/lib/supabase"), signal, allowed);
                const sessionRead = supabase.auth.getSession();
                // Native autoRefreshToken is disabled. AuthProvider owns any
                // explicit foreground refresh; this read only refreshes on demand.
                const result = await scopedWait(() => sessionRead, signal, allowed);
                const session = result.data.session;
                if (result.error || session?.user.id !== store.ownerId) throw new Error("Vérifiez à nouveau votre compte pour synchroniser.");
                const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
                const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
                if (!url || !anonKey) throw new Error("La synchronisation du compte n’est pas configurée dans cette version.");
                return { ownerId: session.user.id, accessToken: session.access_token, url, anonKey };
              },
              onState: (state, message) => {
                if (!currentScope()) return;
                setSyncState(state); setSyncMessage(message ?? null);
                if (state !== "syncing") void conversation.refresh().catch(() => {});
              },
            });
            const unsubscribeView = conversation.subscribe(() => { if (currentScope()) setView(conversation.getState()); });
            const unsubscribePack = engine.subscribe(() => { if (currentScope()) setPack(engine.getState()); });
            instance = { account: next, ledgerTicket, store, engine, conversation, sync, ready: false,
              permissionCurrent: true, leaving: false, retiring: false,
              unsubscribe: () => { unsubscribeView(); unsubscribePack(); } };
            runtime.current = instance;
            engineOwner = instance;
            setAccount(next); setPack(engine.getState()); armExpiry(next);
            await conversation.open();
            if (!currentScope()) return;
            instance.ready = true;
            setView(conversation.getState()); setPhase("ready"); setError(null);
            void engine.inspect().catch(problem => { if (currentScope()) setError(readableError(problem)); });
            if (next.autoSync && foreground.current) void sync.run();
          } catch (problem) {
            if (instance) {
              if (runtime.current === instance) runtime.current = null;
              retire(instance);
              await drainRetirements();
            } else await store.close();
            throw problem;
          }
        });
      } catch (problem) {
        if (active() && ticket === sequence) { clearRuntime(); setPhase("error"); setError(readableError(problem)); }
      }
    };
    const reconcile = (): Promise<void> => {
      if (!active()) return Promise.resolve();
      const current = runtime.current;
      if (current && current.account.validUntil <= Date.now()) { clearRuntime(); setPhase("account"); }
      reconcileAgain = true;
      if (reconcileTask) return reconcileTask;
      const task = (async () => {
        while (active() && reconcileAgain) {
          reconcileAgain = false;
          await reconcileOnce(sequence);
        }
      })();
      reconcileTask = task;
      void task.finally(() => {
        if (reconcileTask === task) {
          reconcileTask = null;
          if (active() && reconcileAgain) void reconcile();
        }
      }).catch(() => {});
      return task;
    };
    refreshIdentity.current = reconcile;
    const unsubscribeAccount = offlineAccount.subscribe(() => {
      if (!active()) return;
      const nextTicket = offlineAccount.verificationTicket();
      if (nextTicket !== ledgerTicket) {
        ledgerTicket = nextTicket; sequence++; clearRuntime(); setPhase("loading");
      } else if (runtime.current) {
        // No old preference may authorize another upload while its replacement
        // is being read from protected storage.
        runtime.current.permissionCurrent = false;
        runtime.current.sync.stop();
      }
      void reconcile();
    });
    const appState = AppState.addEventListener("change", state => {
      if (!active()) return;
      foreground.current = state === "active";
      if (state !== "active") {
        abortPreparation();
        const current = runtime.current;
        current?.sync.stop(); current?.conversation.stop();
        void current?.conversation.flush().catch(problem => { if (active() && runtime.current === current) setError(readableError(problem)); });
      } else void reconcile();
    });
    const timer = setInterval(() => {
      if (!active()) return;
      const current = runtime.current;
      if (current && current.account.validUntil <= Date.now()) void reconcile();
      else if (foreground.current) void current?.sync.run();
    }, 30_000);
    setPhase("loading");
    void reconcile();
    return () => {
      sequence++; clearInterval(timer); clearTimeout(expiry);
      unsubscribeAccount(); appState.remove();
      clearRuntime();
      if (lifetime.current === scope) lifetime.current = null;
      if (refreshIdentity.current === reconcile) refreshIdentity.current = async () => {};
      // AuthProvider owns route activation. Never stop its new refresh work from
      // an old screen's asynchronous cleanup.
    };
  }, [focused]);

  // Native UI events may already be queued when the account changes. Bind each
  // exposed callback to the render that authorized it, never to a later vault.
  const renderedLifetime = lifetime.current;
  const renderedRuntime = runtime.current;
  const renderedTicket = offlineAccount.verificationTicket();
  const operationCurrent = (scope: symbol | null, current?: Runtime | null) =>
    scope !== null && lifetime.current === scope && focused
    && (current === undefined || (runtime.current === current
      && (!current || (current.ledgerTicket === offlineAccount.verificationTicket() && !current.retiring))));
  const operate = async (action: (current: Runtime) => Promise<void>) => {
    const scope = renderedLifetime;
    const current = renderedRuntime;
    if (!operationCurrent(scope, current) || !current?.ready || current.leaving || !foreground.current) return;
    if (current.account.validUntil <= Date.now()) { await refreshIdentity.current(); return; }
    try {
      setError(null);
      await action(current);
      if (operationCurrent(scope, current)) void current.sync.run();
    } catch (problem) { if (operationCurrent(scope, current)) setError(readableError(problem)); }
  };
  const verifyAccount = async () => {
    const scope = renderedLifetime;
    if (Platform.OS === "web" || preparation.current || !operationCurrent(scope, renderedRuntime)
      || renderedTicket !== offlineAccount.verificationTicket() || !foreground.current) return;
    const controller = new AbortController();
    const task: Preparation = { controller, lifetime: scope!, kind: "account" };
    preparation.current = task;
    const ticket = offlineAccount.verificationTicket();
    const current = () => operationCurrent(scope) && ticket === offlineAccount.verificationTicket();
    const deadline = performance.now() + AUTH_BUDGET_MS;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, AUTH_BUDGET_MS);
    setPreparing(true); setError(null);
    try {
      const { supabase } = await scopedWait(() => import("@/lib/supabase"), controller.signal, current, deadline);
      const sessionRead = supabase.auth.getSession();
      const snapshot = await scopedWait(() => sessionRead, controller.signal, current, deadline);
      const session = snapshot.data.session;
      if (snapshot.error || !session) throw new Error("Connectez d’abord votre compte PURAMA, puis revenez ici pour le préparer.");
      const verified = await scopedWait(() => supabase.auth.getUser(session.access_token), controller.signal, current, deadline);
      if (verified.error || verified.data.user?.id !== session.user.id) throw new Error("La vérification du compte demande une connexion disponible.");
      await scopedWait(() => offlineAccount.rememberVerified(verified.data.user!.id, ticket, controller.signal),
        controller.signal, current, deadline);
      if (current()) await refreshIdentity.current();
    } catch (problem) {
      if (current()) setError(timedOut ? "La vérification a pris trop de temps. Réessayez avec une connexion disponible." : readableError(problem));
    }
    finally {
      clearTimeout(timeout);
      if (preparation.current === task) {
        preparation.current = null;
        if (operationCurrent(scope)) setPreparing(false);
      }
    }
  };
  const preparePack = async () => {
    if (preparation.current) return;
    await operate(async current => {
      const scope = renderedLifetime!;
      const controller = new AbortController();
      const task: Preparation = { controller, lifetime: scope, kind: "pack" };
      preparation.current = task;
      setPreparing(true);
      try { await current.engine.prepare(controller.signal); }
      finally {
        if (preparation.current === task) {
          preparation.current = null;
          if (operationCurrent(scope, current)) setPreparing(false);
        }
      }
    });
  };
  const setAutoSync = async (allowed: boolean) => {
    const scope = renderedLifetime;
    const current = renderedRuntime;
    if (!current || !operationCurrent(scope, current) || current.account.validUntil <= Date.now()) return;
    if (!allowed) {
      current.account = { ...current.account, autoSync: false };
      setAccount(current.account); current.sync.stop();
    }
    try { await offlineAccount.setAutoSync(current.account.ownerId, allowed); }
    catch (problem) { if (operationCurrent(scope, current)) setError(readableError(problem)); }
  };
  const prepareToLeave = async () => {
    const scope = renderedLifetime;
    const current = renderedRuntime;
    if (!operationCurrent(scope, current) || renderedTicket !== offlineAccount.verificationTicket()) throw interrupted();
    if (!current) return;
    current.leaving = true;
    current.sync.stop();
    preparation.current?.controller.abort();
    try {
      await current.conversation.close();
      if (!operationCurrent(scope, current)) throw interrupted();
    } catch (problem) {
      if (operationCurrent(scope, current)) { current.leaving = false; setError(readableError(problem)); }
      throw problem;
    }
  };
  const visible = runtime.current?.ready && operationCurrent(lifetime.current, runtime.current)
    && runtime.current.account.validUntil > Date.now();
  return {
    account: visible ? account : null, view: visible ? view : emptyView,
    phase: phase === "ready" && !visible ? "loading" as const : phase,
    pack: visible ? pack : null, syncState, syncMessage, error, preparing,
    verifyAccount, preparePack, setAutoSync, prepareToLeave,
    retry: () => operationCurrent(renderedLifetime) && renderedTicket === offlineAccount.verificationTicket()
      ? refreshIdentity.current() : Promise.resolve(),
    setDraft: (text: string) => {
      const current = renderedRuntime;
      if (!current || !operationCurrent(renderedLifetime, current) || current.leaving || !foreground.current) return;
      if (current.account.validUntil <= Date.now()) { void refreshIdentity.current(); return; }
      current.conversation.setDraft(text);
    },
    send: () => operate(current => current.conversation.send()),
    stop: () => {
      if (!operationCurrent(renderedLifetime, renderedRuntime) || renderedTicket !== offlineAccount.verificationTicket()) return;
      if (preparation.current?.lifetime === renderedLifetime) preparation.current.controller.abort();
      renderedRuntime?.conversation.stop();
    },
    save: () => operate(current => current.conversation.flush()),
    synchronize: () => operate(current => current.sync.run()),
    newConversation: () => operate(current => current.conversation.newConversation()),
    loadMoreHistory: () => operate(current => current.conversation.loadMoreHistory()),
    select: (id: string) => operate(current => current.conversation.open(id)),
    remove: () => operate(current => current.conversation.removeConversation()),
    resolve: (choice: "remote" | "keep-both") => operate(current => current.conversation.resolveConflict(choice)),
  };
}
