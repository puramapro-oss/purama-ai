import { otsAdminClient, OtsHttpError } from "./ots-auth.ts";

export interface OtsContract {
  id: string; user_id: string; status: string; docuseal_submission_id: number | null;
  ots_stamp_hash: string | null; ots_proof: string | null; ots_verified_at: string | null;
  ots_block_height: number | null; ots_btc_timestamp: string | null;
}
const FIELDS = "id,user_id,status,docuseal_submission_id,ots_stamp_hash,ots_proof,ots_verified_at,ots_block_height,ots_btc_timestamp";
const SNAPSHOT_FIELDS = ["id", "user_id", "status", "docuseal_submission_id", "ots_stamp_hash", "ots_proof"] as const;
export async function loadOtsContract(client: ReturnType<typeof otsAdminClient>, id: string): Promise<OtsContract> {
  const { data, error } = await client.from("contracts").select(FIELDS).eq("id", id).maybeSingle();
  if (error) throw new OtsHttpError(503, "Contract access unavailable");
  if (!data) throw new OtsHttpError(404, "Contract not found or unauthorized");
  return data as OtsContract;
}
export function requireUnchangedContract(expected: OtsContract, actual: OtsContract): void {
  if (SNAPSHOT_FIELDS.some(key => expected[key] !== actual[key])) throw new OtsHttpError(409, "Contract changed; retry verification");
}
export function conditionOnSnapshot<T extends { eq(column: string, value: unknown): T; is(column: string, value: null): T }>(query: T, contract: OtsContract): T {
  let result = query;
  for (const key of SNAPSHOT_FIELDS) result = contract[key] === null ? result.is(key, null) : result.eq(key, contract[key]);
  return result;
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
