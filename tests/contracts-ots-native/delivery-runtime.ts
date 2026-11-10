import { handlers, reset, state, SERVICE, installNetworkFixture } from "./fixture.ts";
import { deliverOtsStamp, StampDeliveryError } from "../../supabase/functions/_shared/ots-delivery.ts";
Deno.env.set("SUPABASE_URL", "https://supabase.fixture.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
Deno.env.set("DOCUSEAL_API_URL", "https://docuseal.fixture.invalid");
Deno.env.set("DOCUSEAL_API_TOKEN", "fixture-docuseal-token");
Deno.env.set("DOCUSEAL_WEBHOOK_SECRET", "fixture-webhook-secret");
installNetworkFixture();
await import("../../supabase/functions/contracts-ots-stamp/index.ts");
await import("../../supabase/functions/contracts-webhook/index.ts");
const [stamp, webhook] = handlers;
function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function request(signal?: AbortSignal) {
  return new Request("https://function.fixture.invalid/webhook", {
    method: "POST", signal, headers: { Authorization: "Bearer fixture-webhook-secret" },
    body: JSON.stringify({ event_type: "form.completed", data: { id: 17, submission_id: 17 } }),
  });
}

Deno.test("native webhook refuses real proof-write failure and retries the already-signed contract", async () => {
  reset(); state.contract.status = "sent"; state.signers = [{ signed: true }];
  state.proofUpdateFailure = true; state.internalHandler = stamp;
  const previousProof = state.contract.ots_proof;
  equal((await webhook(request())).status, 502);
  equal(state.contract.status, "signed"); equal(state.contract.ots_proof, previousProof);
  equal(state.writes.filter(write => write.values.event_type === "ots_stamped").length, 0);
  state.proofUpdateFailure = false;
  equal((await webhook(request())).status, 200);
  equal(state.contract.ots_proof === previousProof, false);
  equal(state.writes.filter(write => write.values.event_type === "ots_stamped").length, 1);
  equal(state.writes.filter(write => write.values.event_type === "signed").length, 2);
});

Deno.test("native delivery deadline bounds a transport that ignores abort", async () => {
  const previous = globalThis.fetch; let signal: AbortSignal | null | undefined;
  globalThis.fetch = (_input, init) => { signal = init?.signal; return new Promise<Response>(() => {}); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let failure: unknown;
    try {
      await Promise.race([deliverOtsStamp("https://fixture.invalid", SERVICE, "fixture", { timeoutMs: 20 }),
        new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("Delivery test guard")), 500); })]);
    } catch (error) { failure = error; }
    equal(failure instanceof StampDeliveryError, true); equal((failure as StampDeliveryError).status, 504);
    equal(signal?.aborted, true);
  } finally { globalThis.fetch = previous; if (timer !== undefined) clearTimeout(timer); }
});

Deno.test("native webhook interruption is retryable even when internal transport ignores abort", async () => {
  reset(); state.contract.status = "sent"; state.signers = [{ signed: true }];
  const abort = new AbortController();
  state.internalHandler = () => {
    queueMicrotask(() => abort.abort());
    return new Promise<Response>(() => {});
  };
  equal((await webhook(request(abort.signal))).status, 503);
  equal(state.contract.status, "signed");
});

Deno.test("native malformed HMAC is refused before any body acquisition", async () => {
  reset(); let reads = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { reads++; } }, { highWaterMark: 0 });
  const req = new Request("https://function.fixture.invalid/webhook", {
    method: "POST", headers: { "x-docuseal-signature": "sha256=malformed" }, body,
  });
  equal((await webhook(req)).status, 401); equal(reads, 0); equal(req.bodyUsed, false);
  equal(state.clients.length, 0); equal(state.requests.length, 0);
  await req.body?.cancel();
});
