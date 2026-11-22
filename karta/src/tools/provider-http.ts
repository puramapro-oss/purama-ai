/** One owner closes a deadline; nested steps borrow it without extending it. */
export interface ProviderDeadline {
  readonly signal: AbortSignal;
  active(): boolean;
  check(): void;
  wait<T>(operation: () => PromiseLike<T>): Promise<T>;
  close(): void;
}

/** A monotone budget also bounds transports that ignore AbortSignal. */
export function createProviderDeadline(timeoutMs: number, message: string): ProviderDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("Délai fournisseur invalide");
  }
  const controller = new AbortController();
  const endsAt = performance.now() + timeoutMs;
  const error = new Error(message);
  let failure: Error | undefined;
  let closed = false;
  let rejectDeadline!: (reason: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  void stopped.catch(() => {});
  const expire = () => {
    if (closed || failure) return;
    failure = error;
    controller.abort();
    rejectDeadline(error);
  };
  const timer = setTimeout(expire, timeoutMs);
  const check = () => {
    if (performance.now() >= endsAt) expire();
    if (failure) throw failure;
    if (closed) throw new Error("Opération fournisseur terminée");
  };
  return {
    signal: controller.signal,
    active: () => !closed && !failure && performance.now() < endsAt,
    check,
    async wait<T>(operation: () => PromiseLike<T>): Promise<T> {
      check();
      const result = await Promise.race([operation(), stopped]);
      check();
      return result;
    },
    close: () => { closed = true; clearTimeout(timer); controller.abort(); },
  };
}

function cancelProviderBody(body: { cancel(): Promise<unknown> } | null | undefined): void {
  // Cleanup is best effort. A broken/non-cooperative cancel must not hold a worker.
  try { void body?.cancel().catch(() => {}); } catch { /* No provider data escapes. */ }
}

/**
 * No retries, redirects or raw provider errors. The caller must validate the
 * business receipt and distinguish an unconfirmed effect from a proven failure.
 * A deadline covers headers, every body read and parsing, without being reset.
 */
export async function requestProviderJson(
  url: string, init: RequestInit, deadline: ProviderDeadline, maxBytes: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Limite de réponse fournisseur invalide");
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await deadline.wait(async () => {
      response = await fetch(url, { ...init, redirect: "error", credentials: "omit", signal: deadline.signal });
      // Promise.race may already have returned. Do not leave a late body open.
      if (!deadline.active()) cancelProviderBody(response.body);
      return response;
    });
    deadline.check();
    if (!response?.ok || response.redirected || !response.body) throw new Error("Réponse fournisseur indisponible");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let emptyChunks = 0;
    let reads = 0;
    for (;;) {
      const part = await deadline.wait(() => reader!.read());
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || ++reads > 8192) throw new Error("Flux fournisseur invalide");
      if (part.value.byteLength === 0 && ++emptyChunks > 64) throw new Error("Flux fournisseur invalide");
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error("Réponse fournisseur trop volumineuse");
      chunks.push(part.value.slice());
    }
    const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    deadline.check();
    return result;
  } catch {
    deadline.check();
    throw new Error("Réponse fournisseur invalide ou indisponible");
  } finally {
    if (reader) {
      cancelProviderBody(reader);
      try { reader.releaseLock(); } catch { /* A timed-out read may still be pending. */ }
    } else cancelProviderBody(response?.body);
  }
}
