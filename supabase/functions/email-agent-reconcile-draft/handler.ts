// This endpoint can confirm an existing message in Gmail. It never sends mail,
// deletes a reservation, or converts an uncertain outcome into retry permission.
import { read, readApprovedParent, verifyApprovedMessageRaw } from "../email-agent-send-draft/draft-snapshot.ts";
import type { DraftSenderDependencies } from "../email-agent-send-draft/handler.ts";
import { hasAsciiControl } from "../email-agent-send-draft/text-guards.ts";
type Row = Record<string, unknown>;
type Dependencies = Pick<DraftSenderDependencies, "authenticate" | "rpc" | "prepareAccess" | "fetch">;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opaqueId = /^[A-Za-z0-9_-]{1,512}$/;
const mailbox = /^[^\s@<>,;:]+@[^\s@<>,;:]+\.[^\s@<>,;:]+$/;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders,
    "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function result(value: Row, providerCheckPerformed = false): Response {
  if(value.status==="sent" && typeof value.provider_message_id==="string"
    && opaqueId.test(value.provider_message_id) && typeof value.matches_current_preview==="boolean") {
    return json({ok:true,status:"sent",action_id:value.action_id,provider_message_id:value.provider_message_id,
      reconciled:true,matches_current_preview:value.matches_current_preview,
      provider_check_performed:providerCheckPerformed},200);
  }
  return json({ok:false,status:value.status??"unknown",reason:value.reason??"provider_evidence_unverified",
    action_id:value.action_id},409);
}
async function input(req: Request): Promise<Row> {
  if(!req.body) throw new Error("Missing request body");
  const reader=req.body.getReader(), chunks:Uint8Array[]=[];
  const signal=AbortSignal.any([req.signal,AbortSignal.timeout(5000)]);
  let onAbort=()=>{};
  const aborted=new Promise<never>((_resolve,reject)=>{
    onAbort=()=>{
      // A remote stream's cancellation promise need not settle. Releasing this
      // route must not wait for that acknowledgement.
      void reader.cancel().catch(()=>{});
      reject(new Error("Request body interrupted"));
    };
    if(signal.aborted) onAbort();
    else signal.addEventListener("abort",onAbort,{once:true});
  });
  let size=0;
  try {
    while(true) {
      const part=await Promise.race([reader.read(),aborted]);
      if(signal.aborted) throw new Error("Request body interrupted");
      if(part.done) break;
      size+=part.value.byteLength;
      if(size>4096) {void reader.cancel().catch(()=>{});throw new Error("Request body too large");}
      chunks.push(part.value);
    }
  } finally {signal.removeEventListener("abort",onAbort);reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const data:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  if(!data||typeof data!=="object"||Array.isArray(data)) throw new Error("Invalid request body");
  return data as Row;
}
async function rawHash(raw: string): Promise<string> {
  const value=raw.replace(/-/g,"+").replace(/_/g,"/");
  const binary=atob(value.padEnd(Math.ceil(value.length/4)*4,"="));
  const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}

export function createDraftReconciler(deps: Dependencies): (req: Request) => Promise<Response> {
  return async req => {
    if(req.method==="OPTIONS") return new Response(null,{headers:corsHeaders});
    if(req.method!=="POST") return json({error:"Method not allowed"},405);
    const auth=req.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
    if(!auth) return json({error:"Unauthorized"},401);
    let userId:string|null;
    try{userId=await deps.authenticate(auth[1]);}catch{return json({error:"Authentication unavailable"},503);}
    if(!userId||!uuid.test(userId)) return json({error:"Unauthorized"},401);
    let request:Row;
    try{request=await input(req);}catch{return json({error:"Invalid request body"},400);}
    if(typeof request.log_id!=="string"||!uuid.test(request.log_id)
      ||Object.keys(request).some(key=>key!=="log_id")) return json({error:"Valid log_id required"},400);
    const call=async(name:string,args:Row):Promise<Row>=>{
      const response=await deps.rpc(name,args);
      if(response.error||!response.data) throw new Error("Reconciliation storage unavailable");
      return response.data;
    };
    let context:Row;
    try{context=await call("email_agent_reconcile_context",{p_user_id:userId,p_log_id:request.log_id});}
    catch{return json({error:"Reconciliation storage unavailable",status:"unknown"},503);}
    if(context.status==="sent"||context.eligible!==true) return result(context);
    if(typeof context.action_id!=="string"||!uuid.test(context.action_id)
      ||!context.payload||typeof context.payload!=="object"||Array.isArray(context.payload)
      ||typeof context.dispatch_updated_at!=="string"||typeof context.dispatch_started_at!=="string") {
      return json({error:"Invalid durable context",status:"unknown"},503);
    }
    const payload=context.payload as Row;
    const unresolved=(reason:string)=>result({status:"unknown",action_id:context.action_id,reason});
    const budget=AbortSignal.any([AbortSignal.timeout(60_000),req.signal]);
    const readOnlyFetch:typeof fetch=(url,init)=>{
      if(init?.method&&init.method!=="GET") throw new Error("Reconciliation is read only at Gmail");
      return deps.fetch(url,{...init,method:"GET",signal:AbortSignal.any([budget,...(init?.signal?[init.signal]:[])])});
    };
    let access:Awaited<ReturnType<Dependencies["prepareAccess"]>>;
    let selected:{id:string;raw:string;internalDate:number}|undefined;
    try {
      access=await deps.prepareAccess(userId);
      if(!access.accessToken||hasAsciiControl(access.gmailEmail)||!mailbox.test(access.gmailEmail)
        ||!Number.isFinite(Date.parse(access.connectionUpdatedAt))||payload.gmail_email!==access.gmailEmail) {
        return unresolved("gmail_connection_changed");
      }
      const profile=await read(readOnlyFetch,access.accessToken,"https://gmail.googleapis.com/gmail/v1/users/me/profile",32_000);
      if(typeof profile.emailAddress!=="string"||profile.emailAddress.toLowerCase()!==access.gmailEmail.toLowerCase()) {
        return unresolved("gmail_identity_mismatch");
      }
      const parent=await readApprovedParent(readOnlyFetch,access.accessToken,payload);
      let ids:string[];
      const known=typeof context.provider_message_id==="string"&&opaqueId.test(context.provider_message_id);
      if(context.provider_message_id!=null&&!known) return unresolved("invalid_known_receipt");
      if(known) ids=[context.provider_message_id as string];
      else {
        const thread=await read(readOnlyFetch,access.accessToken,
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(parent.threadId)}?format=minimal`,128_000);
        if(thread.id!==parent.threadId||!Array.isArray(thread.messages)) return unresolved("thread_evidence_incomplete");
        ids=[];
        for(const candidate of thread.messages as Row[]) {
          if(!candidate||typeof candidate.id!=="string"||!opaqueId.test(candidate.id)
            ||candidate.threadId!=null&&candidate.threadId!==parent.threadId
            ||!Array.isArray(candidate.labelIds)) return unresolved("thread_evidence_incomplete");
          if(candidate.labelIds.includes("SENT")&&!candidate.labelIds.includes("DRAFT")&&candidate.id!==payload.gmail_message_id) ids.push(candidate.id);
        }
        ids=[...new Set(ids)];
        if(ids.length>5) return unresolved("thread_evidence_limit");
      }
      for(const id of ids) {
        const message=await read(readOnlyFetch,access.accessToken,
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=raw`,2_100_000);
        if(message.id!==id||message.threadId!==parent.threadId||!Array.isArray(message.labelIds)
          ||!message.labelIds.includes("SENT")||message.labelIds.includes("DRAFT")||typeof message.raw!=="string"
          ||typeof message.internalDate!=="string"||!/^\d{1,16}$/.test(message.internalDate)) continue;
        const internalDate=Number(message.internalDate), started=Date.parse(context.dispatch_started_at as string);
        if(!Number.isSafeInteger(internalDate)||internalDate<=0||!Number.isFinite(started)
          ||internalDate>Date.now()+300_000||!known&&internalDate<started-5000) continue;
        try{verifyApprovedMessageRaw(message.raw,payload,access.gmailEmail,parent.rfcId,true);}catch{continue;}
        if(selected) return unresolved("multiple_matching_sent_messages");
        selected={id,raw:message.raw,internalDate};
      }
    } catch {
      return json({ok:false,status:"unknown",reason:"gmail_evidence_unavailable",action_id:context.action_id},503);
    }
    if(!selected) return unresolved("no_verified_sent_message");
    try {
      const completed=await call("email_agent_reconcile_finish",{
        p_user_id:userId,p_action_id:context.action_id,p_dispatch_updated_at:context.dispatch_updated_at,
        p_connection_email:access.gmailEmail,p_connection_updated_at:access.connectionUpdatedAt,
        p_provider_message_id:selected.id,p_raw_sha256:await rawHash(selected.raw),
        p_provider_internal_date_ms:selected.internalDate,
      });
      return result(completed,true);
    } catch {
      return unresolved("reconciliation_not_persisted");
    }
  };
}
