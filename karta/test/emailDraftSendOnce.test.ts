import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const handlerUrl = new URL("../../supabase/functions/email-agent-send-draft/handler.ts", import.meta.url).href;
const { createDraftSender } = await import(/* @vite-ignore */ handlerUrl);
const historical = readFileSync(new URL("../../supabase/migrations/20260406210000_email_agent.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../supabase/migrations/20261122004000_email_agent_send_reservations.sql", import.meta.url), "utf8");
const approvalMigration = readFileSync(new URL("../../supabase/migrations/20261122020000_email_agent_draft_approvals.sql", import.meta.url), "utf8");
let approvalId = "";
const user = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const log = "00000000-0000-4000-8000-000000000011";
const replacement = "00000000-0000-4000-8000-000000000012";
const claim = "00000000-0000-4000-8000-000000000021";
const otherClaim = "00000000-0000-4000-8000-000000000022";
type Row = Record<string, unknown>;
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    INSERT INTO auth.users(id) VALUES ('${user}'), ('${other}');`);
  await db.exec(historical);
  await db.exec(migration);
  await db.exec(approvalMigration);
});
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE purama_ai.email_agent_draft_previews, purama_ai.email_agent_dispatches, purama_ai.email_agent_logs, purama_ai.email_agent_config, purama_ai.email_agent_memory");
  await db.query(`INSERT INTO purama_ai.email_agent_config(user_id,gmail_email)
    VALUES ($1,'owner@example.invalid'),($2,'other@example.invalid')`, [user,other]);
  await insertLog();
  await reviewCurrent();
});
afterAll(async () => { await db?.close(); });
async function insertLog(id=log, owner=user, message="incoming-1") {
  await db.query(`INSERT INTO purama_ai.email_agent_logs
    (id,user_id,gmail_message_id,gmail_thread_id,gmail_draft_id,from_email,category,action_taken,ai_response,ai_subject,user_approved,created_at)
    VALUES ($1,$2,$3,'thread-1','draft-1','recipient@example.invalid','faq','draft','Approved body','Re: Approved subject',true,clock_timestamp())`,
  [id,owner,message]);
}
const fnArgs: Record<string,string[]> = {
  email_agent_send_reserve:["p_user_id","p_log_id","p_claim_token","p_approval_id"],
  email_agent_draft_preview:["p_user_id","p_log_id"],
  email_agent_draft_approve:["p_user_id","p_log_id","p_approval_id","p_feedback"],
  email_agent_send_begin:["p_user_id","p_action_id","p_claim_token","p_connection_email","p_connection_updated_at"],
  email_agent_send_finish:["p_user_id","p_action_id","p_claim_token","p_outcome","p_provider_message_id"],
};
async function rpc(name:string,args:Row):Promise<{data:Row|null;error:unknown}> {
  const keys=fnArgs[name];
  if(!keys) throw new Error(`Unexpected RPC ${name}`);
  try {
    const r=await db.query<{value:Row}>(`SELECT purama_ai.${name}(${keys.map((_,i)=>`$${i+1}`).join(",")}) AS value`,keys.map(key=>key==="p_approval_id"&&!Object.hasOwn(args,key)?approvalId:args[key]??null));
    return {data:r.rows[0].value,error:null};
  } catch(error) { return {data:null,error}; }
}
async function mustRpc(name:string,args:Row) {
  const r=await rpc(name,args);
  if(r.error||!r.data) throw r.error??new Error("No RPC data");
  return r.data;
}
async function reviewCurrent() {
  const preview=await mustRpc("email_agent_draft_preview",{p_user_id:user,p_log_id:log});
  expect(preview.status).toBe("ready");
  approvalId=String(preview.approval_id);
  expect(await mustRpc("email_agent_draft_approve",{p_user_id:user,p_log_id:log,p_approval_id:approvalId})).toMatchObject({status:"approved"});
}
async function config() {
  return (await db.query<{gmail_email:string;stamp:string}>("SELECT gmail_email,updated_at::text AS stamp FROM purama_ai.email_agent_config WHERE user_id=$1",[user])).rows[0];
}
async function reserve() { return mustRpc("email_agent_send_reserve",{p_user_id:user,p_log_id:log,p_claim_token:claim}); }
async function begin(actionId:unknown, token=claim) {
  const cfg=await config();
  return mustRpc("email_agent_send_begin",{p_user_id:user,p_action_id:actionId,p_claim_token:token,
    p_connection_email:cfg.gmail_email,p_connection_updated_at:cfg.stamp});
}
async function state() { return (await db.query<Row>("SELECT * FROM purama_ai.email_agent_dispatches WHERE user_id=$1",[user])).rows[0]; }
async function count() { return (await db.query<{n:number}>("SELECT total_auto_replied AS n FROM purama_ai.email_agent_config WHERE user_id=$1",[user])).rows[0].n; }
function request(body:unknown={log_id:log},authorization="Bearer valid") {
  return new Request("https://example.invalid/send",{method:"POST",headers:{Authorization:authorization,"Content-Type":"application/json"},body:JSON.stringify(body&&typeof body==="object"?{user_id:user,approval_id:approvalId,...body}:body)});
}
type Options = {
  provider?: "timeout"|"server"|"missing_id"|"malformed"|"rejected"|"throttled";
  identity?:string; authenticated?:string|null;
  beforeAccess?:()=>Promise<void>; onPrepared?:()=>Promise<void>; onProfile?:()=>Promise<void>; onSend?:()=>Promise<void>;
  rawDraft?:string; parent?:Row; draftResponse?:()=>Response;
  failAt?:"reserve"|"begin_before_commit"|"begin_after_commit"|"finish_before_commit"|"finish_after_commit"|"all_finish";
};
function approvedRaw():string {
  return "From: owner@example.invalid\r\nTo: recipient@example.invalid\r\nSubject: Re: Approved subject\r\n"
    +"In-Reply-To: <parent@example.invalid>\r\nReferences: <parent@example.invalid>\r\n"
    +"MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nApproved body";
}
function harness(options:Options={}) {
  const sends:{url:string;body:Row;headers:Headers;redirect?:RequestInit["redirect"]}[]=[];
  const profiles:string[]=[];
  const draftReads:string[]=[];
  let remoteRaw=options.rawDraft??Buffer.from(approvedRaw()).toString("base64url");
  const handler=createDraftSender({
    authenticate:async(token:string)=>token==="valid"?(options.authenticated===undefined?user:options.authenticated):null,
    rpc:async(name:string,args:Row)=>{
      if(options.failAt==="reserve"&&name==="email_agent_send_reserve") return {data:null,error:new Error("database unavailable")};
      if(name==="email_agent_send_begin"&&options.failAt?.startsWith("begin_")) {
        if(options.failAt==="begin_after_commit") await mustRpc(name,args);
        return {data:null,error:new Error("begin acknowledgement lost")};
      }
      if(name==="email_agent_send_finish"&&(options.failAt==="all_finish"||args.p_outcome==="sent"&&options.failAt?.startsWith("finish_"))) {
        if(options.failAt==="finish_after_commit") await mustRpc(name,args);
        return {data:null,error:new Error("completion acknowledgement lost")};
      }
      return rpc(name,args);
    },
    prepareAccess:async()=>{
      await options.beforeAccess?.();
      const cfg=await config();await options.onPrepared?.();
      return {accessToken:"test-only-token",gmailEmail:cfg.gmail_email,connectionUpdatedAt:cfg.stamp};
    },
    fetch:async(input:string|URL|Request,init?:RequestInit)=>{
      const url=String(input);expect(init?.signal).toBeInstanceOf(AbortSignal);
      if(url.endsWith("/profile")) {
        profiles.push(url);await options.onProfile?.();
        return Response.json({emailAddress:options.identity??"owner@example.invalid"});
      }
      if(url.includes("/messages/incoming-1?format=metadata")) {
        return Response.json({id:"incoming-1",threadId:"thread-1",payload:{headers:[
          {name:"Message-ID",value:"<parent@example.invalid>"},{name:"From",value:"recipient@example.invalid"},
          {name:"Subject",value:"Approved subject"},{name:"References",value:"<ancestor@example.invalid>"},
        ]},...options.parent});
      }
      if(url.endsWith("/drafts/draft-1?format=raw")) {
        draftReads.push(remoteRaw);
        if(options.draftResponse) return options.draftResponse();
        return Response.json({id:"draft-1",message:{threadId:"thread-1",raw:remoteRaw}});
      }
      expect(init?.method).toBe("POST");
      expect(["https://gmail.googleapis.com/gmail/v1/users/me/drafts/send","https://gmail.googleapis.com/gmail/v1/users/me/messages/send"]).toContain(url);
      sends.push({url,body:JSON.parse(String(init?.body)) as Row,headers:new Headers(init?.headers),redirect:init?.redirect});
      await options.onSend?.();
      if(options.provider==="timeout") throw new Error("possible acceptance then disconnect");
      if(options.provider==="server") return new Response("unavailable",{status:500});
      if(options.provider==="throttled") return new Response("throttled",{status:429});
      if(options.provider==="rejected") return new Response("rejected",{status:400});
      if(options.provider==="malformed") return new Response("{broken",{status:200});
      return Response.json(options.provider==="missing_id"?{}:{id:"provider-message-1"});
    },
  });
  return {handler,sends,profiles,draftReads,setRemoteRaw:(raw:string)=>{remoteRaw=raw;}};
}

describe("email-agent-send-draft durable at-most-one provider attempt",()=>{
  it("persists the provider receipt and source log atomically before success",async()=>{
    const h=harness();const response=await h.handler(request());
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true,status:"sent",provider_message_id:"provider-message-1",matches_current_preview:true});
    expect(h.sends).toHaveLength(1);expect(h.sends[0].body).toEqual({id:"draft-1",message:{raw:h.draftReads[0],threadId:"thread-1"}});
    expect(await state()).toMatchObject({status:"sent",provider_message_id:"provider-message-1"});
    expect((await db.query<Row>("SELECT action_taken,user_approved FROM purama_ai.email_agent_logs WHERE id=$1",[log])).rows[0]).toMatchObject({action_taken:"auto_reply",user_approved:true});
    expect(await count()).toBe(1);
  });
  it("keeps a different current draft pending when its approved predecessor completes during an edit",async()=>{
    const h=harness({onSend:async()=>{
      await db.query("UPDATE purama_ai.email_agent_logs SET ai_response='New draft written during Gmail POST' WHERE id=$1",[log]);
    }});
    const response=await h.handler(request());
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:"sent",matches_current_preview:false});
    expect(await state()).toMatchObject({status:"sent",provider_message_id:"provider-message-1"});
    expect((await db.query<Row>("SELECT action_taken,ai_response FROM purama_ai.email_agent_logs WHERE id=$1",[log])).rows[0])
      .toMatchObject({action_taken:"draft",ai_response:"New draft written during Gmail POST"});
    const replay=await h.handler(request());expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({reason:"previous_send_differs"});
    expect(h.sends).toHaveLength(1);expect(await count()).toBe(1);
  });
  it("records a completed send without undoing a refusal or its feedback during Gmail POST",async()=>{
    let reviewedAt:unknown;
    const h=harness({onSend:async()=>{
      const changed=await db.query<Row>("UPDATE purama_ai.email_agent_logs SET user_approved=false,user_feedback='Withdrawn while sending',feedback_at=clock_timestamp() WHERE id=$1 RETURNING feedback_at::text AS stamp",[log]);
      reviewedAt=changed.rows[0].stamp;
    }});
    const response=await h.handler(request());
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:"sent",matches_current_preview:true});
    expect((await db.query<Row>("SELECT user_approved,user_feedback,feedback_at::text AS stamp FROM purama_ai.email_agent_logs WHERE id=$1",[log])).rows[0])
      .toEqual({user_approved:false,user_feedback:"Withdrawn while sending",stamp:reviewedAt});
    expect(await state()).toMatchObject({status:"sent",provider_message_id:"provider-message-1"});
    await h.handler(request());expect(h.sends).toHaveLength(1);expect(await count()).toBe(1);
  });
  it("twenty interleaved handler calls emit exactly one Gmail POST",async()=>{
    const h=harness();const responses=await Promise.all(Array.from({length:20},()=>h.handler(request())));
    expect(h.sends).toHaveLength(1);expect(responses.filter((r:Response)=>r.status===200).length).toBeGreaterThanOrEqual(1);
    expect(responses.every((r:Response)=>r.status===200||r.status===409)).toBe(true);expect(await count()).toBe(1);
  });
  it("replays the receipt without another Gmail access",async()=>{
    const first=harness();await first.handler(request());
    const replay=harness();expect((await replay.handler(request())).status).toBe(200);
    expect(replay.sends).toHaveLength(0);expect(replay.profiles).toHaveLength(0);expect(await count()).toBe(1);
  });
  it.each(["drafts/send", "messages/send"] as const)("forbids redirecting the approved POST at %s", async (endpoint) => {
    if (endpoint === "messages/send") {
      await db.query("UPDATE purama_ai.email_agent_logs SET gmail_draft_id=NULL WHERE id=$1", [log]);
      await reviewCurrent();
    }
    const h = harness({ onSend: async () => { throw new TypeError("Fetch rejected a redirect"); } });
    const response = await h.handler(request());
    expect(h.sends.map(({ url, redirect }) => ({ url, redirect }))).toEqual([
      { url: `https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`, redirect: "error" },
    ]);
    expect(response.status).toBe(409);
    expect(await state()).toMatchObject({ status: "unknown", provider_message_id: null });
    expect((await h.handler(request())).status).toBe(409);
    expect(h.sends).toHaveLength(1);
    expect(await count()).toBe(0);
  });
  it.each(["timeout","server","throttled","missing_id","malformed"] as const)("retains unknown after %s and never retries",async(provider)=>{
    const h=harness({provider});expect((await h.handler(request())).status).toBe(409);
    expect(await state()).toMatchObject({status:"unknown",provider_message_id:null});
    expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(1);expect(await count()).toBe(0);
  });
  it("retains explicit rejection without a second provider attempt",async()=>{
    const h=harness({provider:"rejected"});await h.handler(request());await h.handler(request());
    expect(await state()).toMatchObject({status:"failed",reason:"provider_rejected"});expect(h.sends).toHaveLength(1);
  });
  it("suppresses retries when completion did not commit after provider acceptance",async()=>{
    const h=harness({failAt:"finish_before_commit"});expect((await h.handler(request())).status).toBe(409);
    expect(await state()).toMatchObject({status:"unknown",provider_message_id:"provider-message-1"});
    await h.handler(request());expect(h.sends).toHaveLength(1);expect(await count()).toBe(0);
  });
  it("recovers a durable sent receipt after lost commit acknowledgement",async()=>{
    const h=harness({failAt:"finish_after_commit"});expect((await h.handler(request())).status).toBe(200);
    expect(await state()).toMatchObject({status:"sent"});await h.handler(request());expect(h.sends).toHaveLength(1);expect(await count()).toBe(1);
  });
  it("keeps sending suppression when all receipt writes fail",async()=>{
    const h=harness({failAt:"all_finish"});expect((await h.handler(request())).status).toBe(409);
    expect(await state()).toMatchObject({status:"sending"});await h.handler(request());expect(h.sends).toHaveLength(1);
  });
  it.each(["begin_before_commit","begin_after_commit"] as const)("never calls Gmail after %s",async(failAt)=>{
    const h=harness({failAt});expect((await h.handler(request())).status).toBe(409);
    await h.handler(request());expect(h.sends).toHaveLength(0);expect(["preparing","sending"]).toContain((await state()).status);
  });
  it("fails closed if the migration/RPC is absent",async()=>{
    const h=harness({failAt:"reserve"});expect((await h.handler(request())).status).toBe(503);
    expect(h.sends).toHaveLength(0);expect(h.profiles).toHaveLength(0);
  });
  it("does not send another owner's log",async()=>{
    const h=harness({authenticated:other});expect((await h.handler(request({log_id:log,user_id:other}))).status).toBe(409);
    expect(h.sends).toHaveLength(0);expect(await state()).toBeUndefined();
  });
  it.each([null,false])("requires explicit approval, received %s",async(approved)=>{
    await db.query("UPDATE purama_ai.email_agent_logs SET user_approved=$1 WHERE id=$2",[approved,log]);
    const h=harness();expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(0);
  });
  it("revalidates approval after preparation",async()=>{
    const h=harness({onProfile:async()=>{await db.query("UPDATE purama_ai.email_agent_logs SET user_approved=false WHERE id=$1",[log]);}});
    expect((await h.handler(request())).status).toBe(409);
    expect(await state()).toMatchObject({status:"blocked",reason:"approval_or_log_changed"});expect(h.sends).toHaveLength(0);
  });
  it("rejects a changed approved payload",async()=>{
    const h=harness({onProfile:async()=>{await db.query("UPDATE purama_ai.email_agent_logs SET ai_response='Changed' WHERE id=$1",[log]);}});
    await h.handler(request());expect(await state()).toMatchObject({status:"blocked",reason:"approved_payload_changed"});expect(h.sends).toHaveLength(0);
  });
  it("detects a wrong Gmail token account before begin",async()=>{
    const h=harness({identity:"other@example.invalid"});await h.handler(request());
    expect(await state()).toMatchObject({status:"failed",reason:"preparation_failed",dispatch_started_at:null});expect(h.sends).toHaveLength(0);
  });
  it.each(["gmail_email","gmail_access_token"])("detects change in %s after preparing access",async(field)=>{
    const h=harness({onProfile:async()=>{await db.query(`UPDATE purama_ai.email_agent_config SET ${field}=$1 WHERE user_id=$2`,[field==="gmail_email"?"replacement@example.invalid":"test-only-change",user]);}});
    await h.handler(request());expect(await state()).toMatchObject({status:"blocked",reason:"gmail_connection_changed"});expect(h.sends).toHaveLength(0);
  });
  it("rejects an A-B-A Gmail connection replacement between reservation and access preparation",async()=>{
    const h=harness({beforeAccess:async()=>{
      await db.query("UPDATE purama_ai.email_agent_config SET gmail_email='temporary@example.invalid' WHERE user_id=$1",[user]);
      await db.query("UPDATE purama_ai.email_agent_config SET gmail_email='owner@example.invalid' WHERE user_id=$1",[user]);
    }});
    expect((await h.handler(request())).status).toBe(409);
    expect(await state()).toMatchObject({status:"blocked",reason:"gmail_connection_changed"});
    expect(h.sends).toHaveLength(0);expect(await count()).toBe(0);
  });
  it.each(["email","domain","memory"])("honors recipient exclusion from %s",async(kind)=>{
    if(kind==="memory") await db.query("INSERT INTO purama_ai.email_agent_memory(user_id,contact_email,is_blocked) VALUES ($1,'recipient@example.invalid',true)",[user]);
    else await db.query(`UPDATE purama_ai.email_agent_config SET ${kind==="email"?"excluded_emails":"excluded_domains"}=$1 WHERE user_id=$2`,[[kind==="email"?"recipient@example.invalid":"example.invalid"],user]);
    await reviewCurrent();
    const h=harness();await h.handler(request());expect(await state()).toMatchObject({status:"blocked",reason:"recipient_blocked"});expect(h.sends).toHaveLength(0);
  });
  it("keeps suppression after source log deletion and reimport",async()=>{
    const h=harness({provider:"timeout"});await h.handler(request());
    await db.query("DELETE FROM purama_ai.email_agent_logs WHERE id=$1",[log]);await insertLog(replacement);
    await h.handler(request({log_id:replacement}));expect(h.sends).toHaveLength(1);expect(await state()).toMatchObject({status:"unknown",log_id:log});
  });
  it("persists a receipt if the source log disappears during the provider call",async()=>{
    const h=harness({onSend:async()=>{await db.query("DELETE FROM purama_ai.email_agent_logs WHERE id=$1",[log]);}});
    expect((await h.handler(request())).status).toBe(200);expect(await state()).toMatchObject({status:"sent",provider_message_id:"provider-message-1"});
    await insertLog(replacement);expect((await h.handler(request({log_id:replacement}))).status).toBe(200);expect(h.sends).toHaveLength(1);
  });
  it("never takes over an abandoned reservation and fences wrong/expired claims",async()=>{
    const reserved=await reserve();await db.exec("UPDATE purama_ai.email_agent_dispatches SET lease_until=clock_timestamp()-interval '1 second'");
    const again=await mustRpc("email_agent_send_reserve",{p_user_id:user,p_log_id:log,p_claim_token:otherClaim});expect(again.claimed).toBe(false);
    expect(await begin(reserved.action_id,otherClaim)).toMatchObject({status:"blocked",reason:"claim_mismatch"});
    expect(await begin(reserved.action_id)).toMatchObject({status:"blocked",reason:"claim_expired"});
    const h=harness();await h.handler(request());expect(h.sends).toHaveLength(0);
  });
  it("allows only one transition to sending even with the same claim",async()=>{
    const reserved=await reserve();expect(await begin(reserved.action_id)).toMatchObject({claimed:true,status:"sending"});
    expect(await begin(reserved.action_id)).toMatchObject({claimed:false,status:"sending"});
  });
  it("requires begin and a nonempty receipt before sent",async()=>{
    const reserved=await reserve();const args={p_user_id:user,p_action_id:reserved.action_id,p_claim_token:claim,p_outcome:"sent",p_provider_message_id:"message"};
    expect((await rpc("email_agent_send_finish",args)).error).toBeTruthy();await begin(reserved.action_id);
    expect((await rpc("email_agent_send_finish",{...args,p_provider_message_id:""})).error).toBeTruthy();
    expect(await state()).toMatchObject({status:"sending",provider_message_id:null});expect(await count()).toBe(0);
  });
  it("denies another owner finalization",async()=>{
    const reserved=await reserve();await begin(reserved.action_id);
    expect(await mustRpc("email_agent_send_finish",{p_user_id:other,p_action_id:reserved.action_id,p_claim_token:claim,p_outcome:"sent",p_provider_message_id:"message"}))
      .toMatchObject({status:"blocked",reason:"dispatch_not_found"});
    expect(await state()).toMatchObject({status:"sending"});
  });
  it("does not downgrade sent or count twice after uncertain completion",async()=>{
    const reserved=await reserve();await begin(reserved.action_id);const args={p_user_id:user,p_action_id:reserved.action_id,p_claim_token:claim};
    await mustRpc("email_agent_send_finish",{...args,p_outcome:"sent",p_provider_message_id:"message-1"});
    expect(await mustRpc("email_agent_send_finish",{...args,p_outcome:"unknown"})).toMatchObject({status:"sent",provider_message_id:"message-1"});expect(await count()).toBe(1);
  });
  it.each([true,null])("quarantines historical approval %s and reruns migration idempotently",async(approved)=>{
    await db.query("UPDATE purama_ai.email_agent_logs SET created_at='2020-01-01',user_approved=$1 WHERE id=$2",[approved,log]);
    const cutoff=(await db.query<Row>("SELECT installed_at::text FROM purama_ai.email_agent_send_policy")).rows[0];
    await db.exec("UPDATE purama_ai.email_agent_send_policy SET legacy_backfill_completed=false");
    await db.exec(migration);await db.exec(approvalMigration);await db.exec(migration);await db.exec(approvalMigration);
    expect((await db.query<Row>("SELECT installed_at::text FROM purama_ai.email_agent_send_policy")).rows[0]).toEqual(cutoff);
    await db.query("UPDATE purama_ai.email_agent_logs SET user_approved=true,feedback_at=clock_timestamp() WHERE id=$1",[log]);
    const h=harness();await h.handler(request());expect(await state()).toMatchObject({status:"unknown",reason:"historical_outcome_unverified"});expect(h.sends).toHaveLength(0);
    expect((await db.query<{n:number}>("SELECT count(*)::integer AS n FROM purama_ai.email_agent_dispatches")).rows[0].n).toBe(1);
  });
  it("blocks a late-imported historical log",async()=>{
    await db.query("UPDATE purama_ai.email_agent_logs SET created_at='2020-01-01' WHERE id=$1",[log]);
    const h=harness();await h.handler(request());expect(await state()).toMatchObject({status:"unknown",reason:"historical_outcome_unverified"});expect(h.sends).toHaveLength(0);
  });
  it("initial backfill captures legacy rows with a future created_at",async()=>{
    await db.query("UPDATE purama_ai.email_agent_logs SET created_at='2099-01-01' WHERE id=$1",[log]);
    await db.exec("UPDATE purama_ai.email_agent_send_policy SET legacy_backfill_completed=false");
    await db.exec(migration);await db.exec(approvalMigration);
    const h=harness();await h.handler(request());expect(await state()).toMatchObject({status:"unknown",reason:"historical_outcome_unverified"});expect(h.sends).toHaveLength(0);
  });
  it("a repeated migration leaves a new approved first emission eligible",async()=>{
    await db.exec(migration);await db.exec(approvalMigration);
    const h=harness();expect((await h.handler(request())).status).toBe(200);expect(h.sends).toHaveLength(1);
  });
  it("denies authenticated direct ledger access and service RPCs",async()=>{
    await db.exec("SET ROLE authenticated");
    try {
      await expect(db.query("SELECT * FROM purama_ai.email_agent_dispatches")).rejects.toThrow(/permission denied/i);
      await expect(db.query("DELETE FROM purama_ai.email_agent_dispatches")).rejects.toThrow(/permission denied/i);
      await expect(db.query("SELECT purama_ai.email_agent_send_reserve($1,$2,$3)",[user,log,claim])).rejects.toThrow(/permission denied/i);
    } finally {await db.exec("RESET ROLE");}
  });
  it("permits the service role to reserve",async()=>{
    await db.exec("SET ROLE service_role");
    try {expect(await reserve()).toMatchObject({status:"preparing",claimed:true});}
    finally {await db.exec("RESET ROLE");}
  });
  it("builds fallback only from the frozen approved payload",async()=>{
    await db.query("UPDATE purama_ai.email_agent_logs SET gmail_draft_id=NULL,ai_response='Réponse approuvée' WHERE id=$1",[log]);
    await reviewCurrent();
    const h=harness();expect((await h.handler(request({log_id:log,to:"attacker@example.invalid",body:"changed"}))).status).toBe(200);
    expect(h.sends[0].url.endsWith("/messages/send")).toBe(true);expect(h.sends[0].body.threadId).toBe("thread-1");
    const raw=Buffer.from(String(h.sends[0].body.raw),"base64url").toString("utf8");
    expect(raw).toContain("To: recipient@example.invalid\r\n");expect(raw).toContain("Réponse approuvée");expect(raw).not.toContain("attacker");
    expect(raw).toContain("In-Reply-To: <parent@example.invalid>\r\nReferences: <ancestor@example.invalid>\r\n <parent@example.invalid>\r\n");
    expect(raw).toContain("Content-Transfer-Encoding: 8bit");
  });
  it("sends the exact validated raw even if the remote draft changes after GET",async()=>{
    const h=harness({onSend:async()=>{h.setRemoteRaw(Buffer.from(approvedRaw().replace("recipient@example.invalid","changed@example.invalid")).toString("base64url"));}});
    expect((await h.handler(request())).status).toBe(200);
    expect(h.sends[0].body).toEqual({id:"draft-1",message:{raw:Buffer.from(approvedRaw()).toString("base64url"),threadId:"thread-1"}});
  });
  it.each([
    ["recipient",(raw:string)=>raw.replace("To: recipient@example.invalid","To: changed@example.invalid")],
    ["Cc",(raw:string)=>raw.replace("Subject:","Cc: hidden@example.invalid\r\nSubject:")],
    ["folded Bcc",(raw:string)=>raw.replace("Subject:","Bcc:\r\n hidden@example.invalid\r\nSubject:")],
    ["subject",(raw:string)=>raw.replace("Re: Approved subject","Unapproved subject")],
    ["body",(raw:string)=>raw.replace("Approved body","Unapproved body")],
    ["parent",(raw:string)=>raw.replace("In-Reply-To: <parent@example.invalid>","In-Reply-To: <different@example.invalid>")],
    ["references",(raw:string)=>raw.replace("References: <parent@example.invalid>","References: <different@example.invalid>")],
    ["multipart",(raw:string)=>raw.replace("text/plain; charset=UTF-8","multipart/mixed; boundary=attachment")],
    ["attachment",(raw:string)=>raw.replace("MIME-Version:","Content-Disposition: attachment; filename=report.pdf\r\nMIME-Version:")],
    ["duplicate To",(raw:string)=>raw.replace("Subject:","To: recipient@example.invalid\r\nSubject:")],
    ["duplicate subject",(raw:string)=>raw.replace("MIME-Version:","Subject: Re: Approved subject\r\nMIME-Version:")],
    ["duplicate From",(raw:string)=>raw.replace("MIME-Version:","From: owner@example.invalid\r\nMIME-Version:")],
    ["duplicate parent",(raw:string)=>raw.replace("MIME-Version:","In-Reply-To: <parent@example.invalid>\r\nMIME-Version:")],
    ["wrong From",(raw:string)=>raw.replace("From: owner@example.invalid","From: other@example.invalid")],
    ["wrong Sender",(raw:string)=>raw.replace("MIME-Version:","Sender: other@example.invalid\r\nMIME-Version:")],
    ["unsupported charset",(raw:string)=>raw.replace("charset=UTF-8","charset=iso-8859-1")],
  ] as const)("rejects remote draft %s without any provider send",async(_kind,mutate)=>{
    const h=harness({rawDraft:Buffer.from(mutate(approvedRaw())).toString("base64url")});
    const response=await h.handler(request());expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({reason:"draft_content_unverified"});
    expect(await state()).toMatchObject({status:"failed",dispatch_started_at:null});expect(h.sends).toHaveLength(0);
  });
  it.each(["threadId","id"])("rejects a different incoming parent %s",async(field)=>{
    const h=harness({parent:{[field]:"different"}});expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(0);
  });
  it("rejects malformed or noncanonical raw Base64 and invalid UTF-8",async()=>{
    for(const raw of ["not+base64/url!","YR",Buffer.from([0xff,0xfe,0x00]).toString("base64url")]) {
      await db.exec("TRUNCATE purama_ai.email_agent_dispatches");
      const h=harness({rawDraft:raw});expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(0);
    }
  });
  it.each(["base64","quoted-printable"])("accepts unchanged simple text encoded as %s",async(encoding)=>{
    const body=encoding==="base64"?Buffer.from("Approved body").toString("base64"):"Approved=20body";
    const raw=approvedRaw().replace("MIME-Version:",`Content-Transfer-Encoding: ${encoding}\r\nMIME-Version:`).replace("\r\n\r\nApproved body",`\r\n\r\n${body}`);
    const h=harness({rawDraft:Buffer.from(raw).toString("base64url")});expect((await h.handler(request())).status).toBe(200);
    expect((h.sends[0].body.message as Row).raw).toBe(Buffer.from(raw).toString("base64url"));
  });
  it.each(["ascii charset","missing charset","7bit","missing transfer encoding"])("rejects non-ASCII text declared as %s",async(kind)=>{
    await db.query("UPDATE purama_ai.email_agent_logs SET ai_response='Réponse approuvée' WHERE id=$1",[log]);
    await reviewCurrent();
    let raw=approvedRaw().replace("Approved body","Réponse approuvée");
    if(kind==="ascii charset") raw=raw.replace("charset=UTF-8","charset=us-ascii").replace("MIME-Version:","Content-Transfer-Encoding: 8bit\r\nMIME-Version:");
    if(kind==="missing charset") raw=raw.replace("; charset=UTF-8","").replace("MIME-Version:","Content-Transfer-Encoding: 8bit\r\nMIME-Version:");
    if(kind==="7bit") raw=raw.replace("MIME-Version:","Content-Transfer-Encoding: 7bit\r\nMIME-Version:");
    const h=harness({rawDraft:Buffer.from(raw).toString("base64url")});
    expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(0);
  });
  it("rejects a us-ascii encoded word containing non-ASCII bytes",async()=>{
    const subject="Re: Réponse";
    await db.query("UPDATE purama_ai.email_agent_logs SET ai_subject=$1 WHERE id=$2",[subject,log]);
    await reviewCurrent();
    const raw=approvedRaw().replace("Re: Approved subject",`=?us-ascii?B?${Buffer.from(subject).toString("base64")}?=`);
    const h=harness({rawDraft:Buffer.from(raw).toString("base64url"),parent:{payload:{headers:[
      {name:"Message-ID",value:"<parent@example.invalid>"},{name:"From",value:"recipient@example.invalid"},{name:"Subject",value:"Réponse"},
    ]}}});
    expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(0);
  });
  it("stops an oversized chunked draft response before parsing JSON",async()=>{
    let cancelled=false,reads=0;
    const h=harness({draftResponse:()=>new Response(new ReadableStream<Uint8Array>({
      pull(controller){reads++;controller.enqueue(new Uint8Array(600_000));},cancel(){cancelled=true;},
    }))});
    expect((await h.handler(request())).status).toBe(409);expect(cancelled).toBe(true);expect(reads).toBeLessThanOrEqual(5);expect(h.sends).toHaveLength(0);
  });
  it.each(["From","Subject","Message-ID"])("rejects an unverified fallback parent %s",async(header)=>{
    await db.query("UPDATE purama_ai.email_agent_logs SET gmail_draft_id=NULL WHERE id=$1",[log]);
    await reviewCurrent();
    const headers=[{name:"Message-ID",value:"<parent@example.invalid>"},{name:"From",value:"recipient@example.invalid"},{name:"Subject",value:"Approved subject"}];
    headers.find(value=>value.name===header)!.value=header==="From"?"wrong@example.invalid":header==="Subject"?"Different topic":"not-a-message-id";
    const h=harness({parent:{payload:{headers}}});expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(0);
  });
  it("rejects a fallback parent Message-ID containing multiple at signs",async()=>{
    await db.query("UPDATE purama_ai.email_agent_logs SET gmail_draft_id=NULL WHERE id=$1",[log]);
    await reviewCurrent();
    const h=harness({parent:{payload:{headers:[
      {name:"Message-ID",value:"<parent@nested@example.invalid>"},{name:"From",value:"recipient@example.invalid"},{name:"Subject",value:"Approved subject"},
    ]}}});
    expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(0);
  });
  it.each(["from_email","ai_subject"])("blocks CRLF in %s before Gmail access",async(field)=>{
    await db.query(`UPDATE purama_ai.email_agent_logs SET ${field}=$1 WHERE id=$2`,["safe@example.invalid\r\nBcc: injected@example.invalid",log]);
    await reviewCurrent();
    const h=harness();expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(0);expect(h.profiles).toHaveLength(0);
  });
  it.each([31,127])("still rejects address control code %s before Gmail access",async(code)=>{
    await db.query("UPDATE purama_ai.email_agent_logs SET from_email=$1 WHERE id=$2",[`recipient${String.fromCharCode(code)}@example.invalid`,log]);
    await reviewCurrent();
    const h=harness();expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(0);expect(h.profiles).toHaveLength(0);
  });
  it("still rejects a NUL in a provider-supplied address",async()=>{
    // PostgreSQL text cannot store NUL; Gmail metadata is the actual JSON boundary.
    await db.query("UPDATE purama_ai.email_agent_logs SET gmail_draft_id=NULL WHERE id=$1",[log]);
    await reviewCurrent();
    const h=harness({parent:{payload:{headers:[
      {name:"Message-ID",value:"<parent@example.invalid>"},{name:"From",value:`recipient${String.fromCharCode(0)}@example.invalid`},
      {name:"Subject",value:"Approved subject"},
    ]}}});
    expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(0);
  });
  it.each([0,31,127])("still rejects parent Message-ID control code %s",async(code)=>{
    await db.query("UPDATE purama_ai.email_agent_logs SET gmail_draft_id=NULL WHERE id=$1",[log]);
    await reviewCurrent();
    const h=harness({parent:{payload:{headers:[
      {name:"Message-ID",value:`<parent${String.fromCharCode(code)}@example.invalid>`},
      {name:"From",value:"recipient@example.invalid"},{name:"Subject",value:"Approved subject"},
    ]}}});
    expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(0);
  });
  it.each([9,11,127])("preserves allowed internal header code %s",async(code)=>{
    const subject=`App${String.fromCharCode(code)}roved subject`;
    await db.query("UPDATE purama_ai.email_agent_logs SET ai_subject=$1 WHERE id=$2",[`Re: ${subject}`,log]);
    await reviewCurrent();
    const h=harness({rawDraft:Buffer.from(approvedRaw().replace("Approved subject",subject)).toString("base64url"),parent:{payload:{headers:[
      {name:"Message-ID",value:"<parent@example.invalid>"},{name:"From",value:"recipient@example.invalid"},{name:"Subject",value:subject},
    ]}}});
    expect((await h.handler(request())).status).toBe(200);expect(h.sends).toHaveLength(1);
  });
  it.each([9,11,127])("preserves 7bit body code %s without treating it as non-ASCII",async(code)=>{
    const body=`Approved${String.fromCharCode(code)}body`;
    await db.query("UPDATE purama_ai.email_agent_logs SET ai_response=$1 WHERE id=$2",[body,log]);
    await reviewCurrent();
    const raw=approvedRaw().replace("Approved body",body).replace("charset=UTF-8","charset=us-ascii")
      .replace("MIME-Version:","Content-Transfer-Encoding: 7bit\r\nMIME-Version:");
    const h=harness({rawDraft:Buffer.from(raw).toString("base64url")});
    expect((await h.handler(request())).status).toBe(200);expect(h.sends).toHaveLength(1);
  });
  it.each([128,233])("still rejects body code %s under 7bit",async(code)=>{
    const body=`Approved${String.fromCharCode(code)}body`;
    await db.query("UPDATE purama_ai.email_agent_logs SET ai_response=$1 WHERE id=$2",[body,log]);
    await reviewCurrent();
    const raw=approvedRaw().replace("Approved body",body).replace("MIME-Version:","Content-Transfer-Encoding: 7bit\r\nMIME-Version:");
    const h=harness({rawDraft:Buffer.from(raw).toString("base64url")});
    expect((await h.handler(request())).status).toBe(409);expect(h.sends).toHaveLength(0);
  });
  it("rejects invalid auth, input and methods before reserving",async()=>{
    const h=harness();expect((await h.handler(request({log_id:log},"Bearer wrong"))).status).toBe(401);
    expect((await h.handler(request({log_id:"not-a-uuid"}))).status).toBe(400);expect((await h.handler(request(null))).status).toBe(400);
    expect((await h.handler(new Request("https://example.invalid",{method:"GET"}))).status).toBe(405);
    expect((await h.handler(new Request("https://example.invalid",{method:"OPTIONS"}))).status).toBe(200);
    expect(await state()).toBeUndefined();expect(h.sends).toHaveLength(0);
  });

  it("returns the complete server preview without Gmail access or a send reservation",async()=>{
    const body="Début\n"+"Texte intégral. ".repeat(5000)+"\nFIN NON TRONQUÉE";
    await db.query("UPDATE purama_ai.email_agent_logs SET ai_response=$1,user_approved=NULL,feedback_at=NULL WHERE id=$2",[body,log]);
    const h=harness();const response=await h.handler(request({action:"preview",log_id:log}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok:true,status:"ready",user_id:user,log_id:log,
      payload:{gmail_email:"owner@example.invalid",recipient:"recipient@example.invalid",subject:"Re: Approved subject",body}});
    expect(await state()).toBeUndefined();expect(h.sends).toHaveLength(0);expect(h.profiles).toHaveLength(0);
  });
  it("a legacy boolean or log_id-only POST cannot authorize the new sender",async()=>{
    const h=harness();expect((await h.handler(request({log_id:log,approval_id:null}))).status).toBe(400);
    expect((await db.query<{value:Row}>("SELECT purama_ai.email_agent_send_reserve($1,$2,$3) AS value",[user,log,claim])).rows[0].value)
      .toMatchObject({claimed:false,status:"blocked",reason:"versioned_approval_required"});
    expect(await state()).toBeUndefined();expect(h.sends).toHaveLength(0);
  });
  it("a fetched preview is not approval even when a client writes the old boolean",async()=>{
    const fresh=await mustRpc("email_agent_draft_preview",{p_user_id:user,p_log_id:log});
    await db.query("UPDATE purama_ai.email_agent_logs SET user_approved=true WHERE id=$1",[log]);
    const h=harness();expect((await h.handler(request({log_id:log,approval_id:fresh.approval_id}))).status).toBe(409);
    expect(h.profiles).toHaveLength(0);expect(h.sends).toHaveLength(0);expect(await state()).toBeUndefined();
  });
  it.each(["ai_response","ai_subject","from_email","gmail_message_id","gmail_thread_id","gmail_draft_id"])(
    "refuses a changed %s between preview and approval",async(field)=>{
      const fresh=await mustRpc("email_agent_draft_preview",{p_user_id:user,p_log_id:log});
      await db.query(`UPDATE purama_ai.email_agent_logs SET ${field}=$1 WHERE id=$2`,["changed@example.invalid",log]);
      const h=harness();const response=await h.handler(request({action:"approve",log_id:log,approval_id:fresh.approval_id}));
      expect(response.status).toBe(409);expect(await response.json()).toMatchObject({reason:"stale_approval"});
      expect(h.sends).toHaveLength(0);expect(h.profiles).toHaveLength(0);expect(await state()).toBeUndefined();
    });
  it.each(["gmail_email","gmail_access_token"])("refuses a connection change in %s after preview",async(field)=>{
    const fresh=await mustRpc("email_agent_draft_preview",{p_user_id:user,p_log_id:log});
    await db.query(`UPDATE purama_ai.email_agent_config SET ${field}=$1 WHERE user_id=$2`,["changed@example.invalid",user]);
    const h=harness();expect((await h.handler(request({action:"approve",log_id:log,approval_id:fresh.approval_id}))).status).toBe(409);
    expect(h.sends).toHaveLength(0);expect(await state()).toBeUndefined();
  });
  it("refuses content edited after approval but before the reservation",async()=>{
    await db.query("UPDATE purama_ai.email_agent_logs SET ai_response='Changed after explicit approval' WHERE id=$1",[log]);
    const h=harness();const response=await h.handler(request());
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({reason:"stale_approval"});
    expect(await state()).toBeUndefined();expect(h.profiles).toHaveLength(0);expect(h.sends).toHaveLength(0);
  });
  it("does not overwrite a rejection received while an approval request was waiting",async()=>{
    const fresh=await mustRpc("email_agent_draft_preview",{p_user_id:user,p_log_id:log});
    await db.query("UPDATE purama_ai.email_agent_logs SET user_approved=false,feedback_at=clock_timestamp() WHERE id=$1",[log]);
    const h=harness();expect((await h.handler(request({action:"approve",log_id:log,approval_id:fresh.approval_id}))).status).toBe(409);
    expect((await db.query<{user_approved:boolean}>("SELECT user_approved FROM purama_ai.email_agent_logs WHERE id=$1",[log])).rows[0].user_approved).toBe(false);
    expect(h.sends).toHaveLength(0);
  });
  it("binds preview requests to the account displayed by the client",async()=>{
    const h=harness({authenticated:other});
    for(const action of ["preview","approve","send"]) expect((await h.handler(request({action,log_id:log}))).status).toBe(403);
    expect(await state()).toBeUndefined();expect(h.sends).toHaveLength(0);
  });
  it("does not approve a foreign token or a token belonging to another log",async()=>{
    await insertLog(replacement,user,"incoming-2");
    const wrong=await mustRpc("email_agent_draft_preview",{p_user_id:user,p_log_id:replacement});
    const h=harness();expect((await h.handler(request({action:"approve",log_id:log,approval_id:wrong.approval_id}))).status).toBe(409);
    expect(h.sends).toHaveLength(0);
  });
  it("approves the same preview idempotently without replacing its first feedback",async()=>{
    const fresh=await mustRpc("email_agent_draft_preview",{p_user_id:user,p_log_id:log});
    const h=harness();
    const first=await h.handler(request({action:"approve",log_id:log,approval_id:fresh.approval_id,feedback:"First review"}));
    expect(first.status).toBe(200);expect(await first.json()).toMatchObject({ok:true,status:"approved",approval_id:fresh.approval_id});
    expect((await h.handler(request({action:"approve",log_id:log,approval_id:fresh.approval_id,feedback:"Late feedback"}))).status).toBe(200);
    expect((await db.query<{user_feedback:string}>("SELECT user_feedback FROM purama_ai.email_agent_logs WHERE id=$1",[log])).rows[0].user_feedback).toBe("First review");
    expect(h.sends).toHaveLength(0);
  });
  it.each(["approve","send"])("checks expiry at the %s boundary",async(action)=>{
    await db.query("UPDATE purama_ai.email_agent_draft_previews SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[approvalId]);
    const h=harness();expect((await h.handler(request({action,log_id:log}))).status).toBe(409);
    expect(h.sends).toHaveLength(0);expect(h.profiles).toHaveLength(0);expect(await state()).toBeUndefined();
  });
  it("checks preview expiry again immediately before the send transition",async()=>{
    const h=harness({onProfile:async()=>{await db.query("UPDATE purama_ai.email_agent_draft_previews SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[approvalId]);}});
    expect((await h.handler(request())).status).toBe(409);expect(await state()).toMatchObject({status:"blocked",reason:"versioned_approval_changed"});
    expect(h.sends).toHaveLength(0);
  });
  it("does not replay an old approval after a newer preview was approved",async()=>{
    const prior=approvalId;await reviewCurrent();expect(approvalId).not.toBe(prior);
    const h=harness();expect((await h.handler(request({log_id:log,approval_id:prior}))).status).toBe(409);
    expect((await h.handler(request())).status).toBe(200);expect(h.sends).toHaveLength(1);
  });
  it("does not describe changed current text as sent using a prior receipt",async()=>{
    const h=harness();expect((await h.handler(request())).status).toBe(200);
    await db.query("UPDATE purama_ai.email_agent_logs SET ai_response='A new unapproved text',action_taken='draft' WHERE id=$1",[log]);
    const response=await h.handler(request());expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({reason:"previous_send_differs"});
    expect(h.sends).toHaveLength(1);expect(await count()).toBe(1);
  });
  it("keeps preview records private and blocks service bypass of unversioned helpers",async()=>{
    for(const role of ["anon","authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await expect(db.query("SELECT * FROM purama_ai.email_agent_draft_previews")).rejects.toThrow(/permission denied/i);
        await expect(db.query("SELECT purama_ai.email_agent_draft_approve($1,$2,$3,NULL)",[user,log,approvalId])).rejects.toThrow(/permission denied/i);
      } finally {await db.exec("RESET ROLE");}
    }
    await db.exec("SET ROLE service_role");
    try {
      await expect(db.query("SELECT purama_ai.email_agent_send_reserve_unversioned_internal($1,$2,$3)",[user,log,claim])).rejects.toThrow(/permission denied/i);
      await expect(db.query("SELECT purama_ai.email_agent_send_begin_unversioned_internal($1,$2,$3,NULL,NULL)",[user,log,claim])).rejects.toThrow(/permission denied/i);
    } finally {await db.exec("RESET ROLE");}
  });
});
