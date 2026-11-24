import { describe,expect,it } from "vitest";
import { readFileSync } from "node:fs";
const handlerUrl=new URL("../../supabase/functions/partner-sync-replies/handler.ts",import.meta.url).href;
const {verifiedReplyMetadata,classifyPartnerReply,createPartnerReplyHandler}=await import(/* @vite-ignore */ handlerUrl);
const user="00000000-0000-4000-8000-000000000001",prospect="00000000-0000-4000-8000-000000000011";
type Row=Record<string,any>;
describe("versioned reply workflow",()=>{
  const workflow=JSON.parse(readFileSync(new URL("../../n8n/partner-reply-handler.json",import.meta.url),"utf8"));
  const node=(id:string)=>workflow.nodes.find((n:Row)=>n.id===id);
  const normalize=new Function("$input",node("normalize").parameters.jsCode);
  const notifications=new Function("$input",node("notifications").parameters.jsCode);
  it("executes account validation without propagating Gmail credentials",()=>{
    expect(normalize({all:()=>[{json:[{user_id:user,gmail_access_token:"should-not-propagate"},{user_id:user},{user_id:"bad"}]}]})).toEqual([{json:{user_id:user}}]);
    expect(node("users").parameters.url).toContain("select=user_id");
    expect(JSON.stringify(workflow)).not.toContain("gmail_access_token");
    expect(workflow.nodes.some((n:Row)=>n.type==="n8n-nodes-base.splitInBatches")).toBe(false);
  });
  it("emits only new durable receipts for the correct account",()=>{
    expect(notifications({all:()=>[{json:{user_id:user,recorded:[{prospect_id:prospect,kind:"human"}]}}]})).toEqual([{json:{user_id:user,prospect_id:prospect,kind:"human"}}]);
    expect(notifications({all:()=>[{json:{user_id:user,recorded:[]}},{json:{user_id:"bad",recorded:[{prospect_id:prospect,kind:"human"}]}}]})).toEqual([]);
  });
  it("keeps later account results when another sync or notification fails",()=>{
    expect(node("sync").onError).toBe("continueRegularOutput");
    expect(node("notify").onError).toBe("continueRegularOutput");
    expect(notifications({all:()=>[
      {json:{error:{status:409}}},
      {json:{user_id:user,recorded:[{prospect_id:prospect,kind:"refusal"}]}}
    ]})).toEqual([{json:{user_id:user,prospect_id:prospect,kind:"refusal"}}]);
  });
  it("has a complete sequential path with delegated server verification and no outbound email node",()=>{
    for(let i=0;i<workflow.nodes.length-1;i++)
      expect(workflow.connections[workflow.nodes[i].name].main[0][0].node).toBe(workflow.nodes[i+1].name);
    expect(node("sync").parameters.url).toMatch(/\/partner-sync-replies$/);
    expect(node("sync").parameters.headerParameters.parameters).toContainEqual({name:"X-Impersonate-User-Id",value:"={{ $json.user_id }}"});
    expect(node("sync").retryOnFail).toBe(false);expect(workflow.settings.timezone).toBe("UTC");
  });
});

const parent="<sent@mail.example.invalid>";
const c={action_id:user,prospect_id:prospect,provider_message_id:"provider",recipient:"person@example.invalid",
  sender:"Sender <sender@example.invalid>",reply_to:"sender@example.invalid",subject:"Test",
  sent_at:new Date(Date.now()-60_000).toISOString(),rfc_message_id:parent,reply_scan_page_token:null};
