import { readBoundedBytes, readRequestText, RequestBodyError } from "../_shared/request-body.ts";
import type { DraftSenderDependencies } from "../email-agent-send-draft/handler.ts";

type Row = Record<string, unknown>;
type Candidate = {
  action_id: string; prospect_id: string; provider_message_id: string; recipient: string;
  sender: string; reply_to: string; subject: string; sent_at: string;
  rfc_message_id: string | null; reply_scan_page_token: string | null;
};
export type PartnerReplyDependencies = Pick<DraftSenderDependencies, "authenticate" | "prepareAccess" | "rpc" | "fetch"> & {
  authenticateScheduled?: (token: string, userId: string) => Promise<boolean> | boolean;
  resendApiKey: string;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opaque=/^[A-Za-z0-9_-]{1,512}$/;
const email=/^[^\s@<>,;:]+@[^\s@<>,;:]+\.[^\s@<>,;:]+$/;
const rfc=/^<[^<>\s@]+@[^<>\s@]+>$/;
const controls=/[\x00-\x1f\x7f]/;
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const object=(v:unknown):Row|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:null;
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json","Cache-Control":"no-store"}});
function address(value:unknown):string|null {
  if(typeof value!=="string"||value.length>998||controls.test(value)) return null;
  const text=value.trim();
  if(email.test(text)) return text.toLowerCase();
  const match=text.match(/^(?:"[^"]*"|[^<>"@,;]+)?\s*<([^<>]+)>$/);
  return match&&email.test(match[1])?match[1].toLowerCase():null;
}
function validRfc(value:unknown):value is string {
  return typeof value==="string"&&value.length<=900&&!controls.test(value)&&rfc.test(value);
}
function header(headers:unknown,name:string,required=false):string|null {
  if(!Array.isArray(headers)||headers.length>200) return null;
  const matches=headers.filter(h=>object(h)?.name&&typeof h.name==="string"&&h.name.toLowerCase()===name);
  if(matches.length>1||required&&matches.length!==1) return null;
  if(matches.length===0) return "";
  const value=matches[0].value;
  if(typeof value!=="string"||value.length>16_384||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return null;
  // RFC folding is accepted only as CRLF followed by whitespace.
  const unfolded=value.replace(/\r\n[ \t]+/g," ");
  return /[\r\n]/.test(unfolded)?null:unfolded.trim();
}
function candidate(value:unknown):Candidate|null {
  const c=object(value);
  if(!c||typeof c.action_id!=="string"||!uuid.test(c.action_id)||typeof c.prospect_id!=="string"||!uuid.test(c.prospect_id)
    ||typeof c.provider_message_id!=="string"||!opaque.test(c.provider_message_id)
    ||!address(c.recipient)||!address(c.sender)||!address(c.reply_to)
    ||typeof c.subject!=="string"||controls.test(c.subject)||typeof c.sent_at!=="string"||!Number.isFinite(Date.parse(c.sent_at))
    ||c.rfc_message_id!==null&&!validRfc(c.rfc_message_id)
    ||c.reply_scan_page_token!==null&&(typeof c.reply_scan_page_token!=="string"||c.reply_scan_page_token.length>2048||controls.test(c.reply_scan_page_token))) return null;
  return c as Candidate;
}
export function verifiedReplyMetadata(message:unknown,expectedId:string,c:Candidate,parentRfc:string):Row|null {
  const m=object(message),payload=object(m?.payload);
  if(!m||m.id!==expectedId||typeof m.threadId!=="string"||!opaque.test(m.threadId)||!payload
    ||!Array.isArray(m.labelIds)||m.labelIds.some(v=>typeof v!=="string")||m.labelIds.includes("SENT")||m.labelIds.includes("DRAFT")
    ||typeof m.internalDate!=="string"||!/^\d{1,16}$/.test(m.internalDate)) return null;
  const received=Number(m.internalDate);
  if(!Number.isSafeInteger(received)||received<Date.parse(c.sent_at)||received>Date.now()+300_000) return null;
  const from=header(payload.headers,"from",true);
  const msgId=header(payload.headers,"message-id",true);
  const inReplyTo=header(payload.headers,"in-reply-to");
  const refs=header(payload.headers,"references");
  const auto=header(payload.headers,"auto-submitted");
  if(from===null||address(from)!==address(c.recipient)||!validRfc(msgId)||msgId===parentRfc
    ||inReplyTo===null||refs===null||auto===null) return null;
  const parents=(inReplyTo+" "+refs).split(/\s+/).filter(Boolean);
  if(parents.length>200||parents.some(v=>!validRfc(v))||!parents.includes(parentRfc)) return null;
  return {gmail_message_id:expectedId,gmail_thread_id:m.threadId,rfc_message_id:msgId,
    sender_email:address(from),received_at:new Date(received).toISOString(),
    kind:auto&&auto.toLowerCase()!=="no"?"automatic":"human"};
}
function textPart(payload:unknown,depth=0,budget={parts:0}):string {
  const p=object(payload);
  if(!p||depth>8||++budget.parts>100) return "";
  if(p.mimeType==="text/plain") {
    const data=object(p.body)?.data;
    if(typeof data!=="string"||data.length>32_768||!/^[A-Za-z0-9_-]*={0,2}$/.test(data)||data.length%4===1) return "";
    try {
      const binary=atob(data.replace(/-/g,"+").replace(/_/g,"/"));
      return new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0))).slice(0,16_000);
    } catch {return "";}
  }
  if(Array.isArray(p.parts)) for(const child of p.parts) {
    const found=textPart(child,depth+1,budget);if(found) return found;
  }
  return "";
}
export function classifyPartnerReply(metadata:Row,payload:unknown):"human"|"refusal"|"automatic" {
  if(metadata.kind==="automatic") return "automatic";
  // Only an explicit, standalone first line changes suppression. Ambiguous
  // messages remain human replies and still stop the generic follow-up sequence.
  const first=textPart(payload).split(/\r?\n/).find(line=>line.trim())?.trim()??"";
  const refusal=/^(?:(?:please\s+)?(?:unsubscribe(?:\s+me)?|remove\s+me(?:\s+from\s+(?:your|this)\s+(?:list|mailing list))?|do not (?:contact|email) me(?: again)?|stop(?: emailing me| contacting me)?|not interested|no thanks)|d[ée]sabonnez[- ]moi|ne me (?:contactez|[ée]crivez) plus|retirez[- ]moi de (?:votre|cette) liste|non merci|pas int[ée]ress[ée])[.! ]*$/i;
  return refusal.test(first)?"refusal":"human";
}
class ProviderReadError extends Error {
  constructor(readonly status:number) {super("Provider read unavailable");}
}
async function getJson(deps:PartnerReplyDependencies,url:string,token:string,limit:number,signal:AbortSignal,deadline:number):Promise<Row> {
  if(signal.aborted||performance.now()>=deadline) throw new Error("Reply sync deadline");
  const response=await deps.fetch(url,{headers:{Authorization:"Bearer "+token},signal,redirect:"error"});
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new ProviderReadError(response.status);}
  const bytes=await readBoundedBytes({body:response.body,headers:response.headers,signal},
    {maxBytes:limit,deadline:Math.min(deadline,performance.now()+5_000),matchContentLength:false});
  const result=object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));
  if(!result)throw new Error("Invalid provider response");
  return result;
}

