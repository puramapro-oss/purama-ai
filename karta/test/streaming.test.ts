import { afterEach, expect, it, vi } from "vitest";
const moduleUrl = new URL("../../supabase/functions/_shared/anthropic-stream.ts", import.meta.url).href;
const { streamAnthropicChat } = await import(moduleUrl);
const params = { apiKey:"test",model:"test",systemPrompt:"test",messages:[{role:"user",content:"hi"}] };
const delta = JSON.stringify({type:"content_block_delta",delta:{type:"text_delta",text:"été 🌍"}});
const stop = JSON.stringify({type:"message_stop"});
const enc = new TextEncoder();
function upstream(text:string, bytewise=false) {
  const bytes=enc.encode(text); let offset=0;
  return new Response(new ReadableStream({pull(c){if(offset===bytes.length){c.close();return;} const end=bytewise?offset+1:bytes.length;c.enqueue(bytes.slice(offset,end));offset=end;}}));
}
afterEach(()=>vi.unstubAllGlobals());
it("streams text followed by a confirmed completion",async()=>{vi.stubGlobal("fetch",vi.fn(async()=>upstream("data: "+delta+"\n\ndata: "+stop+"\n\n")));const text=await(await streamAnthropicChat(params)).text();expect(text).toContain("été 🌍");expect(text.endsWith("data: [DONE]\n\n")).toBe(true);});
it("handles UTF-8 and CRLF split at every byte, and data without a space",async()=>{vi.stubGlobal("fetch",vi.fn(async()=>upstream("data:"+delta+"\r\n\r\ndata:"+stop+"\r\n\r\n",true)));expect(await(await streamAnthropicChat(params)).text()).toContain("été 🌍");});
it.each(["data: "+JSON.stringify({type:"error",error:{message:"private provider details"}})+"\n\n","data: "+delta+"\n\n","data: not-json\n\n"])("rejects an error, premature EOF or malformed frame",async text=>{vi.stubGlobal("fetch",vi.fn(async()=>upstream(text)));await expect((await streamAnthropicChat(params)).text()).rejects.toThrow();});
it("preserves failure status without leaking the provider body",async()=>{vi.stubGlobal("fetch",vi.fn(async()=>new Response("secret detail",{status:503})));const r=await streamAnthropicChat(params);expect(r.status).toBe(503);expect(await r.text()).not.toContain("secret detail");});
it("bounds an unterminated event",async()=>{vi.stubGlobal("fetch",vi.fn(async()=>upstream("data:"+"x".repeat(262145))));await expect((await streamAnthropicChat(params)).text()).rejects.toThrow(/too large/);});
it("cancels upstream when the consumer cancels",async()=>{const cancel=vi.fn();vi.stubGlobal("fetch",vi.fn(async()=>new Response(new ReadableStream({cancel}))));const r=await streamAnthropicChat(params);await r.body!.cancel();expect(cancel).toHaveBeenCalledOnce();});
it("terminates a stalled stream at its deadline",async()=>{vi.stubGlobal("fetch",vi.fn(async()=>new Response(new ReadableStream())));await expect((await streamAnthropicChat({...params,timeoutMs:20})).text()).rejects.toThrow(/timed out/);});
it("propagates parent cancellation",async()=>{const parent=new AbortController();vi.stubGlobal("fetch",vi.fn(async()=>new Response(new ReadableStream())));const r=await streamAnthropicChat({...params,signal:parent.signal});const pending=r.text();parent.abort(new Error("caller cancelled"));await expect(pending).rejects.toThrow(/caller cancelled/);});
