/** A failed delivery must be visible to the webhook sender as a retryable error. */
export class StampDeliveryError extends Error {
  readonly status: 502 | 503 | 504;

  constructor(status: 502 | 503 | 504) {
    super(status === 504 ? "Timestamp service deadline exceeded" : "Timestamp service unavailable");
    this.name = "StampDeliveryError";
    this.status = status;
  }
}

interface DeliveryLimits {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function cancelResponse(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* Best effort only. */ }
}

/**
 * Wait for the stamper's HTTP result, with a total monotonic 15 s deadline.
 * Race cancellation as well as signalling it: a transport may ignore abort.
 * Acknowledgement is not a transaction with earlier contract/audit writes.
 */
export async function deliverOtsStamp(
  supabaseUrl: string,
  serviceRoleKey: string,
  contractId: string,
  limits: DeliveryLimits = {},
): Promise<void> {
  const timeoutMs = limits.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Invalid timestamp delivery deadline");
  }
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  let failure: StampDeliveryError | undefined;
  let rejectStopped: (error: StampDeliveryError) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  void stopped.catch(() => {});
  const stop = (status: 503 | 504) => {
    if (failure) return;
    failure = new StampDeliveryError(status);
    rejectStopped(failure);
    controller.abort();
  };
  const onAbort = () => stop(503);

  try {
    limits.signal?.addEventListener("abort", onAbort, { once: true });
    if (limits.signal?.aborted) onAbort();
    if (failure) throw failure;
    timer = setTimeout(() => stop(504), Math.max(0, deadline - performance.now()));
    const pending = fetch(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/contracts-ots-stamp`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contract_id: contractId }),
      signal: controller.signal,
      // The service credential must never follow a redirect to another host.
      redirect: "error",
    });
    void pending.then(late => { if (failure) cancelResponse(late); }, () => {});
    response = await Promise.race([pending, stopped]);
    if (limits.signal?.aborted) onAbort();
    if (performance.now() >= deadline) stop(504);
    if (failure) throw failure;
    if (!response.ok) throw new StampDeliveryError(502);
  } catch (error) {
    controller.abort();
    throw error instanceof StampDeliveryError ? error : new StampDeliveryError(502);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    limits.signal?.removeEventListener("abort", onAbort);
    if (response) cancelResponse(response);
  }
}
