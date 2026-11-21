// Deliberately narrow MIME acceptance: simple UTF-8 text only. Unsupported
// drafts remain unsent for review; no attachment or recipient is discarded.
type Row = Record<string, unknown>;
type HeadersMap = Map<string, string[]>;
const opaqueId = /^[A-Za-z0-9_-]{1,512}$/;
const email = /^[^\s@<>,;:\x00-\x1f\x7f]+@[^\s@<>,;:\x00-\x1f\x7f]+\.[^\s@<>,;:\x00-\x1f\x7f]+$/;
const messageId = /^<[^<>\s@\x00-\x1f\x7f]+@[^<>\s@\x00-\x1f\x7f]+>$/;
function fail(): never { throw new Error("draft_content_unverified"); }
const utf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

function base64Bytes(value: string, url: boolean): Uint8Array {
  if (value.length > 2_000_000 || !(url ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/).test(value)
    || value.length % 4 === 1 || value.includes("=") && value.length % 4 !== 0) fail();
  const unpadded = value.replace(/=+$/, "");
  const normalized = (url ? unpadded.replace(/-/g,"+").replace(/_/g,"/") : unpadded);
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  // Reject nonzero unused bits and other noncanonical representations.
  if (btoa(binary).replace(/=+$/, "") !== normalized) fail();
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function quotedPrintable(value: string, encodedWord = false): string {
  const source = encodedWord ? value.replace(/_/g," ") : value.replace(/=\n/g,"");
  const bytes: number[] = [];
  for (let i=0; i<source.length; i++) {
    if (source[i] === "=") {
      if (!/^[0-9a-f]{2}$/i.test(source.slice(i+1,i+3))) fail();
      bytes.push(parseInt(source.slice(i+1,i+3),16)); i+=2;
    } else {
      const code=source.charCodeAt(i); if(code>127) fail(); bytes.push(code);
    }
  }
  return utf8(Uint8Array.from(bytes));
}
function decodeHeader(value: string): string {
  const decoded = value.replace(/(\?=)[ \t]+(?==\?)/g,"$1")
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_match, charset: string, mode: string, text: string) => {
      if (!/^(utf-8|us-ascii)$/i.test(charset)) fail();
      const word=mode.toLowerCase()==="b" ? utf8(base64Bytes(text,false)) : quotedPrintable(text,true);
      if(charset.toLowerCase()==="us-ascii" && /[^\x00-\x7f]/.test(word)) fail();
      return word;
    });
  if (decoded.includes("=?") || /[\r\n\x00]/.test(decoded)) fail();
  return decoded;
}
function one(headers: HeadersMap, name: string, required = true): string {
  const values=headers.get(name)??[];
  if (values.length>1 || required && values.length!==1) fail();
  return values[0]??"";
}
function address(value: string): string {
  if (email.test(value.trim())) return value.trim().toLowerCase();
  const wrapped=value.trim().match(/^(?:"[^"\r\n]*"|[^<>"@,;]+)?\s*<([^<>]+)>$/);
  if (!wrapped || !email.test(wrapped[1])) fail();
  return wrapped[1].toLowerCase();
}
function parseMime(raw: string): { headers: HeadersMap; body: string } {
  if (raw.includes("\0") || /\r(?!\n)/.test(raw)) fail();
  const normalized=raw.replace(/\r\n/g,"\n");
  const boundary=normalized.indexOf("\n\n");
  if(boundary<1||boundary>64_000) fail();
  const lines=normalized.slice(0,boundary).split("\n");
  const unfolded:string[]=[];
  for(const line of lines) {
    if(line.length>998) fail();
    if(/^[ \t]/.test(line)) {
      if(!unfolded.length) fail();
      unfolded[unfolded.length-1]+=" "+line.trim();
    } else unfolded.push(line);
  }
  const headers:HeadersMap=new Map();
  for(const line of unfolded) {
    const match=line.match(/^([A-Za-z0-9-]+):[ \t]*(.*)$/);
    if(!match) fail();
    const name=match[1].toLowerCase();
    headers.set(name,[...(headers.get(name)??[]),match[2].trim()]);
  }
  const contentType=one(headers,"content-type");
  if(!/^text\/plain(?:\s*;\s*charset\s*=\s*(?:"(?:utf-8|us-ascii)"|utf-8|us-ascii))?\s*$/i.test(contentType)) fail();
  if(one(headers,"content-disposition",false) || one(headers,"mime-version",false) && one(headers,"mime-version")!=="1.0") fail();
  for(const [name,values] of headers) {
    if(name.startsWith("resent-") || (name==="cc"||name==="bcc") && values.some(value=>value.trim())) fail();
  }
  const encoding=one(headers,"content-transfer-encoding",false).toLowerCase();
  const encodedBody=normalized.slice(boundary+2);
  if((!encoding||encoding==="7bit") && /[^\x00-\x7f]/.test(encodedBody)) fail();
  let body:string;
  if(!encoding||encoding==="7bit"||encoding==="8bit") body=encodedBody;
  else if(encoding==="base64") body=utf8(base64Bytes(encodedBody.replace(/[ \t\n]/g,""),false));
  else if(encoding==="quoted-printable") body=quotedPrintable(encodedBody);
  else return fail();
  if(/[^\x00-\x7f]/.test(body) && !/charset\s*=\s*"?utf-8"?/i.test(contentType)) fail();
  return {headers,body};
}
function canonicalBody(body: string): string {
  return body.replace(/\r\n/g,"\n").replace(/\n+$/,"");
}
function apiHeaders(value: unknown): HeadersMap {
  if(!Array.isArray(value)) fail();
  const result:HeadersMap=new Map();
  for(const entry of value) {
    if(!entry||typeof entry.name!=="string"||typeof entry.value!=="string") fail();
    const key=entry.name.toLowerCase();result.set(key,[...(result.get(key)??[]),entry.value]);
  }
  return result;
}