/** Read-only provider polling. The only effects are tenant-scoped durable receipts. */
export function createPartnerReplyHandler(deps:PartnerReplyDependencies) {
  return async(req:Request):Promise<Response>=>{
    if(req.method==="OPTIONS")return new Response(null,{headers:cors});
    if(req.method!=="POST")return json({error:"Method not allowed"},405);
    let userId:string;
    try {
      const auth=req.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
      if(!auth)return json({error:"Unauthorized"},401);
      const delegated=req.headers.get("X-Impersonate-User-Id");
      const identity=delegated!==null
        ? uuid.test(delegated)&&await deps.authenticateScheduled?.(auth[1],delegated)?delegated:null
        : await deps.authenticate(auth[1]);
      if(!identity||!uuid.test(identity))return json({error:"Unauthorized"},401);
      userId=identity;
    }catch{return json({error:"Unauthorized"},401);}
    let body:Row|null;
    try {body=object(JSON.parse(await readRequestText(req,{maxBytes:2048,timeoutMs:3000}))); }
    catch(e){return json({error:"Invalid request"},e instanceof RequestBodyError?e.status:400);}
    if(!body||Object.keys(body).some(k=>k!=="limit")||body.limit!==undefined&&(!Number.isInteger(body.limit)||Number(body.limit)<1||Number(body.limit)>10))
      return json({error:"Invalid request"},400);
    const call=async(name:string,args:Row):Promise<Row>=>{
      const result=await deps.rpc(name,args);const value=object(result.data);
      if(result.error||!value)throw new Error("Reply storage unavailable");return value;
    };
    let context:Row,access:Awaited<ReturnType<PartnerReplyDependencies["prepareAccess"]>>;
    try {
      context=await call("partner_reply_candidates",{p_user_id:userId,p_limit:body.limit??5});
      if(context.status!=="ready")return json({ok:false,status:"blocked",reason:context.reason},409);
      if(!Array.isArray(context.candidates)||context.candidates.length>10)throw new Error("Invalid reply candidates");
      if(context.candidates.length===0)return json({ok:true,status:"completed",user_id:userId,recorded:[],scanned:0,issues:[]});
      access=await deps.prepareAccess(userId);
      if(address(access.gmailEmail)!==address(context.connection_email)||!access.accessToken
        ||Date.parse(access.connectionUpdatedAt)!==Date.parse(String(context.connection_updated_at))
        ||!Number.isFinite(Date.parse(access.connectionUpdatedAt)))throw new Error("Connection changed");
    }catch{return json({ok:false,status:"blocked",reason:"reply_context_unavailable"},503);}
    const deadline=performance.now()+45_000;
    const signal=AbortSignal.any([req.signal,AbortSignal.timeout(45_000)]);
    try {
      const profile=await getJson(deps,"https://gmail.googleapis.com/gmail/v1/users/me/profile",access.accessToken,64_000,signal,deadline);
      if(address(profile.emailAddress)!==address(access.gmailEmail))throw new Error("Mailbox mismatch");
    }catch{return json({ok:false,status:"blocked",reason:"mailbox_identity_unverified"},409);}
    const connection={p_user_id:userId,p_connection_email:access.gmailEmail,p_connection_updated_at:access.connectionUpdatedAt};
    const recorded:Row[]=[],issues:Row[]=[];let scanned=0;
    for(const raw of context.candidates as unknown[]) {
      if(signal.aborted||performance.now()>=deadline) {
        // Unvisited candidates keep their place for the next bounded run.
        issues.push({reason:"sync_interrupted"});break;
      }
      const c=candidate(raw);
      if(!c){
        const invalid=object(raw);
        if(typeof invalid?.action_id==="string"&&uuid.test(invalid.action_id)
          &&(invalid.reply_scan_page_token===null||typeof invalid.reply_scan_page_token==="string"
            &&invalid.reply_scan_page_token.length<=2048&&!controls.test(invalid.reply_scan_page_token))) {
          try {await call("partner_reply_checkpoint",{...connection,p_action_id:invalid.action_id,
            p_expected_page_token:invalid.reply_scan_page_token,p_next_page_token:invalid.reply_scan_page_token});}
          catch { /* Invalid candidates remain explicitly reported. */ }
        }
        issues.push({reason:"invalid_candidate"});continue;
      }
      const common={...connection,p_action_id:c.action_id};
      try {
        if(signal.aborted||performance.now()>=deadline)throw new Error("Reply sync deadline");
        if(address(c.reply_to)!==address(access.gmailEmail))throw new Error("Reply mailbox mismatch");
        let sent:Row|null=null;
        try {
          if(!deps.resendApiKey)throw new Error("Provider proof unavailable");
          sent=await getJson(deps,"https://api.resend.com/emails/"+encodeURIComponent(c.provider_message_id),deps.resendApiKey,256_000,signal,deadline);
        }catch {
          if(c.rfc_message_id===null)throw new Error("Provider proof unavailable");
          // An immutable previously verified RFC ID remains usable for Gmail
          // replies. A provider outage must not erase that durable evidence.
          // Delivery status is explicitly incomplete until Resend is readable.
          issues.push({action_id:c.action_id,reason:"provider_status_unavailable"});
        }
        let parent=c.rfc_message_id;
        if(sent) {
          if(sent.id!==c.provider_message_id||!validRfc(sent.message_id)
            ||!Array.isArray(sent.to)||sent.to.length!==1||address(sent.to[0])!==address(c.recipient)
            ||address(sent.from)!==address(c.sender)||sent.subject!==c.subject
            ||!Array.isArray(sent.reply_to)||sent.reply_to.length!==1||address(sent.reply_to[0])!==address(c.reply_to)
            ||parent!==null&&parent!==sent.message_id)throw new Error("Outbound proof mismatch");
          parent=sent.message_id;
          const bound=await call("partner_reply_bind_outbound",{...common,
            p_provider_message_id:c.provider_message_id,p_rfc_message_id:parent,
            p_provider_event:typeof sent.last_event==="string"?sent.last_event:null});
          if(bound.status==="suppressed") {
            if(bound.changed===true)recorded.push({prospect_id:c.prospect_id,kind:"delivery_failure",reason:bound.reason});
            scanned++;continue;
          }
          if(bound.status!=="bound")throw new Error("Outbound binding refused");
        }
        if(!parent)throw new Error("Outbound proof unavailable");
        const query=new URLSearchParams({q:"from:"+address(c.recipient)+" after:"+Math.max(0,Math.floor(Date.parse(c.sent_at)/1000)-1),
          maxResults:"20",includeSpamTrash:"true"});
        if(c.reply_scan_page_token)query.set("pageToken",c.reply_scan_page_token);
        let page:Row;
        try {page=await getJson(deps,"https://gmail.googleapis.com/gmail/v1/users/me/messages?"+query,access.accessToken,64_000,signal,deadline);}
        catch(e) {
          if(c.reply_scan_page_token&&e instanceof ProviderReadError&&e.status===400)
            await call("partner_reply_checkpoint",{...common,p_expected_page_token:c.reply_scan_page_token,p_next_page_token:null});
          throw e;
        }
        const messages=page.messages??[];
        const next=page.nextPageToken??null;
        if(!Array.isArray(messages)||messages.length>20||next!==null&&(typeof next!=="string"||next.length>2048||controls.test(next)))
          throw new Error("Invalid Gmail page");
        const seen=new Set<string>();
        for(const rawMessage of messages) {
          const item=object(rawMessage);
          if(typeof item?.id!=="string"||!opaque.test(item.id))throw new Error("Invalid message identity");
          if(seen.has(item.id))continue;seen.add(item.id);
          const messageUrl="https://gmail.googleapis.com/gmail/v1/users/me/messages/"+encodeURIComponent(item.id);
          const meta=await getJson(deps,messageUrl+"?format=metadata&metadataHeaders=From&metadataHeaders=Message-ID&metadataHeaders=In-Reply-To&metadataHeaders=References&metadataHeaders=Auto-Submitted",access.accessToken,128_000,signal,deadline);
          let verified=verifiedReplyMetadata(meta,item.id,c,parent);
          if(!verified)continue;
          let kind:"human"|"refusal"|"automatic"="automatic";
          if(verified.kind!=="automatic") {
            const full=await getJson(deps,messageUrl+"?format=full",access.accessToken,2_100_000,signal,deadline);
            const fullVerified=verifiedReplyMetadata(full,item.id,c,parent);
            if(!fullVerified||fullVerified.gmail_thread_id!==verified.gmail_thread_id||fullVerified.rfc_message_id!==verified.rfc_message_id)
              throw new Error("Reply changed during read");
            verified=fullVerified;kind=classifyPartnerReply(verified,full.payload);
          }
          const receipt=await call("partner_reply_record",{...common,p_gmail_message_id:verified.gmail_message_id,
            p_gmail_thread_id:verified.gmail_thread_id,p_rfc_message_id:verified.rfc_message_id,
            p_sender_email:verified.sender_email,p_received_at:verified.received_at,p_parent_message_id:parent,p_kind:kind});
          if(receipt.status==="recorded")recorded.push(receipt);
          else if(receipt.status!=="duplicate")throw new Error("Reply receipt refused");
        }
        const checkpoint=await call("partner_reply_checkpoint",{...common,
          p_expected_page_token:c.reply_scan_page_token,p_next_page_token:next});
        if(checkpoint.status!=="checkpointed")throw new Error("Reply cursor changed");
        scanned++;
      }catch{
        // Rotate a failed verification attempt without declaring any message
        // received or advancing past an unprocessed page. Old unresolvable
        // provider proofs must not starve all later conversations.
        try {await call("partner_reply_checkpoint",{...common,
          p_expected_page_token:c.reply_scan_page_token,p_next_page_token:c.reply_scan_page_token});}
        catch { /* The reported partial result remains visible; no provider send. */ }
        issues.push({action_id:c.action_id,reason:signal.aborted?"sync_interrupted":"reply_verification_incomplete"});
      }
    }
    return json({ok:issues.length===0,status:issues.length?"partial":"completed",user_id:userId,recorded,scanned,issues},issues.length?207:200);
  };
}
