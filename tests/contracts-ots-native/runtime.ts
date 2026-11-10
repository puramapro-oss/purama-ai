// Explicitly executed by Deno; the filename avoids Playwright test discovery.
import { handlers, reset, state, SERVICE, ANON, CONTRACT, ADMIN, PDF, installNetworkFixture } from "./fixture.ts";
import OpenTimestamps from "./fixture.ts";

Deno.env.set("SUPABASE_URL", "https://supabase.fixture.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
Deno.env.set("SUPABASE_ANON_KEY", ANON);
Deno.env.set("DOCUSEAL_API_URL", "https://docuseal.fixture.invalid");
Deno.env.set("DOCUSEAL_API_TOKEN", "fixture-docuseal-private-token");
Deno.env.set("DOCUSEAL_WEBHOOK_SECRET", "");
installNetworkFixture();
await import("../../supabase/functions/contracts-ots-stamp/index.ts");
await import("../../supabase/functions/contracts-webhook/index.ts");
const [stamp, webhook] = handlers;

function equal(actual: unknown, expected: unknown, detail = "") {
  if (actual !== expected) throw new Error(`${detail}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function request(token = "fixture-admin", body: unknown = { contract_id: CONTRACT }) {
  return new Request("https://function.fixture.invalid/stamp", { method: "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json",
  }, body: JSON.stringify(body) });
}
function noEffects() {
  equal(state.requests.length, 0, "external transport calls");
  equal(state.writes.length, 0, "database writes");
  equal(state.stampCalls, 0, "calendar operations");
}

Deno.test("runtime denies real network and process execution", async () => {
  equal((await Deno.permissions.query({ name: "net" })).state, "denied");
  equal((await Deno.permissions.query({ name: "run" })).state, "denied");
});
for (const [token, status] of [["fixture-invalid",401],[ANON,401],["fixture-owner",403],["fixture-foreign",403],[SERVICE+"-suffix",401]] as const) {
  Deno.test(`native authorization refuses ${token}`, async () => {
    reset(); equal((await stamp(request(token))).status,status); noEffects();
  });
}
Deno.test("native administrator role removal fails closed", async () => {
  reset(); state.administrator=false; equal((await stamp(request())).status,403); noEffects();
});
for (const token of ["fixture-admin", SERVICE]) {
  Deno.test(`native actual OTS library stamps raw PDF bytes and records verified actor: ${token}`, async () => {
    reset(); const response=await stamp(request(token)); equal(response.status,200);
    const result=await response.json();
    const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",PDF));
    const expected=Array.from(hash, b=>b.toString(16).padStart(2,"0")).join("");
    equal(result.hash,expected);
    const encoded=atob(String(state.contract.ots_proof));
    const proof=OpenTimestamps.DetachedTimestampFile.deserialize(Array.from(encoded, c=>c.charCodeAt(0)));
    equal(Array.from(proof.fileDigest() as number[], b=>b.toString(16).padStart(2,"0")).join(""),expected);
    equal(proof.timestamp.allAttestations().size>0,true);
    equal(state.contract.ots_verified_at,null); equal(state.contract.ots_block_height,null);
    const event=state.writes.find(x=>x.table==="contract_events")!;
    equal(event.values.actor_id,token===SERVICE?null:ADMIN);
    equal(event.values.actor_type,token===SERVICE?"service":"user");
  });
}
for (const status of ["draft","sent","opened","declined","cancelled","expired"]) {
  Deno.test(`native stamping refuses ${status} before provider effects`, async()=>{
    reset();state.contract.status=status;equal((await stamp(request(SERVICE))).status,409);noEffects();
  });
}
for (const body of [null,{}, {contract_id:42}, {contract_id:"bad-id"}]) {
  Deno.test(`native malformed identifier ${JSON.stringify(body)} is refused`,async()=>{
    reset();equal((await stamp(request(SERVICE,body))).status,400);noEffects();
  });
}
Deno.test("native authorized stamper enforces its 4 KiB request body limit", async () => {
  reset();
  const req = request(SERVICE, { contract_id: CONTRACT, padding: "x".repeat(4096) });
  equal((await stamp(req)).status, 413);
  equal(req.body?.locked, false);
  noEffects();
});
Deno.test("native authorized stamper respects cancellation before reading its body", async () => {
  reset();
  const abort = new AbortController();
  abort.abort();
  const req = new Request(request(SERVICE), { signal: abort.signal });
  equal((await stamp(req)).status, 408);
  equal(req.body?.locked, false);
  noEffects();
});
for (const url of ["https://docuseal.fixture.invalid/signed.pdf","https://docuseal.fixture.invalid.attacker.invalid/signed.pdf","https://storage.fixture.invalid/signed.pdf"]) {
  Deno.test(`native PDF fetch protects exact token origin and redirects: ${url}`,async()=>{
    reset();state.pdfUrl=url;
    const exactOrigin = new URL(url).origin === "https://docuseal.fixture.invalid";
    equal((await stamp(request(SERVICE))).status, exactOrigin ? 200 : 502);
    if (!exactOrigin) {
      // The reconciled transport rejects foreign PDF origins before any fetch.
      equal(state.requests.some(x => x.url === url), false);
      equal(state.stampCalls, 0); equal(state.writes.length, 0);
      return;
    }
    const fetched=state.requests.find(x=>x.url===url)!;
    equal(fetched.redirect,"error");
    equal(fetched.token,"fixture-docuseal-private-token");
  });
}
for (const url of ["http://storage.fixture.invalid/signed.pdf","https://user@storage.fixture.invalid/signed.pdf","data:application/pdf;base64,AA=="]) {
  Deno.test(`native PDF rejects unsafe URL ${url}`,async()=>{
    reset();state.pdfUrl=url;equal((await stamp(request(SERVICE))).status,502);
    equal(state.requests.some(x=>x.url===url),false);equal(state.stampCalls,0);equal(state.writes.length,0);
  });
}
for (const field of ["status","docuseal_submission_id"]) {
  Deno.test(`native proof compare-and-set protects changed ${field}`,async()=>{
    reset();const original=state.contract.ots_proof;
    state.afterPdf=()=>{state.contract[field]=field==="status"?"cancelled":99;};
    equal((await stamp(request(SERVICE))).status,409);equal(state.contract.ots_proof,original);equal(state.writes.length,0);
  });
}
Deno.test("native real library soft failure cannot persist an unattested proof",async()=>{
  reset();state.allCalendarsFail=true;equal((await stamp(request(SERVICE))).status,502);
  equal(state.stampCalls,1);equal(state.writes.length,0);
});
for (const failure of ["pdfFailure","updateFailure","eventsFailure"] as const) {
  Deno.test(`native failure ${failure} is not reported as success`,async()=>{
    reset();state[failure]=true;const response=await stamp(request(SERVICE));equal(response.status,failure === "pdfFailure" ? 502 : 500);
    equal((await response.text()).includes("fixture-private"),false);
  });
}
Deno.test("native missing webhook secret rejects a never-ending body without reading it",async()=>{
  reset();let reads=0;const stream=new ReadableStream<Uint8Array>({pull(){reads++;}},{highWaterMark:0});
  const req=new Request("https://function.fixture.invalid/webhook",{method:"POST",body:stream});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const response=await Promise.race([webhook(req),new Promise<Response>((_resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error("Webhook waited for unauthenticated body")),500);
    })]);
    equal(response.status,503);equal(reads,0);equal(state.clients.length,0);noEffects();
  } finally {if(timer!==undefined)clearTimeout(timer);await req.body?.cancel();}
});
