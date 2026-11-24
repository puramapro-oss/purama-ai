import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const handlerUrl=new URL("../../supabase/functions/partner-sync-replies/handler.ts",import.meta.url).href;
const {createPartnerReplyHandler}=await import(/* @vite-ignore */ handlerUrl);
const securityUrl=new URL("../../supabase/functions/_shared/webhook-security.ts",import.meta.url).href;
const {verifyBearerSecret}=await import(/* @vite-ignore */ securityUrl);
const migration=(name:string)=>readFileSync(new URL("../../supabase/migrations/"+name,import.meta.url),"utf8");
const user="00000000-0000-4000-8000-000000000001",other="00000000-0000-4000-8000-000000000002";
const prospect="00000000-0000-4000-8000-000000000011",action="00000000-0000-4000-8000-000000000021",emailId="00000000-0000-4000-8000-000000000031";
const provider="00000000-0000-4000-8000-000000000041",connection="2026-11-24T00:00:00.000Z";
const parentRfc="<transport-message@mail.example.invalid>";
type Row=Record<string,any>;
let db:PGlite,sentAt:string,receivedAt:number;

beforeAll(async()=>{
  db=new PGlite();
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;");
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)",[user,other]);
  await db.exec(migration("20260406230000_partner_agent.sql"));
  await db.exec(migration("20261110030000_partner_outreach_reservations.sql"));
  await db.exec(migration("20261123020000_partner_outreach_schedule.sql"));
  await db.exec("CREATE TABLE purama_ai.email_agent_config(user_id uuid PRIMARY KEY REFERENCES auth.users(id),is_active boolean,gmail_email text,gmail_access_token text,gmail_refresh_token text,gmail_token_expiry timestamptz,updated_at timestamptz)");
  await db.exec(migration("20261124050000_partner_discovery_evidence.sql"));
  await db.exec(migration("20261124050100_partner_media_policy.sql"));
  await db.exec(migration("20261124050200_partner_reply_evidence.sql"));
});
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
  sentAt=new Date(Date.now()-120_000).toISOString();receivedAt=Date.now()-30_000;
  await db.exec("RESET ROLE; TRUNCATE purama_ai.partner_agent_config,purama_ai.partner_prospects,purama_ai.partner_outreach_dispatches,purama_ai.partner_outreach_suppressions,purama_ai.partner_reply_receipts,purama_ai.email_agent_config CASCADE");
  await db.query("INSERT INTO purama_ai.partner_agent_config(user_id,is_active,sender_name,sender_email) VALUES($1,true,'Sender','sender@example.invalid'),($2,true,'Other','other@example.invalid')",[user,other]);
  await db.query("INSERT INTO purama_ai.email_agent_config(user_id,is_active,gmail_email,updated_at) VALUES($1,true,'sender@example.invalid',$3),($2,true,'other@example.invalid',$3)",[user,other,connection]);
  await db.query("INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status,has_replied,first_contact_at,next_action_at) VALUES($1,$2,'Contact','recipient@example.invalid','contacted',false,$3,now()+interval '1 day')",[prospect,user,sentAt]);
  await db.query("INSERT INTO purama_ai.partner_emails(id,user_id,prospect_id,type,subject,body_html,status,sent_at,resend_message_id) VALUES($1,$2,$3,'outreach','Test','<p>Test</p>','sent',$4,$5)",[emailId,user,prospect,sentAt,provider]);
  await db.query("INSERT INTO purama_ai.partner_outreach_dispatches(id,user_id,prospect_id,step,status,claim_token,recipient,email_id,payload,provider_message_id,dispatch_started_at) VALUES($1,$2,$3,'outreach','sent',$1,'recipient@example.invalid',$4,$5,$6,$7)",[
    action,user,prospect,emailId,JSON.stringify({from:"Sender <sender@example.invalid>",to:"recipient@example.invalid",subject:"Test",reply_to:"sender@example.invalid",html:"<p>Test</p>"}),provider,sentAt]);
});
const keys:Record<string,string[]>={
  partner_reply_candidates:["p_user_id","p_limit"],
  partner_reply_bind_outbound:["p_user_id","p_action_id","p_provider_message_id","p_rfc_message_id","p_provider_event","p_connection_email","p_connection_updated_at"],
  partner_reply_record:["p_user_id","p_action_id","p_gmail_message_id","p_gmail_thread_id","p_rfc_message_id","p_sender_email","p_received_at","p_parent_message_id","p_kind","p_connection_email","p_connection_updated_at"],
  partner_reply_checkpoint:["p_user_id","p_action_id","p_expected_page_token","p_next_page_token","p_connection_email","p_connection_updated_at"],
};
async function rpc(name:string,args:Row) {
  if(!keys[name])throw new Error("Unexpected RPC "+name);
  try{
    const result=await db.query<{value:Row}>("SELECT purama_ai."+name+"("+keys[name].map((_,i)=>"$"+(i+1)).join(",")+") AS value",keys[name].map(k=>args[k]??null));
    return {data:result.rows[0].value,error:null};
  }catch(e){return {data:null,error:{message:String(e)}};}
}
async function mustRpc(name:string,args:Row):Promise<Row>{
  const result=await rpc(name,args);if(result.error||!result.data)throw new Error(result.error?.message??"Missing RPC");return result.data;
}
const common=()=>({p_user_id:user,p_action_id:action,p_connection_email:"sender@example.invalid",p_connection_updated_at:connection});
const bind=(overrides:Row={})=>mustRpc("partner_reply_bind_outbound",{...common(),p_provider_message_id:provider,p_rfc_message_id:parentRfc,p_provider_event:"delivered",...overrides});
const record=(overrides:Row={})=>mustRpc("partner_reply_record",{...common(),p_gmail_message_id:"inbound1",p_gmail_thread_id:"thread1",p_rfc_message_id:"<reply1@recipient.example.invalid>",p_sender_email:"recipient@example.invalid",p_received_at:new Date(receivedAt).toISOString(),p_parent_message_id:parentRfc,p_kind:"human",...overrides});
const state=async()=>({prospect:(await db.query<Row>("SELECT * FROM purama_ai.partner_prospects WHERE id=$1",[prospect])).rows[0],
  config:(await db.query<Row>("SELECT * FROM purama_ai.partner_agent_config WHERE user_id=$1",[user])).rows[0],
  receipts:(await db.query<Row>("SELECT * FROM purama_ai.partner_reply_receipts")).rows,
  suppressions:(await db.query<Row>("SELECT * FROM purama_ai.partner_outreach_suppressions")).rows});
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function message(id="inbound1",options:Row={}):Row{
  const headers=[
    {name:"From",value:options.from??"Contact <recipient@example.invalid>"},
    {name:"Message-ID",value:"<"+id+"@recipient.example.invalid>"},
    {name:"In-Reply-To",value:options.parent??parentRfc},
    {name:"References",value:options.references??parentRfc},
    ...(options.auto?[{name:"Auto-Submitted",value:options.auto}]:[]),
  ];
  return {id,threadId:options.thread??"thread1",internalDate:String(options.receivedAt??receivedAt),
    labelIds:options.labels??["INBOX"],payload:{mimeType:"text/plain",headers,
      body:{data:Buffer.from(options.text??"Bonjour, pouvez-vous préciser les conditions ?","utf8").toString("base64url")}}};
}
function request(body:Row={},auth="Bearer user-token",delegated?:string){
  return new Request("https://example.invalid/sync",{method:"POST",headers:{Authorization:auth,"Content-Type":"application/json",
    ...(delegated!==undefined?{"X-Impersonate-User-Id":delegated}:{})},body:JSON.stringify(body)});
}
function harness(options:Row={}){
  const calls:{url:string;method:string;redirect?:RequestInit["redirect"]}[]=[];
  const h=createPartnerReplyHandler({
    authenticate:async(token:string)=>token==="user-token"?user:null,
    authenticateScheduled:(token:string)=>verifyBearerSecret("Bearer "+token,"scheduler-secret"),
    prepareAccess:async()=>({accessToken:"test-access",gmailEmail:options.accessEmail??"sender@example.invalid",connectionUpdatedAt:connection}),
    rpc:async(name:string,args:Row)=>{
      if(name==="partner_reply_record")await options.beforeRecord?.();
      const result=await rpc(name,args);
      if(name==="partner_reply_record"&&options.loseReceipt&&result.data?.status==="recorded")return {data:null,error:{message:"Lost acknowledgement"}};
      return result;
    },
    fetch:async(input:string|URL|Request,init?:RequestInit)=>{
      const url=String(input);calls.push({url,method:init?.method??"GET",redirect:init?.redirect});
      await options.beforeFetch?.(url);
      if((init?.method??"GET")!=="GET")throw new Error("No provider writes allowed");
      if(url.endsWith("/profile"))return response({emailAddress:options.profileEmail??"sender@example.invalid"});
      if(url==="https://api.resend.com/emails/"+provider&&options.providerError)return response({},options.providerError);
      if(url==="https://api.resend.com/emails/"+provider)return response({
        id:provider,message_id:parentRfc,to:["recipient@example.invalid"],from:"Sender <sender@example.invalid>",
        subject:"Test",reply_to:["sender@example.invalid"],last_event:options.event??"delivered",...options.sent});
      if(url.includes("/messages?")){
        if(options.pageError)return response({},options.pageError);
        return response(options.page??{messages:(options.messages??[message()]).map((m:Row)=>({id:m.id}))});
      }
      if(url.includes("/messages/")){
        const parsed=new URL(url),id=decodeURIComponent(parsed.pathname.split("/").at(-1)!);
        const found=(options.messages??[message()]).find((m:Row)=>m.id===id);
        if(!found)throw new Error("Unexpected message");
        if(parsed.searchParams.get("format")==="metadata"){
          const copy=structuredClone(found);delete copy.payload.body;return response(copy);
        }
        return response(found);
      }
      throw new Error("Unexpected URL "+url);
    },
    resendApiKey:"test-proof-key",
  });
  return {handler:h,calls};
}

