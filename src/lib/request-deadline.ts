/** A hard total deadline even when an HTTP adapter ignores AbortSignal. */
export class RequestDeadlineError extends Error {
  constructor() { super("Request deadline exceeded"); this.name = "RequestDeadlineError"; }
}

export function cancelResponseQuietly(value: { cancel(): Promise<unknown> } | null | undefined): void {
  try { void value?.cancel().catch(() => {}); } catch { /* Cleanup must not hold a result hostage. */ }
}

export function createRequestDeadline(timeoutMs: number, signal?: AbortSignal) {
  const now = () => globalThis.performance?.now() ?? Date.now();
  const endsAt = now() + timeoutMs;
  const controller = new AbortController();
  const error = new RequestDeadlineError();
  const cancellation = new Error("Request cancelled");
  cancellation.name = "AbortError";
  let failure: Error | undefined; let closed = false;
  // Keep only current operations subscribed. A shared Promise.race timeout
  // would retain one reaction for every completed chunk until the deadline.
  const pending = new Set<(reason: unknown) => void>();
  const interrupt = (reason: Error) => {
    if (failure) return;
    failure = reason; controller.abort();
    for (const reject of pending) reject(reason);
    pending.clear();
  };
  const expire = () => { if (!closed) interrupt(error); };
  const abort = () => interrupt(cancellation);
  const timer = setTimeout(expire, timeoutMs);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  function check(): void {
    if (signal?.aborted) abort();
    if (!failure && now() >= endsAt) expire();
    if (failure) throw failure;
    if (closed) throw cancellation;
  }
  async function wait<T>(operation: () => Promise<T>): Promise<T> {
    check();
    const value = await new Promise<T>((resolve, reject) => {
      const stop = (reason: unknown) => { pending.delete(stop); reject(reason); };
      pending.add(stop);
      try {
        void Promise.resolve(operation()).then(result => { pending.delete(stop); resolve(result); }, stop);
      } catch (reason) { stop(reason); }
    });
    // Covers immediate promises/empty chunks that starve the timer task queue.
    check(); return value;
  }
  async function fetchWithin(input: URL, init: RequestInit): Promise<Response> {
    return wait(() => {
      const pending = fetch(input, { ...init, signal: controller.signal });
      void pending.then(response => {
        if (failure || closed || now() >= endsAt) cancelResponseQuietly(response.body);
      }, () => {});
      return pending;
    });
  }
  function close(): void {
    closed = true; clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    interrupt(cancellation);
  }
  return { check, wait, fetch: fetchWithin, close };
}
