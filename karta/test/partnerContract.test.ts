import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as pdfLib from "pdf-lib";
import { PGlite } from "@electric-sql/pglite";

const url = new URL("../../supabase/functions/partner-generate-contract/handler.ts",import.meta.url).href;
const {createPartnerContractHandler,readPartnerContractReceipt} = await import(/* @vite-ignore */ url);
const user = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const prospect = "00000000-0000-4000-8000-000000000011";
const otherProspect = "00000000-0000-4000-8000-000000000012";
type Row = Record<string,unknown>;
let db: PGlite;
const read = (path:string) => readFileSync(new URL(path,import.meta.url),"utf8");

// Execute the actual PDF source against pdf-lib 1.17.1, without a Deno/network import.
const module = {exports:{} as { renderContractPdf: (...args: unknown[]) => Promise<{bytes:Uint8Array;signatureArea:Row}> }};
new Function("require","module","exports",ts.transpileModule(read("../../supabase/functions/partner-generate-contract/pdf.ts"),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText)((name:string)=>{
  if(name !== "https://esm.sh/pdf-lib@1.17.1") throw new Error(`Unexpected PDF dependency ${name}`);
  return pdfLib;
},module,module.exports);
const renderPdf = module.exports.renderContractPdf;

beforeAll(async()=>{
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    INSERT INTO auth.users(id) VALUES ('${user}'),('${other}');
    CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await db.exec(read("../../supabase/migrations/20260406230000_partner_agent.sql"));
  await db.exec(`CREATE TYPE purama_ai.app_role AS ENUM ('admin');
    CREATE FUNCTION purama_ai.has_role(uuid,purama_ai.app_role) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;`);
  await db.exec(read("../../supabase/migrations/20261110030000_partner_outreach_reservations.sql"));
  await db.exec(read("../../supabase/migrations/20260423110000_docuseal_contracts.sql"));
  await db.exec(read("../../supabase/migrations/20261123003000_partner_contract_dispatches.sql"));
});
afterAll(async()=>{ await db?.close(); });
beforeEach(async()=>{
  await db.exec("RESET ROLE; TRUNCATE purama_ai.partner_contract_dispatches, purama_ai.contracts, purama_ai.partner_agent_config, purama_ai.partner_prospects, purama_ai.partner_outreach_suppressions CASCADE");
  await db.query(`INSERT INTO purama_ai.partner_agent_config(user_id,is_active,sender_name,sender_email,company_name,commission_first_payment,commission_recurring,require_approval_contract)
    VALUES ($1,true,'Test Sender','sender@example.invalid','Fiction',9,3,true),($2,true,'Other Sender','other@example.invalid','Fiction',9,3,true)`,[user,other]);
  await db.query(`INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status,has_replied)
    VALUES ($1,$2,'Test Recipient','recipient@example.invalid','interested',true),($3,$4,'Other','other@example.invalid','interested',true)`,[prospect,user,otherProspect,other]);
});
const signatures: Record<string,string[]> = {
  partner_contract_result:["p_user_id","p_prospect_id"],
  partner_contract_reserve:["p_user_id","p_prospect_id","p_claim_token"],
  partner_contract_save:["p_user_id","p_prospect_id","p_claim_token","p_approval_version","p_pdf_sha256","p_storage_path","p_signature_area"],
  partner_contract_claim:["p_user_id","p_prospect_id","p_claim_token","p_approval_version","p_pdf_sha256"],
  partner_contract_begin_submission:["p_user_id","p_prospect_id","p_claim_token"],
  partner_contract_finish:["p_user_id","p_prospect_id","p_claim_token","p_outcome","p_submission_id","p_submitter_id","p_template_id","p_signing_url"],
};
async function rpc(name:string,args:Row):Promise<{data:Row|null;error:unknown}> {
  const keys=signatures[name];
  if(!keys) throw new Error(`Unexpected RPC ${name}`);
  try {
    const result = await db.query<{value:Row}>(`SELECT purama_ai.${name}(${keys.map((_,i)=>`$${i+1}`).join(",")}) AS value`,keys.map(k=>args[k] ?? null));
    return {data:result.rows[0].value,error:null};
  } catch(error) {return {data:null,error};}
}
const request=(body:Row={action:"prepare",prospect_id:prospect},token="valid") => new Request("https://example.invalid/contract",{
  method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body),
});
const approve=(result:Row,overrides:Row={})=>request({action:"approve",prospect_id:prospect,
  approval_version:(result.approval as Row).version,pdf_sha256:(result.approval as Row).pdf_sha256,...overrides});