async function addOlderCandidates(count:number,options:Row={}) {
  const actions:string[]=[];
  for(let index=0;index<count;index++) {
    const id="00000000-0000-4000-8000-"+String(100+index).padStart(12,"0");
    const dispatch="00000000-0000-4000-8000-"+String(200+index).padStart(12,"0");
    const recipient="old-"+index+"@example.invalid";
    await db.query("INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status,has_replied,first_contact_at) VALUES($1,$2,'Older',$3,'contacted',false,$4)",[id,user,recipient,sentAt]);
    await db.query("INSERT INTO purama_ai.partner_outreach_dispatches(id,user_id,prospect_id,step,status,claim_token,recipient,payload,provider_message_id,dispatch_started_at,created_at,reply_scan_page_token) VALUES($1,$2,$3,'outreach','sent',$1,$4,$5,$6,$7,$7,'still-pending')",[
      dispatch,user,id,recipient,JSON.stringify({from:"Sender <sender@example.invalid>",to:recipient,subject:"Older",reply_to:options.replyTo??"sender@example.invalid",html:"<p>Older</p>"}),
      options.invalid?"invalid provider id":"unresolvable-"+index,sentAt]);
    actions.push(dispatch);
  }
  return actions;
}

describe("verified incoming partner replies",()=>{
  it("records the real reply, pauses follow-up and retains Gmail proof",async()=>{
    const h=harness();const result=await (await h.handler(request())).json();
    expect(result).toMatchObject({status:"completed",scanned:1,recorded:[{status:"recorded",kind:"human",gmail_thread_id:"thread1"}]});
    const s=await state();expect(s.prospect).toMatchObject({has_replied:true,next_action_at:null,status:"contacted",reply_gmail_message_id:"inbound1"});
    expect(s.config.total_replies).toBe(1);expect(s.receipts).toHaveLength(1);
    expect(h.calls.every(c=>c.method==="GET")).toBe(true);
    expect(h.calls.every(c=>c.redirect==="error")).toBe(true);
    expect(new URL(h.calls.find(c=>c.url.includes("/messages?"))!.url).searchParams.get("includeSpamTrash")).toBe("true");
  });
  it("does not confuse another recent message from the same address with a reply",async()=>{
    const h=harness({messages:[message("unrelated",{parent:"<other@invalid.example>",references:"<other@invalid.example>"}),message("real")]});
    const result=await (await h.handler(request())).json();expect(result.recorded).toHaveLength(1);
    expect(result.recorded[0].gmail_message_id).toBe("real");
    expect(h.calls.some(c=>c.url.includes("/unrelated?format=full"))).toBe(false);
  });
  it.each([
    {name:"wrong sender",opts:{from:"Else <else@example.invalid>"}},
    {name:"outgoing message",opts:{labels:["SENT"]}},
    {name:"draft",opts:{labels:["DRAFT"]}},
    {name:"missing linkage",opts:{parent:"",references:""}},
    {name:"before outreach",opts:{receivedAt:Date.now()-600_000}},
  ])("ignores $name",async({opts})=>{
    const h=harness({messages:[message("ignored",opts)]});
    expect((await (await h.handler(request())).json()).recorded).toEqual([]);
    expect((await state()).prospect.has_replied).toBe(false);
  });
  it("accepts a valid References chain even when the direct parent is another reply",async()=>{
    const h=harness({messages:[message("chain",{parent:"<previous@recipient.example.invalid>",references:parentRfc+" <previous@recipient.example.invalid>"})]});
    expect((await (await h.handler(request())).json()).recorded).toHaveLength(1);
  });
  it.each(["id","to","from","subject","reply_to","message_id"])("rejects mismatching outbound provider %s",async(field)=>{
    const bad:Row={id:"other",to:["other@example.invalid"],from:"other@example.invalid",subject:"Other",reply_to:["other@example.invalid"],message_id:"not-an-rfc-id"};
    const h=harness({sent:{[field]:bad[field]}});
    expect((await (await h.handler(request())).json()).status).toBe("partial");
    expect((await state()).receipts).toHaveLength(0);
    expect(h.calls.some(c=>c.url.includes("/messages"))).toBe(false);
  });
  it("never treats the Resend API UUID as the RFC message id",async()=>{
    const h=harness({messages:[message("uuid",{parent:provider,references:provider})]});
    expect((await (await h.handler(request())).json()).recorded).toEqual([]);
  });
  it("keeps previously bound RFC evidence usable when provider history becomes unavailable",async()=>{
    await bind();
    const h=harness({providerError:404});
    const result=await (await h.handler(request())).json();
    expect(result).toMatchObject({status:"partial",scanned:1,issues:[{action_id:action,reason:"provider_status_unavailable"}]});
    expect(result.recorded).toHaveLength(1);
    expect((await state()).prospect.has_replied).toBe(true);
  });
  it("never invents a missing RFC proof when provider history is unavailable",async()=>{
    const h=harness({providerError:404});
    expect((await (await h.handler(request())).json()).status).toBe("partial");
    expect((await state()).receipts).toHaveLength(0);
    expect(h.calls.some(c=>c.url.includes("/messages"))).toBe(false);
  });
  it("does not hide a conflicting provider proof behind a cached RFC identifier",async()=>{
    await bind();
    const h=harness({sent:{message_id:"<conflicting@mail.example.invalid>"}});
    expect((await (await h.handler(request())).json()).status).toBe("partial");
    expect((await state()).receipts).toHaveLength(0);
    expect(h.calls.some(c=>c.url.includes("/messages"))).toBe(false);
  });
  it("pauses an automatic reply without inferring a return date and can process a later human reply",async()=>{
    const h=harness({messages:[message("auto",{auto:"auto-replied"})]});
    expect((await (await h.handler(request())).json()).recorded[0].kind).toBe("automatic");
    expect((await state()).prospect).toMatchObject({has_replied:true,next_action_at:null,reply_kind:"automatic"});
    const next=harness({messages:[message("later",{receivedAt:receivedAt+1000})]});
    expect((await (await next.handler(request())).json()).recorded[0].kind).toBe("human");
    expect((await state()).prospect.reply_gmail_message_id).toBe("later");
  });
  it.each(["Désabonnez-moi.","Please unsubscribe me","Ne me contactez plus","No thanks."])("persists explicit refusal %s",async(text)=>{
    const h=harness({messages:[message("refusal",{text})]});
    expect((await (await h.handler(request())).json()).recorded[0].kind).toBe("refusal");
    const s=await state();expect(s.prospect.status).toBe("rejected");expect(s.suppressions).toHaveLength(1);
  });
  it("does not interpret a quoted refusal as a new opt-out",async()=>{
    const h=harness({messages:[message("quote",{text:"Bonjour, pourriez-vous préciser ?\n> Désabonnez-moi"})]});
    expect((await (await h.handler(request())).json()).recorded[0].kind).toBe("human");
  });
  it.each(["bounced","complained"])("stops outreach on provider-confirmed %s",async(event)=>{
    const h=harness({event});const r=await (await h.handler(request())).json();
    expect(r.recorded[0]).toMatchObject({kind:"delivery_failure",reason:event});
    const s=await state();expect(s.suppressions).toHaveLength(1);expect(s.prospect.next_action_at).toBeNull();
    expect(h.calls.some(c=>c.url.includes("/messages"))).toBe(false);
  });
  it("deduplicates repeated polling and concurrent durable recording",async()=>{
    await bind();const outcomes=await Promise.all(Array.from({length:20},()=>record()));
    expect(outcomes.filter(r=>r.status==="recorded")).toHaveLength(1);
    expect(outcomes.filter(r=>r.status==="duplicate")).toHaveLength(19);
    expect((await state()).config.total_replies).toBe(1);
  });
  it("deduplicates a second Gmail copy with the same incoming RFC Message-ID",async()=>{
    await bind();await record();
    expect(await record({p_gmail_message_id:"copy"})).toEqual({status:"duplicate"});
    expect((await state()).receipts).toHaveLength(1);
  });
  it("does not duplicate a receipt after an acknowledgement is lost",async()=>{
    expect((await (await harness({loseReceipt:true}).handler(request())).json()).status).toBe("partial");
    expect((await (await harness().handler(request())).json()).recorded).toEqual([]);
    expect((await state()).config.total_replies).toBe(1);
  });
  it.each(["contract_signed","active"])("preserves advanced %s during late refusals",async(status)=>{
    const h=harness({messages:[message("late",{text:"STOP"})],
      beforeRecord:()=>db.query("UPDATE purama_ai.partner_prospects SET status=$1 WHERE id=$2",[status,prospect])});
    expect((await (await h.handler(request())).json()).recorded[0].kind).toBe("refusal");
    expect((await state()).prospect.status).toBe(status);expect((await state()).suppressions).toHaveLength(1);
  });
  it("preserves the newest reply when an older page is received later",async()=>{
    await bind();await record({p_gmail_message_id:"new",p_rfc_message_id:"<new@recipient.example.invalid>",p_received_at:new Date(receivedAt+1000).toISOString()});
    await record({p_kind:"automatic"});
    const s=await state();expect(s.prospect.reply_gmail_message_id).toBe("new");expect(s.prospect.reply_kind).toBe("human");
  });
  it("persists a Gmail page cursor and scans the next page on a later poll",async()=>{
    const first=harness({page:{messages:[],nextPageToken:"next-page"}});
    expect((await (await first.handler(request())).json()).status).toBe("completed");
    const next=harness();await next.handler(request());
    expect(next.calls.some(c=>c.url.includes("pageToken=next-page"))).toBe(true);
    expect((await db.query<Row>("SELECT reply_scan_page_token FROM purama_ai.partner_outreach_dispatches")).rows[0].reply_scan_page_token).toBeNull();
  });
  it("prevents stale cursor writes",async()=>{
    const checkpoint=(expected:string|null,next:string|null)=>mustRpc("partner_reply_checkpoint",{...common(),p_expected_page_token:expected,p_next_page_token:next});
    expect(await checkpoint(null,"first")).toMatchObject({status:"checkpointed"});
    expect(await checkpoint(null,"stale")).toMatchObject({status:"blocked",reason:"stale_scan"});
    expect((await db.query<Row>("SELECT reply_scan_page_token FROM purama_ai.partner_outreach_dispatches")).rows[0].reply_scan_page_token).toBe("first");
  });
  it("resets an expired Gmail cursor without blindly retrying a provider call",async()=>{
    await mustRpc("partner_reply_checkpoint",{...common(),p_expected_page_token:null,p_next_page_token:"expired"});
    const h=harness({pageError:400});
    expect((await (await h.handler(request())).json()).status).toBe("partial");
    expect(h.calls.filter(c=>c.url.includes("/messages?"))).toHaveLength(1);
    expect((await db.query<Row>("SELECT reply_scan_page_token FROM purama_ai.partner_outreach_dispatches")).rows[0].reply_scan_page_token).toBeNull();
  });
  it("rejects a connection replaced while provider reads were in progress",async()=>{
    const h=harness({beforeRecord:()=>db.query("UPDATE purama_ai.email_agent_config SET updated_at=now() WHERE user_id=$1",[user])});
    expect((await (await h.handler(request())).json()).status).toBe("partial");expect((await state()).receipts).toHaveLength(0);
  });
  it("rejects a different Gmail mailbox before inspecting recipient messages",async()=>{
    const h=harness({profileEmail:"other@example.invalid"});
    expect((await h.handler(request())).status).toBe(409);expect(h.calls).toHaveLength(1);
  });
  it("excludes a frozen reply-to that does not belong to the connected mailbox",async()=>{
    await db.query("UPDATE purama_ai.partner_outreach_dispatches SET payload=jsonb_set(payload,'{reply_to}','\"different@example.invalid\"')");
    const h=harness();expect((await (await h.handler(request())).json()).status).toBe("completed");
    expect((await state()).receipts).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });
  it("does not let more than one batch of old wrong-mailbox sends hide a current reply",async()=>{
    await addOlderCandidates(6,{replyTo:"previous-mailbox@example.invalid"});
    const result=await (await harness().handler(request({limit:5}))).json();
    expect(result).toMatchObject({status:"completed",scanned:1});
    expect(result.recorded).toHaveLength(1);
    expect((await state()).receipts).toHaveLength(1);
  });
  it.each([false,true])("rotates more than one batch of failed proofs without advancing cursors (invalid=%s)",async(invalid)=>{
    const older=await addOlderCandidates(6,{invalid});
    const first=await (await harness().handler(request({limit:5}))).json();
    expect(first).toMatchObject({status:"partial",scanned:0,recorded:[]});
    expect(first.issues).toHaveLength(5);
    expect((await state()).prospect.has_replied).toBe(false);
    const second=await (await harness().handler(request({limit:5}))).json();
    expect(second.recorded).toHaveLength(1);
    expect(second.recorded[0].prospect_id).toBe(prospect);
    const attempts=(await db.query<Row>("SELECT last_reply_scan_at,reply_scan_page_token FROM purama_ai.partner_outreach_dispatches WHERE id=ANY($1::uuid[])",[older])).rows;
    expect(attempts).toHaveLength(6);
    expect(attempts.every(row=>row.last_reply_scan_at!==null&&row.reply_scan_page_token==="still-pending")).toBe(true);
    expect((await state()).receipts).toHaveLength(1);
  });
  it("does not rotate candidates that were never visited after the run was cancelled",async()=>{
    const older=await addOlderCandidates(6);
    const controller=new AbortController();
    const h=harness({beforeFetch:(url:string)=>{if(url.startsWith("https://api.resend.com/"))controller.abort();}});
    const result=await (await h.handler(new Request(request({limit:5}),{signal:controller.signal}))).json();
    expect(result.status).toBe("partial");
    expect(result.issues).toContainEqual({reason:"sync_interrupted"});
    const attempts=(await db.query<Row>("SELECT last_reply_scan_at FROM purama_ai.partner_outreach_dispatches WHERE id=ANY($1::uuid[])",[older])).rows;
    expect(attempts.filter(row=>row.last_reply_scan_at!==null)).toHaveLength(1);
    expect((await state()).receipts).toHaveLength(0);
  });
  it("does not accept another tenant's dispatch at any record operation",async()=>{
    await bind();
    expect(await record({p_user_id:other,p_connection_email:"other@example.invalid"})).toMatchObject({status:"blocked",reason:"action_not_found"});
  });
  it("does not bind an unconfirmed send",async()=>{
    await db.query("UPDATE purama_ai.partner_outreach_dispatches SET status='unknown' WHERE id=$1",[action]);
    expect(await bind()).toMatchObject({status:"blocked",reason:"send_not_confirmed"});
  });
  it.each([
    {auth:"Bearer wrong",delegated:undefined},
    {auth:"Bearer user-token",delegated:other},
    {auth:"Bearer scheduler-secret",delegated:"not-a-uuid"},
  ])("rejects unsupported authentication before provider access",async({auth,delegated})=>{
    const h=harness();expect((await h.handler(request({},auth,delegated))).status).toBe(401);expect(h.calls).toEqual([]);
  });
  it("accepts exact server delegation and ignores no client-selected account",async()=>{
    const h=harness();expect((await h.handler(request({},"Bearer scheduler-secret",user))).status).toBe(200);
    expect((await h.handler(request({user_id:other}))).status).toBe(400);
  });
  it("denies direct RPC execution to an authenticated client",async()=>{
    await db.exec("SET ROLE authenticated");
    await expect(db.query("SELECT purama_ai.partner_reply_candidates($1,5)",[user])).rejects.toThrow();
  });
  it("migration is idempotent and preserves stored receipt evidence",async()=>{
    await bind();await record();
    await db.exec(migration("20261124050200_partner_reply_evidence.sql"));
    expect((await state()).receipts).toHaveLength(1);
  });
});
