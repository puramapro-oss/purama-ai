#!/usr/bin/env bash
set -eu
cd /workspace/scratch/ccfbf7e5800b/purama-ai
node --import './karta/node_modules/tsx/dist/loader.mjs' --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { KartaRuntimeIaoPort } from './karta/src/iao/kartaRuntimePort.ts';
const REQUEST_ID='11111111-1111-4111-8111-111111111111';
const RECEIPT_ID='22222222-2222-4222-8222-222222222222';
const request=stage=>({type:stage==='control'?'memory-control':'conversation',requestId:REQUEST_ID,tenantId:'tenant-a',actorId:'actor-a',conversationId:'conversation-a',prompt:'Synthetic validation boundary',identity:{tenantId:'tenant-a',actorId:'actor-a',session:{sessionId:'33333333-3333-4333-8333-333333333333',appSlug:'purama-ai',tenantId:'tenant-a',userId:'actor-a',issuedAt:0,expiresAt:Date.now()+60000}},...(stage==='control'?{memoryControl:{action:'update',data:{value:'synthetic'}}}:{})});
for (const stage of ['completion','control']) for(const interruption of ['abort','deadline']) for(const throws of [false,true]) {
 let now=0;
 const original=Object.getOwnPropertyDescriptor(performance,'now');
 Object.defineProperty(performance,'now',{configurable:true,value:()=>now});
 const parent=new AbortController();
 const process=()=>{if(interruption==='abort')parent.abort();else now=100;if(throws)throw new Error('memory-denied:synthetic-private-detail');};
 const port=new KartaRuntimeIaoPort({buildContext:async()=>({operationId:RECEIPT_ID,context:{sources:[]}}),control:async()=>({get action(){process();return 'update';},operationId:RECEIPT_ID,replayed:false})},{complete:async()=>({get text(){process();return 'synthetic';},modelVersion:'test/local'})},100);
 const result=await port.prepare(request(stage),parent.signal);
 assert.equal(result.kind,'blocked'); assert.equal(result.effect,'uncertain'); assert.equal(result.dependency,'memory-unavailable:karta-runtime');
 console.log(JSON.stringify({stage,interruption,throws,result:result.kind,effect:result.effect,dependency:result.dependency,pass:true}));
 if(original)Object.defineProperty(performance,'now',original);else Reflect.deleteProperty(performance,'now');
}
NODE