const defaultReceipt=[{id:17,submission_id:42,email:"recipient@example.invalid",embed_src:"https://sign.example.invalid/s/test"}];
type Options = {
  receipt?:unknown; uploadFails?:boolean; previewFails?:boolean; actor?:string;
  templateHook?:()=>Promise<void>; beforeClaim?:()=>Promise<void>; providerThrows?:boolean;
  finishFailure?:"before"|"after"; tamperPdf?:boolean; providerHangs?:boolean; providerTimeoutMs?:number; authHangs?:boolean;
};
function harness(options:Options={}) {
  const calls:{url:string;method:string;body:unknown;headers:Headers}[]=[];
  const pdfs=new Map<string,Uint8Array>();
  let drafts=0;
  const handler = createPartnerContractHandler({
    authenticate:async(token:string)=>options.authHangs ? await new Promise<string>(()=>{}) : token==="valid" ? options.actor ?? user : null,
    rpc:async(name:string,args:Row)=>{
      if(name==="partner_contract_claim") await options.beforeClaim?.();
      if(name==="partner_contract_finish" && args.p_outcome==="sent" && options.finishFailure){
        if(options.finishFailure==="after") await rpc(name,args);
        return {data:null,error:new Error("Lost commit acknowledgement")};
      }
      return rpc(name,args);
    },
    fetch:async(input:string|URL|Request,init?:RequestInit)=>{
      const url=String(input); const method=init?.method ?? "GET";
      let body:unknown=init?.body;
      if(typeof body === "string") body=JSON.parse(body);
      calls.push({url,method,body,headers:new Headers(init?.headers)});
      if(url === "https://api.anthropic.com/v1/messages"){
        drafts++; return Response.json({stop_reason:"end_turn",content:[{text:"Article 1 : projet fictif.\n\nArticle 2 : données de test."}]});
      }
      if(url===`https://storage.example.invalid/storage/v1/object/authenticated/partner-signatures/${user}/signature.png`){
        return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7uoAAAAASUVORK5CYII=","base64"));
      }
      if(url.startsWith("https://storage.example.invalid/storage/v1/object/partner-contracts/") && method==="POST"){
        if(options.uploadFails)return new Response("Unavailable",{status:503});
        const path=url.split("/partner-contracts/")[1];
        if(pdfs.has(path))return new Response("Exists",{status:409});
        pdfs.set(path,new Uint8Array(init?.body as Uint8Array));
        return Response.json({Key:path});
      }
      if(url.startsWith("https://storage.example.invalid/storage/v1/object/sign/partner-contracts/")){
        if(options.previewFails)return new Response("Unavailable",{status:503});
        return Response.json({signedURL:`/object/sign/partner-contracts/${url.split("/partner-contracts/")[1]}?token=fixture`});
      }
      if(url.startsWith("https://storage.example.invalid/storage/v1/object/authenticated/partner-contracts/")){
        const stored=pdfs.get(url.split("/partner-contracts/")[1]);
        if(!stored)return new Response("Missing",{status:404});
        return new Response(options.tamperPdf ? new Uint8Array([1,2,3]) : new Uint8Array(stored));
      }
      if(url==="https://docuseal.example.invalid/api/templates/pdf"){
        await options.templateHook?.(); return Response.json({id:90});
      }
      if(url==="https://docuseal.example.invalid/api/submissions"){
        if(options.providerThrows)throw new Error("Timeout after possible provider acceptance");
        if(options.providerHangs)return await new Promise<Response>(()=>{});
        return Response.json(options.receipt === undefined ? defaultReceipt : options.receipt);
      }
      throw new Error(`Unexpected external URL ${url}`);
    },
    renderPdf,supabaseUrl:"https://storage.example.invalid",serviceKey:"fake-service",
    anthropicApiKey:"fake-llm",docusealUrl:"https://docuseal.example.invalid",docusealKey:"fake-docuseal",
    providerTimeoutMs:options.providerTimeoutMs,
  });
  const run=async(req=request()):Promise<Row>=>{
    const response=await handler(req); const result=await response.json();
    return {...result,http_status:response.status};
  };
  return {run,calls,pdfs,drafts:()=>drafts,sends:()=>calls.filter(c=>c.url.endsWith("/api/submissions")),
    templates:()=>calls.filter(c=>c.url.endsWith("/api/templates/pdf"))};
}

