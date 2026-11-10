import { handlers, reset, state, SERVICE, CONTRACT, installNetworkFixture } from "./fixture.ts";
Deno.env.set("SUPABASE_URL", "https://supabase.fixture.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
Deno.env.set("DOCUSEAL_API_URL", "https://docuseal.fixture.invalid");
Deno.env.set("DOCUSEAL_API_TOKEN", "fixture-docuseal-token");
Deno.env.set("DOCUSEAL_WEBHOOK_SECRET", "fixture-webhook-secret");
installNetworkFixture();
await import("../../supabase/functions/contracts-webhook/index.ts");
const webhook = handlers[0];
await import("../../supabase/functions/contracts-ots-stamp/index.ts");
const stamp = handlers[1];
function equal(actual: unknown, expected: unknown) { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`); }
function request(secret = "fixture-webhook-secret", event = "submission.created") {
  return new Request("https://function.fixture.invalid/webhook", { method: "POST", headers: { Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ event_type: event, data: { id: 17, submission_id: 17 } }) });
}
Deno.test("configured webhook rejects an incorrect secret before database access", async () => {
  reset(); equal((await webhook(request("fixture-wrong-secret"))).status, 401); equal(state.clients.length, 0); equal(state.requests.length, 0);
});
Deno.test("configured webhook preserves an authenticated DocuSeal event", async () => {
  reset(); const response = await webhook(request()); equal(response.status, 200); equal((await response.json()).contract_id, CONTRACT);
});
Deno.test("partial completion never marks the whole contract signed or triggers OTS", async () => {
  reset(); state.contract.status = "sent"; state.signers = [{ signed: true }, { signed: false }];
  equal((await webhook(request(undefined, "form.completed"))).status, 200); equal(state.contract.status, "sent");
  equal(state.requests.some(x => x.url.endsWith("/contracts-ots-stamp")), false);
});
Deno.test("an absent or empty signer set never counts as total completion", async () => {
  for (const signers of [null, []]) {
    reset(); state.contract.status = "sent"; Object.assign(state, { signers });
    equal((await webhook(request(undefined, "form.completed"))).status, 409); equal(state.contract.status, "sent");
    equal(state.requests.some(x => x.url.endsWith("/contracts-ots-stamp")), false);
  }
});
Deno.test("total signer completion triggers stamping with the exact service credential", async () => {
  reset(); state.contract.status = "sent"; state.signers = [{ signed: true }, { signed: true }];
  equal((await webhook(request(undefined, "form.completed"))).status, 200); equal(state.contract.status, "signed");
  const trigger = state.requests.find(x => x.url.endsWith("/contracts-ots-stamp"));
  equal(trigger?.authorization, `Bearer ${SERVICE}`); equal(JSON.parse(trigger?.body ?? "{}").contract_id, CONTRACT);
});
Deno.test("webhook rejects null, missing data and malformed event envelopes before database access", async () => {
  for (const payload of [null, [], { event_type: "form.completed" }, { event_type: "form.completed", data: null }, { event_type: 12, data: {} }]) {
    reset();
    const response = await webhook(new Request("https://function.fixture.invalid/webhook", { method: "POST",
      headers: { Authorization: "Bearer fixture-webhook-secret" }, body: JSON.stringify(payload) }));
    equal(response.status, 400); equal(state.clients.length, 0); equal(state.requests.length, 0);
  }
});
Deno.test("webhook accepts only positive safe integer submission and submitter identifiers", async () => {
  for (const data of [{ id: 17 }, { id: 17, submission_id: 0 }, { id: 17, submission_id: -1 },
    { id: 17, submission_id: 1.5 }, { id: 17, submission_id: Number.MAX_SAFE_INTEGER + 1 },
    { id: -17, submission_id: 17 }, { id: "17", submission_id: 17 }]) {
    reset();
    const response = await webhook(new Request("https://function.fixture.invalid/webhook", { method: "POST",
      headers: { Authorization: "Bearer fixture-webhook-secret" }, body: JSON.stringify({ event_type: "form.completed", data }) }));
    equal(response.status, 400); equal(state.clients.length, 0); equal(state.requests.length, 0);
  }
});
Deno.test("webhook cancels a body exceeding64KiB without Content-Length or database access", async () => {
  reset(); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(40_000)); controller.enqueue(new Uint8Array(30_000)); },
    cancel() { cancelled = true; },
  });
  const request = new Request("https://function.fixture.invalid/webhook", { method: "POST",
    headers: { Authorization: "Bearer fixture-webhook-secret" }, body: stream });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([webhook(request), new Promise<Response>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Webhook waited past the body size bound")), 500);
    })]);
    equal(response.status, 413); equal(cancelled, true); equal(state.clients.length, 0); equal(state.requests.length, 0);
  } finally { if (timer !== undefined) clearTimeout(timer); await request.body?.cancel().catch(() => undefined); }
});

Deno.test("authenticated signer completion reaches the actual stamp handler with service authority", async () => {
  reset(); state.contract.status = "sent"; state.signers = [{ signed: true }, { signed: true }];
  let stamping: Promise<Response> | undefined;
  state.internalStamp = async request => {
    const response = await stamp(request);
    // The awaited delivery now releases its response body. Observe a clone
    // before that legitimate consumption, preserving every assertion below.
    stamping = Promise.resolve(response.clone());
    return response;
  };
  equal((await webhook(request(undefined, "form.completed"))).status, 200);
  if (!stamping) throw new Error("Completion did not invoke the production stamp handler");
  const response = await stamping;
  equal(response.status, 200); equal((await response.json()).pending_bitcoin_confirmation, true);
  equal(state.contract.status, "signed"); equal(state.stampCalls > 0, true); equal(state.authCalls, 0);
  equal(state.requests.filter(x => x.url.endsWith("/contracts-ots-stamp")).length, 1);
  const event = state.writes.find(x => x.table === "contract_events" && x.values.event_type === "ots_stamped");
  equal(event?.values.actor_id, null); equal(event?.values.actor_type, "service");
});
