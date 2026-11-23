import { parseSmaranaApplyResult, parseSmaranaPullResult } from "../../shared/smarana";
import type { SmaranaStore } from "./smarana-store";

export type SmaranaCredentials = { ownerId: string; accessToken: string; url: string; anonKey: string };
export type SmaranaSyncState = "idle" | "syncing" | "paused" | "pending" | "conflict" | "synced";

/** A data-only transport. It never calls chat generation, agents or action queues. */
export function createSmaranaSync(dependencies: {
  store: SmaranaStore;
  credentials: (signal: AbortSignal) => Promise<SmaranaCredentials>;
  allowed: () => boolean;
  fetch: typeof fetch;
  onState?: (state: SmaranaSyncState, message?: string) => void;
}) {
  const { store } = dependencies;
  let active: AbortController | null = null;
  let running: Promise<void> | null = null;
  let generation = 0;
  const assertCurrent = (controller: AbortController, expected: number) => {
    if (controller.signal.aborted || generation !== expected || !dependencies.allowed()) throw new Error("Synchronisation suspendue.");
  };
  const abortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    const stopped = () => new Error("La synchronisation reprendra plus tard.");
    if (signal.aborted) {
      void promise.catch(() => {});
      throw stopped();
    }
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(stopped());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([promise, aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  };
  const run = (): Promise<void> => {
    if (running) return running;
    if (!dependencies.allowed()) { dependencies.onState?.("paused"); return Promise.resolve(); }
    const controller = new AbortController();
    active = controller;
    const expected = generation;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    dependencies.onState?.("syncing");
    const task = (async () => {
      try {
        const credentials = await abortable(dependencies.credentials(controller.signal), controller.signal);
        assertCurrent(controller, expected);
        if (credentials.ownerId !== store.ownerId || !credentials.accessToken || !credentials.anonKey) throw new Error("Vérifiez à nouveau le compte avant de synchroniser.");
        const url = new URL(credentials.url);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Configuration de synchronisation invalide.");
        const rpc = async (name: "smarana_apply" | "smarana_pull", body: Record<string, unknown>): Promise<unknown> => {
          assertCurrent(controller, expected);
          const response = await abortable(dependencies.fetch(`${url.origin}/rest/v1/rpc/${name}`, {
            method: "POST", signal: controller.signal, redirect: "error",
            headers: { "Content-Type": "application/json", "Accept": "application/json",
              "Content-Profile": "purama_ai", "Accept-Profile": "purama_ai",
              "apikey": credentials.anonKey, "Authorization": `Bearer ${credentials.accessToken}` },
            body: JSON.stringify({ p_expected_owner_id: store.ownerId, ...body }),
          }), controller.signal);
          assertCurrent(controller, expected);
          if (!response.ok) throw new Error(response.status === 401 || response.status === 403
            ? "Le compte doit être vérifié à nouveau pour synchroniser."
            : "La synchronisation reprendra lorsque le service sera disponible.");
          const data = await abortable(response.json(), controller.signal);
          assertCurrent(controller, expected);
          return data;
        };
        for (let write = 0; write < 20; write++) {
          assertCurrent(controller, expected);
          // Claim only the operation about to be sent, never twenty unrelated
          // snapshots which a subsequent stop would leave frozen but unsent.
          const [mutation] = await store.pending(1);
          if (!mutation) break;
          const result = parseSmaranaApplyResult(await rpc("smarana_apply", { p_mutation: mutation }));
          assertCurrent(controller, expected);
          if (result.ownerId !== store.ownerId || result.mutationId !== mutation.mutationId
            || result.resourceId !== mutation.resourceId || result.baseRevision !== mutation.baseRevision) {
            throw new Error("L’accusé de synchronisation ne correspond pas à l’écriture envoyée.");
          }
          await store.acknowledge(result);
        }
        // Small pages keep response memory bounded while the local model is loaded.
        // A bounded round yields to the app; the next round resumes from the durable cursor.
        let more = false;
        for (let page = 0; page < 10; page++) {
          const cursor = await store.cursor();
          const result = parseSmaranaPullResult(await rpc("smarana_pull", { p_after_cursor: cursor, p_limit: 2 }));
          assertCurrent(controller, expected);
          if (result.ownerId !== store.ownerId) throw new Error("Les données reçues appartiennent à un autre compte.");
          await store.ingestPull(result, cursor);
          more = result.hasMore;
          if (!more) break;
        }
        assertCurrent(controller, expected);
        const conflicts = await store.conflicts();
        const remaining = await store.hasPending();
        assertCurrent(controller, expected);
        dependencies.onState?.(conflicts.length ? "conflict" : remaining || more ? "pending" : "synced");
      } catch (error) {
        if (generation === expected) dependencies.onState?.(dependencies.allowed() ? "pending" : "paused",
          error instanceof Error ? error.message : "La synchronisation reprendra plus tard.");
      } finally {
        clearTimeout(timeout);
        if (active === controller) active = null;
      }
    })();
    running = task;
    void task.finally(() => { if (running === task) running = null; }).catch(() => {});
    return task;
  };
  return { run, stop() { generation++; active?.abort(); dependencies.onState?.("paused"); } };
}