it("rejects missing authentication and the legacy ambiguous command before providers/storage",async()=>{
  const h=harness();
  expect(await h.run(request({},"bad"))).toMatchObject({http_status:401});
  expect(await h.run(request({prospect_id:prospect}))).toMatchObject({http_status:409,reason:"approval_required"});
  expect(h.calls).toEqual([]);
  expect((await db.query("SELECT * FROM purama_ai.contracts")).rows).toHaveLength(0);
});
it("prepares a real immutable PDF and hub signer without sending or approving",async()=>{
  const h=harness(); const result=await h.run();
  expect(result).toMatchObject({status:"pending_approval",http_status:200,reused:false});
  expect(result.approval).toMatchObject({recipient_email:"recipient@example.invalid",commission_first_payment:9,commission_recurring:3,
    pdf_sha256:expect.stringMatching(/^[0-9a-f]{64}$/),pdf_url:expect.stringContaining("https://storage.example.invalid/")});
  expect(h.sends()).toHaveLength(0); expect(h.templates()).toHaveLength(0);
  expect((await db.query("SELECT app_slug,status,docuseal_submission_id FROM purama_ai.contracts")).rows).toEqual([{app_slug:"purama_ai",status:"draft",docuseal_submission_id:null}]);
  expect((await db.query("SELECT status,approved_at FROM purama_ai.partner_contract_dispatches")).rows).toEqual([{status:"pending_approval",approved_at:null}]);
  expect(h.calls.find(c=>c.method==="POST" && c.url.includes("/object/partner-contracts/"))?.headers.get("x-upsert")).toBe("false");
  const repeated=await h.run(); expect(repeated.approval).toEqual(result.approval); expect(h.drafts()).toBe(1);
});
it("uses the approved bytes and records real submission and signer identities exactly once",async()=>{
  const h=harness(); const pending=await h.run();
  const result=await h.run(approve(pending));
  expect(result).toMatchObject({status:"sent",docuseal_submission_id:42,signing_url:"https://sign.example.invalid/s/test"});
  expect(h.drafts()).toBe(1); expect(h.sends()).toHaveLength(1);
  expect((h.templates()[0].body as {documents:{file:string}[]}).documents[0].file).toBe(Buffer.from([...h.pdfs.values()][0]).toString("base64"));
  expect((await db.query("SELECT docuseal_submission_id FROM purama_ai.contracts")).rows).toEqual([{docuseal_submission_id:42}]);
  expect((await db.query("SELECT docuseal_submitter_id FROM purama_ai.contract_signers")).rows).toEqual([{docuseal_submitter_id:17}]);
  expect(await h.run(approve(pending))).toMatchObject({status:"sent",reused:true});
  expect(await h.run()).toMatchObject({status:"sent",reused:true});
  expect(h.sends()).toHaveLength(1);
});
it("serializes simultaneous approvals with a single durable dispatch claim",async()=>{
  const h=harness(); const pending=await h.run();
  const results=await Promise.all(Array.from({length:12},()=>h.run(approve(pending))));
  expect(results.some(r=>r.status==="sent")).toBe(true);
  expect(h.sends()).toHaveLength(1); expect(h.templates()).toHaveLength(1);
});
it.each(["approval_version","pdf_sha256"])("rejects a changed %s without altering the valid pending approval",async(field)=>{
  const h=harness(); const pending=await h.run();
  expect(await h.run(approve(pending,{[field]:field==="approval_version" ? other : "a".repeat(64)}))).toMatchObject({status:"blocked",reason:"stale_approval"});
  expect(h.sends()).toHaveLength(0);
  expect((await h.run()).status).toBe("pending_approval");
});
it("refuses another user even with the exact IDs, document hash and forged user_id",async()=>{
  const owner=harness(); const pending=await owner.run();
  const attacker=harness({actor:other});
  expect(await attacker.run(approve(pending,{user_id:user}))).toMatchObject({status:"blocked",reason:"contract_not_prepared"});
  expect(attacker.calls).toHaveLength(0);
});
it("never authorizes a pending document by disabling the configuration approval flag",async()=>{
  const h=harness(); await h.run();
  await db.query("UPDATE purama_ai.partner_agent_config SET require_approval_contract=false WHERE user_id=$1",[user]);
  expect(await h.run()).toMatchObject({status:"pending_approval"}); expect(h.sends()).toHaveLength(0);
});
it.each(["recipient","terms","opposition"])("rechecks changed %s at approval admission",async(change)=>{
  const h=harness({beforeClaim:async()=>{
    if(change==="recipient")await db.query("UPDATE purama_ai.partner_prospects SET email='changed@example.invalid' WHERE id=$1",[prospect]);
    else if(change==="terms")await db.query("UPDATE purama_ai.partner_agent_config SET commission_recurring=4 WHERE user_id=$1",[user]);
    else await db.query("UPDATE purama_ai.partner_prospects SET status='rejected' WHERE id=$1",[prospect]);
  }});
  const pending=await h.run(); expect(await h.run(approve(pending))).toMatchObject({status:"blocked"}); expect(h.sends()).toHaveLength(0);
});
it("rechecks opposition after provider template creation, before actual submission",async()=>{
  const h=harness({templateHook:async()=>{await db.query("UPDATE purama_ai.partner_prospects SET status='rejected' WHERE id=$1",[prospect]);}});
  const pending=await h.run(); expect(await h.run(approve(pending))).toMatchObject({status:"blocked",reason:"contact_suppressed"});
  expect(h.templates()).toHaveLength(1); expect(h.sends()).toHaveLength(0);
});
it("does not send when an immutable storage object changed after preview",async()=>{
  const h=harness({tamperPdf:true}); const pending=await h.run();
  expect(await h.run(approve(pending))).toMatchObject({status:"blocked",reason:"document_changed"}); expect(h.templates()).toHaveLength(0);
});
it("stops at failed PDF upload before creating any signature request",async()=>{
  const h=harness({uploadFails:true}); expect(await h.run()).toMatchObject({http_status:503,reason:"preparation_failed"});
  expect(h.templates()).toHaveLength(0); expect(h.sends()).toHaveLength(0);
  expect((await db.query("SELECT status FROM purama_ai.partner_contract_dispatches")).rows).toEqual([{status:"failed"}]);
});
it("does not offer approval when signed preview URL creation fails",async()=>{
  const h=harness({previewFails:true}); expect(await h.run()).toMatchObject({status:"blocked",reason:"preview_unavailable"});
  expect(h.sends()).toHaveLength(0); expect(h.templates()).toHaveLength(0);
});
it.each([{receipt:[]},{receipt:[{id:17,email:"recipient@example.invalid"}]},{receipt:[{id:17,submission_id:42,email:"wrong@example.invalid"}]},
  {receipt:[{id:17,submission_id:42,email:"recipient@example.invalid"},{id:18,submission_id:42,email:"extra@example.invalid"}]}])("retains unknown and never resends on an invalid receipt %#",async({receipt})=>{
  const h=harness({receipt}); const pending=await h.run();
  expect(await h.run(approve(pending))).toMatchObject({status:"unknown",http_status:202,reason:"reconciliation_required"});
  expect(await h.run()).toMatchObject({status:"unknown"}); expect(h.sends()).toHaveLength(1);
  expect((await db.query("SELECT status FROM purama_ai.contracts")).rows).toEqual([{status:"draft"}]);
});
it.each(["before","after"] as const)("never retries when receipt persistence acknowledgement is lost %s commit",async(finishFailure)=>{
  const h=harness({finishFailure}); const pending=await h.run();
  expect(await h.run(approve(pending))).toMatchObject({status:"unknown"});
  const later=await h.run(); expect(later.status).toBe(finishFailure==="after" ? "sent" : "unknown");
  expect(h.sends()).toHaveLength(1);
});
it("bounds a provider that ignores cancellation and keeps its uncertain dispatch reserved",async()=>{
  const h=harness({providerHangs:true,providerTimeoutMs:60}); const pending=await h.run();
  expect(pending.status).toBe("pending_approval");
  const started=performance.now(); expect(await h.run(approve(pending))).toMatchObject({status:"unknown"});
  expect(performance.now()-started).toBeLessThan(2000); expect(h.sends()).toHaveLength(1);
  expect(await h.run(approve(pending))).toMatchObject({status:"unknown"}); expect(h.sends()).toHaveLength(1);
});
it("does not resend historical contract_sent prospects without dispatch proof",async()=>{
  await db.query("UPDATE purama_ai.partner_prospects SET status='contract_sent',contract_sent_at=now() WHERE id=$1",[prospect]);
  const h=harness(); expect(await h.run()).toMatchObject({status:"blocked",reason:"previous_attempt_requires_review"}); expect(h.calls).toHaveLength(0);
});
it("preserves the recipient send history after deleting and reimporting the prospect",async()=>{
  const h=harness(); const pending=await h.run(); await h.run(approve(pending));
  await db.query("DELETE FROM purama_ai.partner_prospects WHERE id=$1",[prospect]);
  const replacement="00000000-0000-4000-8000-000000000099";
  await db.query("INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status) VALUES($1,$2,'Again','recipient@example.invalid','interested')",[replacement,user]);
  expect(await h.run(request({action:"prepare",prospect_id:replacement}))).toMatchObject({status:"blocked",reason:"previous_attempt_requires_review"});
  expect(h.sends()).toHaveLength(1);
});
it("projects the verified hub signature into the existing partner pipeline idempotently",async()=>{
  const h=harness(); const pending=await h.run(); await h.run(approve(pending));
  await db.query("UPDATE purama_ai.contracts SET status='signed',signed_at='2026-11-23T00:00:00Z' WHERE id=$1",[pending.contract_id]);
  await db.query("UPDATE purama_ai.contracts SET status='signed',signed_at='2026-11-24T00:00:00Z' WHERE id=$1",[pending.contract_id]);
  const result=await db.query("SELECT status,contract_signed_at FROM purama_ai.partner_prospects WHERE id=$1",[prospect]);
  expect(result.rows[0]).toEqual({status:"contract_signed",contract_signed_at:new Date("2026-11-23T00:00:00Z")});
});
it("keeps dispatch state and every admission RPC inaccessible to client roles",async()=>{
  const result=await db.query<{name:string;anon:boolean;authenticated:boolean}>(`SELECT p.proname AS name,
    has_function_privilege('anon',p.oid,'EXECUTE') AS anon,has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='purama_ai' AND p.proname LIKE 'partner_contract_%'`);
  expect(result.rows.length).toBe(8); expect(result.rows.every(r=>!r.anon && !r.authenticated)).toBe(true);
  await db.exec("SET ROLE authenticated");
  await expect(db.query("SELECT * FROM purama_ai.partner_contract_dispatches")).rejects.toThrow();
});
it("places the DocuSeal field on the actual last page of a multi-page PDF",async()=>{
  const result=await renderPdf("Projet fictif","Article fictif. ".repeat(1600),{
    senderName:"Test Sender",senderTitle:"Test",partnerName:"Test Recipient",signatureImageBytes:null,
  });
  const pdf=await pdfLib.PDFDocument.load(result.bytes);
  expect(pdf.getPageCount()).toBeGreaterThan(1); expect(result.signatureArea.page).toBe(pdf.getPageCount());
  expect(Number(result.signatureArea.x)+Number(result.signatureArea.w)).toBeLessThanOrEqual(595);
  expect(Number(result.signatureArea.y)+Number(result.signatureArea.h)).toBeLessThanOrEqual(842);
});
it("reads submission_id independently from submitter id and rejects malformed identities",()=>{
  expect(readPartnerContractReceipt(defaultReceipt,"recipient@example.invalid")).toMatchObject({submissionId:42,submitterId:17});
  expect(()=>readPartnerContractReceipt([{...defaultReceipt[0],submission_id:Number.MAX_SAFE_INTEGER+1}],"recipient@example.invalid")).toThrow();
});

