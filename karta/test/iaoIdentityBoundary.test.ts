import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleIaoRoute } from '../src/api/iaoRoutes.js';
import { IaoFacade, IaoRequestNotFoundError, IaoRequestConflictError, type IaoServerIdentity } from '../src/iao/iaoFacade.js';
const id = '11111111-1111-4111-8111-111111111111';
function identity(): IaoServerIdentity {
 const now = Date.now();
 return { tenantId:'tenant-a', actorId:'actor-a', session:{ sessionId:'22222222-2222-4222-8222-222222222222', tenantId:'tenant-a', userId:'actor-a', appSlug:'purama-ai', issuedAt:now-1000, expiresAt:now+60000 } };
}
async function call(method:string, path:string, auth:unknown, absent=false) {
 const trusted=identity();
 const facade=new IaoFacade({prepare:async()=>({kind:'accepted',preview:'private preview'})});
 await facade.submit({type:'conversation',requestId:id,tenantId:trusted.tenantId,actorId:trusted.actorId,conversationId:'c',prompt:'x',identity:trusted});
 let response:{status:number;body:unknown}|undefined;
 await handleIaoRoute({method,url:path} as IncomingMessage,new ServerResponse(new IncomingMessage(new Socket())),
 absent?undefined:{facade,authenticator:{authenticate:async()=>auth as IaoServerIdentity}},
 async()=>({type:'conversation',requestId:id,conversationId:'c',prompt:'x'}),
 (_res,status,body)=>{response={status,body};});
 return {response,stored:facade.get(trusted.tenantId,trusted.actorId,id)};
}
afterEach(() => vi.useRealTimers());
const corruptions:[string,(i:IaoServerIdentity)=>unknown][]=[
 ['missing',()=>undefined],
 ['null',()=>null], ['primitive',()=>42], ['array',()=>[]],
 ['session null',i=>({...i,session:null})],
 ['session array',i=>({...i,session:[]})],
 ['empty tenant',i=>({...i,tenantId:'',session:{...i.session,tenantId:''}})],
 ['whitespace actor',i=>({...i,actorId:' ',session:{...i.session,userId:' '}})],
 ['non-string tenant',i=>({...i,tenantId:42,session:{...i.session,tenantId:42}})],
 ['session id number',i=>({...i,session:{...i.session,sessionId:42}})],
 ['NaN issuance',i=>({...i,session:{...i.session,issuedAt:NaN}})],
 ['infinite expiry',i=>({...i,session:{...i.session,expiresAt:Infinity}})],
 ['string expiry',i=>({...i,session:{...i.session,expiresAt:String(i.session.expiresAt)}})],
 ['expired',i=>({...i,session:{...i.session,expiresAt:Date.now()-1}})],
 ['future issuance',i=>({...i,session:{...i.session,issuedAt:Date.now()+10000}})],
 ['oversized lifetime',i=>({...i,session:{...i.session,expiresAt:Date.now()+3600000}})],
 ['wrong audience',i=>({...i,session:{...i.session,appSlug:'purama-one'}})],
 ['tenant mismatch',i=>({...i,session:{...i.session,tenantId:'other'}})],
 ['actor mismatch',i=>({...i,session:{...i.session,userId:'other'}})],
 ['invalid session id',i=>({...i,session:{...i.session,sessionId:'invalid'}})],
 ['missing session',i=>({tenantId:i.tenantId,actorId:i.actorId})],
];
describe.each([['GET',`/iao/requests/${id}`],['POST',`/iao/requests/${id}/cancel`],['POST','/iao/requests'],['POST','/pura/requests']])('%s %s identity admission',(method,path)=>{
 it.each(corruptions)('rejects %s before reading or mutating',async(_name,corrupt)=>{
  const result=await call(method,path,corrupt(identity()));
  expect(result.response).toEqual({status:401,body:{error:'IAO authentication required'}});
  expect(result.stored.status).toBe('partial');
 });
 it('requires injected runtime',async()=>{expect((await call(method,path,identity(),true)).response?.status).toBe(503);});
});
it('permits valid scoped reads and cancellation',async()=>{
 expect((await call('GET',`/iao/requests/${id}`,identity())).response?.status).toBe(200);
 expect((await call('POST',`/iao/requests/${id}/cancel`,identity())).stored).toMatchObject({status:'cancelled',effect:'uncertain'});
});
it.each(['tenantId','actorId'] as const)('cannot read or cancel another %s',async field=>{
 const i=identity();const other={...i,[field]:'other',session:{...i.session,[field==='actorId'?'userId':'tenantId']:'other'}};
 for(const [method,path] of [['GET',`/iao/requests/${id}`],['POST',`/iao/requests/${id}/cancel`]]){
  const result=await call(method!,path!,other);expect(result.response?.status).toBe(404);expect(result.stored.status).toBe('partial');
 }
});

