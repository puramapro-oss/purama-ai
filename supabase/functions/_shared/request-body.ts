/** Bounded UTF-8 input for the contract HTTP entry points. */
export class RequestBodyError extends Error {
  readonly status: 400 | 408 | 413;

  constructor(status: 400 | 408 | 413, message: string) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}

interface BodyLimits {
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * The deadline covers the whole stream, including an unresolved read. Check
 * the monotonic clock between reads too: immediate chunks must not starve it.
 * Failed input is cancelled best-effort; a broken cancel promise cannot delay
 * the HTTP error. The exact decoded text (including a BOM) is retained for HMAC.
 */
export async function readRequestText(request: Request, limits: BodyLimits = {}): Promise<string> {
  const maxBytes = limits.maxBytes ?? 256 * 1024;
  const timeoutMs = limits.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Invalid request body limits");
  }

  const deadline = performance.now() + timeoutMs;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStopped: (error: RequestBodyError) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  // A pre-aborted request or early header refusal can precede the first race.
  void stopped.catch(() => {});
  const abort = () => rejectStopped(new RequestBodyError(408, "Request body interrupted"));

  try {
    if (request.signal.aborted) throw new RequestBodyError(408, "Request body interrupted");
    const length = request.headers.get("content-length");
    let declared: number | undefined;
    if (length !== null) {
      if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) {
        throw new RequestBodyError(400, "Invalid Content-Length");
      }
      declared = Number(length);
      if (declared > maxBytes) throw new RequestBodyError(413, "Request body too large");
    }
    if (!request.body) {
      if (declared !== undefined && declared !== 0) throw new RequestBodyError(400, "Incomplete request body");
      return "";
    }

    reader = request.body.getReader();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    timer = setTimeout(
      () => rejectStopped(new RequestBodyError(408, "Request body deadline exceeded")),
      Math.max(0, deadline - performance.now()),
    );
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const text: string[] = [];
    let size = 0;
    let emptyChunks = 0;

    while (true) {
      if (request.signal.aborted) throw new RequestBodyError(408, "Request body interrupted");
      if (performance.now() >= deadline) throw new RequestBodyError(408, "Request body deadline exceeded");
      const part = await Promise.race([reader.read(), stopped]);
      if (request.signal.aborted) throw new RequestBodyError(408, "Request body interrupted");
      if (performance.now() >= deadline) throw new RequestBodyError(408, "Request body deadline exceeded");
      if (part.done) {
        if (declared !== undefined && declared !== size) throw new RequestBodyError(400, "Incomplete request body");
        text.push(decoder.decode());
        return text.join("");
      }
      if (!(part.value instanceof Uint8Array)) throw new RequestBodyError(400, "Invalid request body chunk");
      size += part.value.byteLength;
      if (size > maxBytes) throw new RequestBodyError(413, "Request body too large");
      if (declared !== undefined && size > declared) throw new RequestBodyError(400, "Content-Length mismatch");
      if (part.value.byteLength === 0 && ++emptyChunks > 64) {
        throw new RequestBodyError(400, "Invalid empty request stream");
      }
      text.push(decoder.decode(part.value, { stream: true }));
    }
  } catch (error) {
    try {
      const cancelled = reader ? reader.cancel() : request.body?.cancel();
      void Promise.resolve(cancelled).catch(() => {});
    } catch { /* A hostile stream cannot prevent the bounded response. */ }
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400, "Invalid request body");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    try { reader?.releaseLock(); } catch { /* A pending read is already observed by the race. */ }
  }
}
