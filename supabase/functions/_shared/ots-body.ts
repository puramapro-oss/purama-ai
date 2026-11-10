// Mechanical extraction from a3dbad12756387bb7c01606818e6ee42b85b4d5b.
// Keep body transport independent from the authorization policy of its donor.
export class OtsHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export async function readOtsBody(req: Request, maxBytes = 4096, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const reader = req.body?.getReader();
  if (!reader) throw new OtsHttpError(400, "Invalid JSON");
  let interruption: OtsHttpError | undefined;
  let rejectInterrupted!: (error: OtsHttpError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  // A pre-aborted request can fail before the first read/race is attached.
  void interrupted.catch(() => undefined);
  const cancelReader = () => {
    // A producer may never settle cancellation, or may reject it. Neither may
    // delay the response or produce an unhandled rejection.
    try { void reader.cancel().catch(() => undefined); } catch { /* already released */ }
  };
  const interrupt = (message: string) => {
    if (interruption) return;
    interruption = new OtsHttpError(408, message);
    rejectInterrupted(interruption); cancelReader();
  };
  const onAbort = () => interrupt("Request aborted");
  const timer = setTimeout(() => interrupt("Request body timeout"), timeoutMs);
  req.signal.addEventListener("abort", onAbort, { once: true });
  let text = ""; let length = 0; const decoder = new TextDecoder();
  try {
    if (req.signal.aborted) onAbort();
    for (;;) {
      if (interruption) throw interruption;
      const { value, done } = await Promise.race([reader.read(), interrupted]);
      if (interruption) throw interruption;
      if (done) break;
      length += value.length;
      if (length > maxBytes) { cancelReader(); throw new OtsHttpError(413, "Request too large"); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid shape");
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OtsHttpError) throw error;
    throw new OtsHttpError(400, "Invalid JSON");
  } finally {
    clearTimeout(timer); req.signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* preserve the original read error */ }
  }
}