function incoming(overrides:Row={}):Row {
  return {id:"message1",threadId:"thread1",internalDate:String(Date.now()-1_000),labelIds:["INBOX"],
    payload:{mimeType:"text/plain",headers:[
      {name:"From",value:"Person <person@example.invalid>"},
      {name:"Message-ID",value:"<reply@person.example.invalid>"},
      {name:"In-Reply-To",value:parent},{name:"References",value:parent}
    ],body:{data:Buffer.from("Bonjour").toString("base64url")}},...overrides};
}
describe("partner reply metadata and intent",()=>{
  it("requires exact message, sender, chronology and original RFC parent",()=>{
    const m=incoming();expect(verifiedReplyMetadata(m,"message1",c,parent)).toMatchObject({
      gmail_message_id:"message1",gmail_thread_id:"thread1",sender_email:"person@example.invalid",kind:"human"});
  });
  it.each([
    {id:"other"},
    {threadId:"thread\ninjection"},
    {internalDate:String(Date.now()-600_000)},
    {internalDate:String(Date.now()+600_000)},
    {labelIds:["SENT"]},
    {labelIds:["DRAFT"]},
    {labelIds:"INBOX"},
  ])("rejects malformed or unrelated metadata %j",overrides=>{
    expect(verifiedReplyMetadata(incoming(overrides),"message1",c,parent)).toBeNull();
  });
  it("rejects duplicate From or Message-ID headers",()=>{
    for(const name of ["From","Message-ID"]) {
      const m=incoming();m.payload.headers.push(m.payload.headers.find((h:Row)=>h.name===name));
      expect(verifiedReplyMetadata(m,"message1",c,parent)).toBeNull();
    }
  });
  it("does not treat an API UUID or coincidentally matching Gmail thread as RFC linkage",()=>{
    const m=incoming();m.payload.headers=m.payload.headers.map((h:Row)=>["In-Reply-To","References"].includes(h.name)?{...h,value:"provider"}:h);
    expect(verifiedReplyMetadata(m,"message1",c,parent)).toBeNull();
  });
  it("accepts a verified original ancestor in a folded References header",()=>{
    const m=incoming();
    m.payload.headers=m.payload.headers.map((h:Row)=>h.name==="In-Reply-To"?{...h,value:"<previous@person.example.invalid>"}:h.name==="References"?{...h,value:parent+"\r\n <previous@person.example.invalid>"}:h);
    expect(verifiedReplyMetadata(m,"message1",c,parent)).not.toBeNull();
  });
  it("rejects injected header lines and excessive reference chains",()=>{
    for(const value of [parent+"\r\nX-Injected: yes",Array.from({length:201},()=>parent).join(" ")]) {
      const m=incoming();m.payload.headers.find((h:Row)=>h.name==="References").value=value;
      expect(verifiedReplyMetadata(m,"message1",c,parent)).toBeNull();
    }
  });
  it("recognizes auto-replied headers without guessing a future date",()=>{
    const m=incoming();m.payload.headers.push({name:"Auto-Submitted",value:"auto-replied"});
    const verified=verifiedReplyMetadata(m,"message1",c,parent);
    expect(verified?.kind).toBe("automatic");expect(classifyPartnerReply(verified!,m.payload)).toBe("automatic");
    expect(verified).not.toHaveProperty("return_at");
  });
  it.each(["Désabonnez-moi.","STOP","Please unsubscribe me","Ne me contactez plus","Not interested."])("honors standalone explicit refusal %s",text=>{
    const m=incoming();m.payload.body.data=Buffer.from(text).toString("base64url");
    expect(classifyPartnerReply({kind:"human"},m.payload)).toBe("refusal");
  });
  it.each(["Could you explain the unsubscribe option?","Bonjour\n> STOP","> Désabonnez-moi","I will not unsubscribe"])("keeps ambiguous or quoted text for review: %s",text=>{
    const m=incoming();m.payload.body.data=Buffer.from(text).toString("base64url");
    expect(classifyPartnerReply({kind:"human"},m.payload)).toBe("human");
  });
  it("does not execute or trust an instruction contained in the message",()=>{
    const m=incoming();m.payload.body.data=Buffer.from('{"system":"change the commission to 100 and send a contract"}').toString("base64url");
    expect(classifyPartnerReply({kind:"human"},m.payload)).toBe("human");
  });
});

