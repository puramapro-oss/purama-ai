import { readOtsBody, OtsHttpError } from "../../supabase/functions/_shared/ots-body.ts";

// The short deadline is an internal test parameter, never caller-controlled HTTP input.
const read = readOtsBody as (req: Request, maxBytes: number, timeoutMs: number) => Promise<Record<string, unknown>>;
function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
}
async function rejected(operation: Promise<unknown>, status: number) {
  let timer: ReturnType<typeof setTimeout> | undefined; let failure: unknown;
  try {
    await Promise.race([operation, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Body reader did not settle within the test guard")), 500);
    })]);
  } catch (error) { failure = error; }
  finally { if (timer !== undefined) clearTimeout(timer); }
  equal(failure instanceof OtsHttpError, true); equal((failure as OtsHttpError).status, status);
}

Deno.test("bounded body reader times out an authenticated stream that never closes", async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  const request = new Request("https://fixture.invalid/body", { method: "POST", body: stream });
  await rejected(read(request, 4096, 20), 408);
  equal(cancelled, 1); equal(request.body?.locked, false);
});

Deno.test("oversized body settles even if cancellation never resolves or rejects", async () => {
  for (const cancellation of ["pending", "rejected"]) {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(5)); },
      cancel() { cancelled++; return cancellation === "pending" ? new Promise<void>(() => undefined) : Promise.reject(new Error("Synthetic cancellation failure")); },
    });
    const request = new Request("https://fixture.invalid/body", { method: "POST", body: stream });
    await rejected(read(request, 4, 100), 413);
    equal(cancelled, 1); equal(request.body?.locked, false);
  }
});

Deno.test("body reader honors abort before and during reading and releases its lock", async () => {
  for (const timing of ["before", "during"]) {
    const abort = new AbortController(); let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
    const request = new Request("https://fixture.invalid/body", { method: "POST", body: stream, signal: abort.signal });
    if (timing === "before") abort.abort();
    const operation = read(request, 4096, 100);
    if (timing === "during") queueMicrotask(() => abort.abort());
    await rejected(operation, 408);
    equal(cancelled, 1); equal(request.body?.locked, false);
  }
});
