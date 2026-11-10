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

interface BodySource {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  signal: AbortSignal;
}

interface ByteLimits {
  maxBytes: number;
  /** Absolute monotonic deadline, shared with any preceding transport phases. */
  deadline: number;
  /** False when fetch decoded an entity whose Content-Length describes encoded bytes. */
  matchContentLength?: boolean;
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

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const text: string[] = [];
  return await consumeBoundedBody(request, { maxBytes, deadline: performance.now() + timeoutMs }, {
    write: bytes => { text.push(decoder.decode(bytes, { stream: true })); },
    finish: () => { text.push(decoder.decode()); return text.join(""); },
  });
}

/** Binary adapter over the same deadline, byte accounting and cancellation path. */
export async function readBoundedBytes(source: BodySource, limits: ByteLimits): Promise<Uint8Array<ArrayBuffer>> {
  let buffer = new Uint8Array(0);
  let size = 0;
  return await consumeBoundedBody(source, limits, {
    write: bytes => {
      const required = size + bytes.byteLength;
      if (required > buffer.byteLength) {
        // No object per fragment: geometric allocation stays within the byte cap.
        const capacity = Math.min(limits.maxBytes, Math.max(required, buffer.byteLength * 2, 1024));
        const grown = new Uint8Array(capacity);
        grown.set(buffer.subarray(0, size));
        buffer = grown;
      }
      // Snapshot before the next read: a producer may reuse its backing buffer.
      buffer.set(bytes, size);
      size = required;
    },
    finish: () => buffer.subarray(0, size),
  });
}

async function consumeBoundedBody<T>(
  request: BodySource,
  limits: ByteLimits,
  output: { write: (bytes: Uint8Array) => void; finish: () => T },
): Promise<T> {
  const { maxBytes, deadline } = limits;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isFinite(deadline)) {
    throw new RangeError("Invalid body limits");
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interruption: RequestBodyError | undefined;
  let rejectStopped: (error: RequestBodyError) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  // A pre-aborted request or early header refusal can precede the sole race.
  void stopped.catch(() => {});
  const stop = (error: RequestBodyError) => {
    if (interruption) return;
    interruption = error;
    rejectStopped(error);
  };
  const abort = () => stop(new RequestBodyError(408, "Request body interrupted"));
  const checkCurrent = () => {
    if (interruption) throw interruption;
    if (request.signal.aborted) throw new RequestBodyError(408, "Request body interrupted");
    if (performance.now() >= deadline) throw new RequestBodyError(408, "Request body deadline exceeded");
  };

  try {
    checkCurrent();
    const length = request.headers.get("content-length");
    let declared: number | undefined;
    if (length !== null) {
      if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) {
        throw new RequestBodyError(400, "Invalid Content-Length");
      }
      declared = Number(length);
      if (limits.matchContentLength !== false && declared > maxBytes) {
        throw new RequestBodyError(413, "Request body too large");
      }
    }
    if (!request.body) {
      if (limits.matchContentLength !== false && declared !== undefined && declared !== 0) {
        throw new RequestBodyError(400, "Incomplete request body");
      }
      checkCurrent();
      const result = output.finish();
      checkCurrent();
      return result;
    }

    const bodyReader = request.body.getReader();
    reader = bodyReader;
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    timer = setTimeout(
      () => stop(new RequestBodyError(408, "Request body deadline exceeded")),
      Math.max(0, deadline - performance.now()),
    );
    let size = 0;
    let emptyChunks = 0;

    const consume = async (): Promise<T> => {
      while (true) {
        checkCurrent();
        const part = await bodyReader.read();
        // A timed-out read may still resolve after cancellation was requested.
        // The recorded interruption must win before any accounting/output.
        checkCurrent();
        if (part.done) {
          if (limits.matchContentLength !== false && declared !== undefined && declared !== size) {
            throw new RequestBodyError(400, "Incomplete request body");
          }
          checkCurrent();
          const result = output.finish();
          checkCurrent();
          return result;
        }
        if (!(part.value instanceof Uint8Array)) throw new RequestBodyError(400, "Invalid request body chunk");
        size += part.value.byteLength;
        if (size > maxBytes) throw new RequestBodyError(413, "Request body too large");
        if (limits.matchContentLength !== false && declared !== undefined && size > declared) {
          throw new RequestBodyError(400, "Content-Length mismatch");
        }
        if (part.value.byteLength === 0 && ++emptyChunks > 64) {
          throw new RequestBodyError(400, "Invalid empty request stream");
        }
        output.write(part.value);
      }
    };
    // One subscription for the entire stream, not one retained Promise reaction
    // per chunk. This also bounds a pending read that ignores cancellation.
    const result = await Promise.race([consume(), stopped]);
    // Interruption can win during the completed reader's asynchronous handoff.
    checkCurrent();
    return result;
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