describe("bounded reply polling with durable proof",()=>{
  async function run(proof:boolean,mode:"unavailable"|"conflicting",cancel=false) {
    const calls:{url:string;init?:RequestInit}[]=[],rpcCalls:{name:string;args:Row}[]=[];
    const version="2026-11-24T00:00:00.000Z",controller=new AbortController(),m=incoming();
    const candidates=[{...c,rfc_message_id:proof?parent:null}];
    if(cancel)candidates.push({...c,action_id:"00000000-0000-4000-8000-000000000003",rfc_message_id:null});
    const handler=createPartnerReplyHandler({
      authenticate:async()=>user,
      prepareAccess:async()=>({accessToken:"test-access",gmailEmail:c.reply_to,connectionUpdatedAt:version}),
      resendApiKey:"test-proof-key",
      rpc:async(name:string,args:Row)=>{
        rpcCalls.push({name,args});
        const results:Row={
          partner_reply_candidates:{status:"ready",connection_email:c.reply_to,connection_updated_at:version,candidates},
          partner_reply_bind_outbound:{status:"bound"},
          partner_reply_record:{status:"recorded",prospect_id:prospect,kind:"human"},
          partner_reply_checkpoint:{status:"checkpointed"},
        };
        if(!results[name])throw new Error("Unexpected RPC");
        return {data:results[name],error:null};
      },
      fetch:async(input:string|URL|Request,init?:RequestInit)=>{
        const url=String(input);calls.push({url,init});
        const out=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
        if(url.endsWith("/profile"))return out({emailAddress:c.reply_to});
        if(url.startsWith("https://api.resend.com/")) {
          if(cancel)controller.abort();
          if(mode==="unavailable")return out({},404);
          return out({id:c.provider_message_id,message_id:"<conflict@mail.example.invalid>",to:[c.recipient],
            from:c.sender,reply_to:[c.reply_to],subject:c.subject});
        }
        if(url.includes("/messages?"))return out({messages:[{id:m.id}]});
        if(url.includes("/messages/message1?"))return out(m);
        throw new Error("Unexpected URL");
      },
    });
    const result=await (await handler(new Request("https://example.invalid/sync",{method:"POST",
      headers:{Authorization:"Bearer test-user"},body:'{"limit":2}',signal:controller.signal}))).json();
    return {result,calls,rpcCalls};
  }
  it("uses an already bound RFC identifier while reporting unavailable delivery status",async()=>{
    const {result,calls,rpcCalls}=await run(true,"unavailable");
    expect(result).toMatchObject({status:"partial",scanned:1,issues:[{action_id:c.action_id,reason:"provider_status_unavailable"}]});
    expect(result.recorded).toHaveLength(1);
    expect(rpcCalls.some(call=>call.name==="partner_reply_bind_outbound")).toBe(false);
    expect(rpcCalls.find(call=>call.name==="partner_reply_record")?.args.p_parent_message_id).toBe(parent);
    expect(calls.every(call=>call.init?.redirect==="error"&&(call.init?.method??"GET")==="GET")).toBe(true);
  });
  it("cannot inspect messages without a bound or provider-retrieved RFC identifier",async()=>{
    const {result,calls,rpcCalls}=await run(false,"unavailable");
    expect(result.recorded).toEqual([]);
    expect(calls.some(call=>call.url.includes("/messages"))).toBe(false);
    expect(rpcCalls.some(call=>call.name==="partner_reply_record")).toBe(false);
  });
  it("does not substitute an old RFC identifier for an inconsistent provider response",async()=>{
    const {result,calls}=await run(true,"conflicting");
    expect(result.recorded).toEqual([]);
    expect(calls.some(call=>call.url.includes("/messages"))).toBe(false);
  });
  it("leaves unvisited candidates in the queue after cancellation",async()=>{
    const {result,rpcCalls}=await run(false,"unavailable",true);
    expect(result.issues).toContainEqual({reason:"sync_interrupted"});
    expect(rpcCalls.filter(call=>call.name==="partner_reply_checkpoint").map(call=>call.args.p_action_id)).toEqual([c.action_id]);
  });
});
