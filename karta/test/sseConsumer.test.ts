import {expect,it,vi} from 'vitest';
const moduleUrl=new URL('../../src/lib/sse.ts',import.meta.url).href;
const {parseSSEStream}=await import(moduleUrl);
const delta='data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
it('accepts a confirmed complete response',async()=>{const onDelta=vi.fn();expect(await parseSSEStream(new Response(delta+'data: [DONE]\n\n'),onDelta)).toBe('hello');expect(onDelta).toHaveBeenCalledWith('hello');});
it('rejects a silently truncated response',async()=>{await expect(parseSSEStream(new Response(delta),()=>{})).rejects.toThrow(/interrompue/);});
it('rejects provider error events',async()=>{await expect(parseSSEStream(new Response('data: {"error":"failed"}\n\n'),()=>{})).rejects.toThrow();});
it('propagates a rendering callback failure and cancels the reader',async()=>{await expect(parseSSEStream(new Response(delta+'data: [DONE]\n\n'),()=>{throw new Error('render failed');})).rejects.toThrow(/render failed/);});
it('rejects HTTP errors before interpreting body content',async()=>{await expect(parseSSEStream(new Response('error',{status:503}),()=>{})).rejects.toThrow(/503/);});