async function read(fetcher: typeof fetch, accessToken: string, url: string, limit: number): Promise<Row> {
  const response=await fetcher(url,{headers:{Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(20_000)});
  if(!response.ok||!response.body) fail();
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];
  let length=0;
  try {
    while(true) {
      const next=await reader.read();if(next.done) break;
      length+=next.value.byteLength;
      if(length>limit) {await reader.cancel();fail();}
      chunks.push(next.value);
    }
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const data:unknown=JSON.parse(utf8(bytes));if(!data||typeof data!=="object") fail();return data as Row;
}

export type ApprovedParent = { rfcId: string; references: string[]; threadId: string };
export async function readApprovedParent(fetcher: typeof fetch, accessToken: string, payload: Row): Promise<ApprovedParent> {
  const {gmail_message_id:parentId,gmail_thread_id:threadId}=payload;
  if(typeof parentId!=="string"||!opaqueId.test(parentId)||typeof threadId!=="string"||!opaqueId.test(threadId)
    ||typeof payload.recipient!=="string"||typeof payload.subject!=="string") fail();
  const parent=await read(fetcher,accessToken,`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(parentId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=References`,128_000);
  if(parent.id!==parentId||parent.threadId!==threadId||!parent.payload||typeof parent.payload!=="object") fail();
  const parentHeaders=apiHeaders((parent.payload as Row).headers);
  const parentRfcId=one(parentHeaders,"message-id").trim();
  const parentFrom=one(parentHeaders,"from"),parentReplyTo=one(parentHeaders,"reply-to",false);
  const subject=(value:string)=>decodeHeader(value).trim().replace(/^(?:re:\s*)+/i,"").trim();
  if(!messageId.test(parentRfcId)||parentRfcId.length>900||address(parentReplyTo||parentFrom)!==address(payload.recipient)
    ||subject(one(parentHeaders,"subject"))!==subject(payload.subject)) fail();
  const references=one(parentHeaders,"references",false).trim().split(/\s+/).filter(Boolean);
  if(references.length>100||references.some(value=>!messageId.test(value)||value.length>900)) fail();
  return {rfcId:parentRfcId,threadId,references:[...new Set(references.filter(value=>value!==parentRfcId)),parentRfcId]};
}

export async function readApprovedDraftSnapshot(
  fetcher: typeof fetch, accessToken: string, payload: Row, gmailEmail: string,
): Promise<{ raw: string; threadId: string }> {
  const {gmail_draft_id:draftId}=payload;
  if(typeof draftId!=="string"||!opaqueId.test(draftId)||typeof payload.body!=="string"||!payload.body.trim()
    ||typeof payload.subject!=="string"||typeof payload.recipient!=="string") fail();
  const {rfcId:parentRfcId,threadId}=await readApprovedParent(fetcher,accessToken,payload);
  const draft=await read(fetcher,accessToken,`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?format=raw`,2_100_000);
  if(draft.id!==draftId||!draft.message||typeof draft.message!=="object") fail();
  const message=draft.message as Row;
  if(message.threadId!==threadId||typeof message.raw!=="string"||!message.raw) fail();
  const mime=parseMime(utf8(base64Bytes(message.raw,true)));
  if(address(one(mime.headers,"to"))!==address(payload.recipient)
    ||decodeHeader(one(mime.headers,"subject"))!==payload.subject
    ||canonicalBody(mime.body)!==canonicalBody(payload.body)
    ||one(mime.headers,"in-reply-to")!==parentRfcId) fail();
  const references=one(mime.headers,"references").split(/\s+/);
  if(references.some(value=>!messageId.test(value))||references.at(-1)!==parentRfcId) fail();
  const from=one(mime.headers,"from",false),replyTo=one(mime.headers,"reply-to",false),sender=one(mime.headers,"sender",false);
  if(from&&address(from)!==address(gmailEmail)||replyTo&&address(replyTo)!==address(gmailEmail)
    ||sender&&address(sender)!==address(gmailEmail)) fail();
  // Gmail drafts.send explicitly accepts id + message.raw. Reusing these exact
  // validated bytes prevents a later remote edit changing recipients or body.
  return {raw:message.raw,threadId};
}