it.each(["sign","public"])("loads the owned signature using service auth despite an expired %s URL",async(kind)=>{
  await db.query("UPDATE purama_ai.partner_agent_config SET signature_image_url=$1 WHERE user_id=$2",[
    `https://storage.example.invalid/storage/v1/object/${kind}/partner-signatures/${user}/signature.png?token=expired-secret`,user,
  ]);
  const h=harness(); expect(await h.run()).toMatchObject({status:"pending_approval"});
  const call=h.calls.find(c=>c.url.includes("/partner-signatures/"));
  expect(call?.url).not.toContain("expired-secret"); expect(call?.headers.get("authorization")).toBe("Bearer fake-service");
  expect(JSON.stringify(h.calls.find(c=>c.url==="https://api.anthropic.com/v1/messages")?.body)).not.toContain("expired-secret");
});
it.each(["https://127.0.0.1/private.png",`https://storage.example.invalid/storage/v1/object/sign/partner-signatures/${other}/signature.png`])(
  "refuses arbitrary or another account signature URL %#",async(signature)=>{
    await db.query("UPDATE purama_ai.partner_agent_config SET signature_image_url=$1 WHERE user_id=$2",[signature,user]);
    const h=harness(); expect(await h.run()).toMatchObject({http_status:503,reason:"preparation_failed"});
    expect(h.calls.some(c=>c.url===signature)).toBe(false); expect(h.sends()).toHaveLength(0);
  });

