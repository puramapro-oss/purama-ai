/** A hard total deadline even when an HTTP adapter ignores AbortSignal. */
export class RequestDeadlineError extends Error {
  constructor() { super("Request deadline exceeded"); this.name = "RequestDeadlineError"; }
}

export function cancelResponseQuietly(value: { cancel(): Promise<unknown> } | null | undefined): void {
  try { void value?.cancel().catch(() => {}); } catch { /* Cleanup must not hold a result hostage. */ }
}

export function createRequestDeadline(timeoutMs: number) {
  const now = () => globalThis.performance?.now() ?? Date.now();
  const endsAt = now() + timeoutMs;
  const controller = new AbortController();
  const error = new RequestDeadlineError();
  let expired = false; let closed = false;
  let rejectTimeout!: (error: RequestDeadlineError) => void;
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  // A deadline can expire between operations, with no race currently attached.
  void timeout.catch(() => {});
  const expire = () => {
    if (expired || closed) return;
    expired = true; controller.abort(); rejectTimeout(error);
  };
  const timer = setTimeout(expire, timeoutMs);
  function check(): void {
    if (expired || now() >= endsAt) { expire(); throw error; }
  }
  async function wait<T>(operation: () => Promise<T>): Promise<T> {
    check();
    const value = await Promise.race([operation(), timeout]);
    // Covers immediate promises/empty chunks that starve the timer task queue.
    check(); return value;
  }
  async function fetchWithin(input: URL, init: RequestInit): Promise<Response> {
    return wait(() => {
      const pending = fetch(input, { ...init, signal: controller.signal });
      void pending.then(response => {
        if (expired || closed || now() >= endsAt) cancelResponseQuietly(response.body);
      }, () => {});
      return pending;
    });
  }
  function close(): void {
    closed = true; clearTimeout(timer); controller.abort();
  }
  return { check, wait, fetch: fetchWithin, close };
}