it.each(['GET','POST'])('invalid identity never reads or aborts pending request on %s',async method=>{
 const trusted=identity();let signal:AbortSignal|undefined;
 let finish!:(value:{kind:'accepted';preview:string})=>void;
 const prepare=vi.fn(async(_request:unknown,abort?:AbortSignal)=>{signal=abort;return new Promise<{kind:'accepted';preview:string}>(resolve=>{finish=resolve;});});
 const facade=new IaoFacade({prepare});
 const active=facade.submit({type:'conversation',requestId:id,tenantId:trusted.tenantId,actorId:trusted.actorId,conversationId:'c',prompt:'x',identity:trusted});
 const submit=vi.spyOn(facade,'submit'),get=vi.spyOn(facade,'get'),cancel=vi.spyOn(facade,'cancel');
 const body=vi.fn(async()=>({}));let status=0;
 await handleIaoRoute({method,url:method==='GET'?'/iao/requests/%ZZ':'/iao/requests/'+id+'/cancel'} as IncomingMessage,new ServerResponse(new IncomingMessage(new Socket())),
 {facade,authenticator:{authenticate:async()=>({...trusted,session:{...trusted.session,expiresAt:0}})}},body,(_res,code)=>{status=code;});
 expect(status).toBe(401);expect(body).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled();expect(prepare).toHaveBeenCalledOnce();expect(signal?.aborted).toBe(false);
 finish({kind:'accepted',preview:'done'});await active;
});
it.each(['/iao/requests','/pura/requests'])('invalid identity precedes body parsing on %s',async url=>{
 const facade=new IaoFacade({prepare:vi.fn()});const submit=vi.spyOn(facade,'submit');const body=vi.fn(async()=>({}));let status=0;
 await handleIaoRoute({method:'POST',url} as IncomingMessage,new ServerResponse(new IncomingMessage(new Socket())),{facade,authenticator:{authenticate:async()=>null as unknown as IaoServerIdentity}},body,(_res,code)=>{status=code;});
 expect(status).toBe(401);expect(body).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
});
it('enforces exact expiry and lifetime boundaries against server clock',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1800000000000);const i=identity();
 for(const [issuedAt,expiresAt,status] of [[Date.now(),Date.now()+900000,200],[Date.now(),Date.now()+900001,401],[Date.now()-1000,Date.now(),401]]){
 const result=await call('GET',`/iao/requests/${id}`,{...i,session:{...i.session,issuedAt,expiresAt}});expect(result.response?.status).toBe(status);
 }
});

// Real Node response headers, without binding a port or contacting an identity service.
describe.each([
 ['GET', `/iao/requests/${id}`, 200],
 ['POST', `/iao/requests/${id}/cancel`, 200],
 ['POST', '/iao/requests', 202],
 ['POST', '/pura/requests', 202],
] as const)('cache boundary %s %s', (method, url, successStatus) => {
 it.each(['success', 'invalid-identity', 'missing-runtime', 'not-found', 'conflict', 'failure'] as const)(
  'prohibits storage before sending %s', async scenario => {
   const trusted = identity();
   const facade = new IaoFacade({prepare: async () => ({kind: 'accepted', preview: 'synthetic private preview'})});
   await facade.submit({type:'conversation',requestId:id,tenantId:trusted.tenantId,actorId:trusted.actorId,conversationId:'c',prompt:'x',identity:trusted});
   const operation = method === 'GET' ? 'get' : url.endsWith('/cancel') ? 'cancel' : 'submit';
   if (scenario === 'not-found' || scenario === 'conflict' || scenario === 'failure') {
    vi.spyOn(facade, operation).mockImplementation(() => {
     throw scenario === 'not-found' ? new IaoRequestNotFoundError() : scenario === 'conflict' ? new IaoRequestConflictError() : new Error('synthetic');
    });
   }
   const request = new IncomingMessage(new Socket());
   request.method = method; request.url = url; request.headers.cookie = 'synthetic-session';
   const response = new ServerResponse(request);
   response.setHeader('Cache-Control', 'public, max-age=3600');
   let sent = 0;
   const handled = await handleIaoRoute(request, response,
    scenario === 'missing-runtime' ? undefined : {facade, authenticator: {authenticate: async () => scenario === 'invalid-identity' ? null as unknown as IaoServerIdentity : trusted}},
    async () => ({type:'conversation',requestId:id,conversationId:'c',prompt:'x'}),
    (res, status) => {
     sent = status;
     expect(res.getHeader('Cache-Control')).toBe('no-store');
     res.writeHead(status, {'Content-Type':'application/json'});
     expect(res.getHeader('Cache-Control')).toBe('no-store');
    });
   expect(handled).toBe(true);
   expect(sent).toBe(scenario === 'success' ? successStatus : scenario === 'invalid-identity' ? 401 : scenario === 'missing-runtime' ? 503 : scenario === 'not-found' ? 404 : scenario === 'conflict' ? 409 : 400);
  });
});
it.each([['GET','/health'], ['DELETE',`/iao/requests/${id}`]])('leaves unrelated %s %s unchanged', async (method,url) => {
 const req = new IncomingMessage(new Socket()); req.method=method; req.url=url;
 const res = new ServerResponse(req); res.setHeader('Cache-Control','public, max-age=60');
 const send = vi.fn(), body = vi.fn();
 expect(await handleIaoRoute(req,res,undefined,body,send)).toBe(false);
 expect(res.getHeader('Cache-Control')).toBe('public, max-age=60');
 expect(send).not.toHaveBeenCalled(); expect(body).not.toHaveBeenCalled();
});