it("rejects non-string actions before database/provider effects",async()=>{
  const h=harness(); expect(await h.run(request({action:["prepare"],prospect_id:prospect}))).toMatchObject({http_status:400});
  expect(h.calls).toHaveLength(0);
});
it("read-only preview exposes an expired sending lease as unknown without retrying",async()=>{
  const h=harness(); const pending=await h.run(); const proof=pending.approval as Row;
  const claim=await rpc("partner_contract_claim",{p_user_id:user,p_prospect_id:prospect,p_claim_token:other,
    p_approval_version:proof.version,p_pdf_sha256:proof.pdf_sha256}); expect(claim.error).toBeNull();
  await db.query("UPDATE purama_ai.partner_contract_dispatches SET lease_until=now()-interval '1 second'");
  expect(await h.run(request({action:"preview",prospect_id:prospect}))).toMatchObject({status:"unknown",reason:"reconciliation_required"});
  expect(h.sends()).toHaveLength(0); expect(h.templates()).toHaveLength(0);
});
it("expired approval prepares a fresh immutable version and keeps the old PDF/audit",async()=>{
  const h=harness(); const first=await h.run();
  await db.query("UPDATE purama_ai.partner_contract_dispatches SET lease_until=now()-interval '1 second'");
  expect(await h.run(request({action:"preview",prospect_id:prospect}))).toMatchObject({status:"blocked",reason:"approval_expired"});
  const next=await h.run(); expect(next.status).toBe("pending_approval");
  expect((next.approval as Row).version).not.toBe((first.approval as Row).version); expect(h.pdfs.size).toBe(2);
  expect(await h.run(approve(first))).toMatchObject({status:"blocked",reason:"stale_approval"}); expect(h.sends()).toHaveLength(0);
});

