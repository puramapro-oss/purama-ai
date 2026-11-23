/** A native refresh lifecycle. Creating it never constructs or reads an SDK client. */
export interface AuthRefreshPort {
  initialize?(): Promise<unknown>;
  startAutoRefresh(): Promise<void>;
  stopAutoRefresh(): Promise<void>;
}

export function createAuthRefreshManager() {
  let generation = 0;
  let desired: AuthRefreshPort | null = null;
  let current: AuthRefreshPort | null = null;
  let tail = Promise.resolve();

  const stop = async (port: AuthRefreshPort) => {
    try { await port.stopAutoRefresh(); } catch { /* No background retry or new client. */ }
  };
  const enqueue = (operation: () => Promise<void>) => {
    const pending = tail.then(operation, operation);
    tail = pending.catch(() => {});
    return pending;
  };

  return {
    activate(port: AuthRefreshPort): Promise<void> {
      desired = port;
      const requested = ++generation;
      return enqueue(async () => {
        if (requested !== generation || desired !== port) return;
        if (current === port) return;
        if (current) {
          await stop(current);
          current = null;
        }
        if (requested !== generation || desired !== port) return;
        current = port;
        try {
          // The SDK's first tick otherwise waits for initialization and could
          // resume after its timer was already cleared on a passive route.
          await port.initialize?.();
          if (requested !== generation || desired !== port) {
            await stop(port);
            if (current === port) current = null;
            return;
          }
          await port.startAutoRefresh();
        } catch {
          await stop(port);
          if (current === port) current = null;
          return;
        }
        // The SDK can create its ticker after an awaited internal stop. A pause
        // during that await must stop it again once the old start has drained.
        if (requested !== generation || desired !== port) {
          await stop(port);
          if (current === port) current = null;
        }
      });
    },
    pause(): Promise<void> {
      desired = null;
      generation += 1;
      const port = current;
      // Clear an existing ticker now, even if a start is still awaiting the SDK.
      // Capturing only an already supplied port keeps passive routes SDK-free.
      const immediate = port ? stop(port) : Promise.resolve();
      return enqueue(async () => {
        await immediate;
        if (port) {
          await stop(port);
          if (current === port) current = null;
        }
      });
    },
  };
}

// Shared across provider effect replays/remounts so an old stop cannot outlive a
// newer start. This singleton is passive until activate receives an existing port.
export const authRefresh = createAuthRefreshManager();
