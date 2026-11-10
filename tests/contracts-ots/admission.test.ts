import { handlers, reset, state, SERVICE, ANON, CONTRACT, OWNER, installNetworkFixture } from "./fixture.ts";

Deno.env.set("SUPABASE_URL", "https://supabase.fixture.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
Deno.env.set("SUPABASE_ANON_KEY", ANON);
Deno.env.set("DOCUSEAL_API_URL", "https://docuseal.fixture.invalid");
Deno.env.set("DOCUSEAL_API_TOKEN", "fixture-docuseal-private-token");
Deno.env.set("DOCUSEAL_WEBHOOK_SECRET", "");
installNetworkFixture();
await import("../../supabase/functions/contracts-ots-stamp/index.ts");
await import("../../supabase/functions/contracts-ots-verify/index.ts");
await import("../../supabase/functions/contracts-webhook/index.ts");
const [stamp, verify, webhook] = handlers;
function equal(actual: unknown, expected: unknown, detail = "") {
  if (actual !== expected) throw new Error(`${detail}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function request(token = "fixture-admin", body: unknown = { contract_id: CONTRACT }) {
  return new Request("https://function.fixture.invalid/stamp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function verifyRequest(token = "fixture-owner") {
  return new Request(`https://function.fixture.invalid/verify?id=${CONTRACT}&upgrade=true`, { headers: { Authorization: `Bearer ${token}` } });
}
const forbiddenEffects = () => { equal(state.requests.length, 0, "network effects"); equal(state.writes.length, 0, "writes"); };

Deno.test("stamp rejects an unverified bearer before any privileged query or egress", async () => {
  reset(); const response = await stamp(request("fixture-invalid")); equal(response.status, 401); forbiddenEffects();
  equal(state.clients.some(x => x.service), false, "service client must not exist for invalid caller");
});
Deno.test("stamp rejects the anonymous API key as a user", async () => {
  reset(); equal((await stamp(request(ANON))).status, 401); forbiddenEffects();
});
Deno.test("stamp rejects a valid unrelated user", async () => {
  reset(); equal((await stamp(request("fixture-foreign"))).status, 403); forbiddenEffects();
});
Deno.test("manual stamping requires administrator authority even for the owner", async () => {
  reset(); equal((await stamp(request("fixture-owner"))).status, 403); forbiddenEffects();
});
Deno.test("verified administrator can stamp a signed contract", async () => {
  reset(); const response = await stamp(request()); equal(response.status, 200); equal(state.writes.filter(x => x.table === "contracts").length, 1);
  equal(state.authCalls > 0, true, "authenticated identity obtained from Auth server");
});
Deno.test("exact internal service credential preserves the signed webhook path", async () => {
  reset(); equal((await stamp(request(SERVICE))).status, 200); equal(state.writes.filter(x => x.table === "contracts").length, 1);
});
Deno.test("a merely service-looking bearer cannot impersonate the internal caller", async () => {
  reset(); equal((await stamp(request(SERVICE + "-suffix"))).status, 401); forbiddenEffects();
});
Deno.test("stamping refuses unsigned contracts before PDF or calendar access", async () => {
  reset(); state.contract.status = "draft"; equal((await stamp(request(SERVICE))).status, 409); forbiddenEffects();
});
Deno.test("stamping rejects a malformed contract identifier before egress", async () => {
  reset(); equal((await stamp(request(SERVICE, { contract_id: { sql: "fixture" } }))).status, 400); forbiddenEffects();
});
Deno.test("DocuSeal lookalike host receives neither PDF fetch nor private token", async () => {
  reset(); state.pdfUrl = "https://docuseal.fixture.invalid.attacker.invalid/signed.pdf";
  equal((await stamp(request(SERVICE))).status, 502);
  equal(state.requests.some(x => x.url === state.pdfUrl), false, "lookalike host must not be fetched"); equal(state.writes.length, 0);
});
Deno.test("DocuSeal PDF HTTP transport refuses automatic redirects", async () => {
  reset(); equal((await stamp(request(SERVICE))).status, 200);
  equal(state.requests.find(x => x.url === state.pdfUrl)?.redirect, "error");
});
Deno.test("DocuSeal metadata for a different submission cannot be stamped", async () => {
  reset(); state.documentMetadata = { id: 999, combined_document_url: state.pdfUrl };
  equal((await stamp(request(SERVICE))).status, 502); equal(state.requests.length, 1); equal(state.writes.length, 0);
});
Deno.test("multiple unmerged documents cannot silently stamp the first document", async () => {
  reset(); state.documentMetadata = { id: 17, documents: [{ url: state.pdfUrl }, { url: state.pdfUrl + "?second" }] };
  equal((await stamp(request(SERVICE))).status, 502); equal(state.requests.length, 1); equal(state.writes.length, 0);
});
Deno.test("a single merged document preserves the documented DocuSeal response shape", async () => {
  reset(); state.documentMetadata = { id: 17, documents: [{ name: "merged.pdf", url: state.pdfUrl }] };
  equal((await stamp(request(SERVICE))).status, 200); equal(state.requests[0].url.endsWith("/documents?merge=true"), true);
});
Deno.test("administrator revocation while PDF is loading prevents stamping", async () => {
  reset(); state.afterPdf = () => { state.administrator = false; };
  equal((await stamp(request())).status, 403); equal(state.stampCalls, 0); equal(state.writes.length, 0);
});
Deno.test("provider failure returns a generic error without reflecting internal detail", async () => {
  reset(); state.pdfFailure = true; const response = await stamp(request(SERVICE));
  equal(response.status >= 500, true); equal((await response.text()).includes("fixture-private"), false); equal(state.writes.length, 0);
});
Deno.test("verify authenticates a user explicitly before interpreting a proof", async () => {
  reset(); equal((await verify(verifyRequest("fixture-invalid"))).status, 401); forbiddenEffects(); equal(state.deserializeCalls, 0);
});
Deno.test("verify retains owner scope and does not disclose another user's proof", async () => {
  reset(); equal((await verify(verifyRequest("fixture-foreign"))).status, 404); forbiddenEffects(); equal(state.deserializeCalls, 0);
});
Deno.test("verify permits an authenticated owner to observe a pending proof", async () => {
  reset(); const response = await verify(verifyRequest()); equal(response.status, 200);
  const body = await response.json(); equal(body.pending, true); equal(body.verified, false); equal(state.writes.length, 0);
});
Deno.test("verify does not persist after ownership changed during verification", async () => {
  reset(); state.bitcoin = { height: 840000, timestamp: 1713571767 };
  state.afterVerify = () => { state.contract.user_id = "55555555-5555-4555-8555-555555555555"; };
  const response = await verify(verifyRequest()); equal(response.status === 404 || response.status === 409, true); equal(state.writes.length, 0);
});
Deno.test("verify rejects a corrupt stored hash before proof or network operations", async () => {
  reset(); state.contract.ots_stamp_hash = "zz".repeat(32);
  equal((await verify(verifyRequest())).status, 409); equal(state.requests.length, 0); equal(state.writes.length, 0);
});
Deno.test("verify bounds stored proof input before deserialization", async () => {
  reset(); state.contract.ots_proof = "A".repeat(1000000);
  equal((await verify(verifyRequest())).status, 409); equal(state.deserializeCalls, 0); forbiddenEffects();
});
Deno.test("verify never reports success when proof persistence fails", async () => {
  reset(); state.bitcoin = { height: 840000, timestamp: 1713571767 }; state.updateFailure = true;
  const response = await verify(verifyRequest()); equal(response.status, 500); equal((await response.text()).includes("fixture-private"), false);
});
Deno.test("verified owner result is persisted only for the original contract snapshot", async () => {
  reset(); state.bitcoin = { height: 840000, timestamp: 1713571767 };
  const response = await verify(verifyRequest()); equal(response.status, 200);
  equal((await response.json()).verified, true); equal(state.contract.user_id, OWNER);
  equal(state.writes.filter(x => x.table === "contracts").length, 1);
});
Deno.test("webhook without a configured secret fails closed before the database", async () => {
  reset(); const response = await webhook(new Request("https://function.fixture.invalid/webhook", { method: "POST", body: JSON.stringify({ event_type: "submission.created", data: { id: 17 } }) }));
  equal(response.status, 503); equal(state.clients.length, 0); forbiddenEffects();
});

Deno.test("unauthenticated webhook rejects a never-ending body before consuming it", async () => {
  reset(); let reads = 0;
  const stream = new ReadableStream<Uint8Array>({ pull() { reads++; } }, { highWaterMark: 0 });
  const request = new Request("https://function.fixture.invalid/webhook", { method: "POST", body: stream });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([webhook(request), new Promise<Response>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Authentication waited for request body")), 500); })]);
    equal(response.status, 503); equal(reads, 0); forbiddenEffects();
  } finally { if (timer !== undefined) clearTimeout(timer); await request.body?.cancel(); }
});