it("refuses a name wider than its PDF signature column before approval or provider creation",async()=>{
  await db.query("UPDATE purama_ai.partner_prospects SET name=$1 WHERE id=$2",["W".repeat(150),prospect]);
  const h=harness(); expect(await h.run()).toMatchObject({http_status:503,reason:"preparation_failed"});
  expect(h.templates()).toHaveLength(0); expect(h.sends()).toHaveLength(0);
  expect((await db.query("SELECT status FROM purama_ai.partner_contract_dispatches")).rows).toEqual([{status:"failed"}]);
});
it("rejects an unbreakable PDF word instead of clipping it beyond the page",async()=>{
  await expect(renderPdf("Projet fictif","W".repeat(400),{
    senderName:"Test",senderTitle:"Test",partnerName:"Test",signatureImageBytes:null,
  })).rejects.toThrow("contract_word_too_wide");
});
it("bounds a stalled authentication adapter before database and provider effects",async()=>{
  const h=harness({authHangs:true,providerTimeoutMs:30}); const started=performance.now();
  expect(await h.run()).toMatchObject({http_status:401}); expect(performance.now()-started).toBeLessThan(1000);
  expect(h.calls).toHaveLength(0); expect((await db.query("SELECT id FROM purama_ai.contracts")).rows).toHaveLength(0);
});
