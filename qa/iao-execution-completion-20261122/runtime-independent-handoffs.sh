#!/usr/bin/env bash
set -eu
cd /workspace/scratch/ccfbf7e5800b/purama-ai
node --import './karta/node_modules/tsx/dist/loader.mjs' --input-type=module <<'NODE'

import assert from 'node:assert/strict';
import { KartaRuntimeIaoPort } from './karta/src/iao/kartaRuntimePort.ts';
globalThis.fetch = async () => { throw new Error('External transport forbidden in review'); };
const queueAfter=(n,fn)=>queueMicrotask(()=>n>1?queueAfter(n-1,fn):fn());
const receiptId='22222222-2222-4222-8222-222222222222';
const request=stage=>({type:stage==='control'?'memory-control':'conversation',requestId:'11111111-1111-4111-8111-111111111111',tenantId:'tenant-a',actorId:'actor-a',conversationId:'conversation-a',prompt:'Synthetic review',identity:{tenantId:'tenant-a',actorId:'actor-a',session:{sessionId:'33333333-3333-4333-8333-333333333333',appSlug:'purama-ai',tenantId:'tenant-a',userId:'actor-a',issuedAt:Date.now()-1000,expiresAt:Date.now()+60000}},...(stage==='control'?{memoryControl:{action:'update',data:{value:'synthetic'}}}:{})});
let passed=0;
for(const stage of ['completion','control']) for(const turns of (stage==='control'?[5,6,7]:[5,6])) for(const interruption of ['parent-abort','deadline']) {
 let now=0;
 const previous=Object.getOwnPropertyDescriptor(performance,'now');
 Object.defineProperty(performance,'now',{configurable:true,value:()=>now});
 try {
  const parent=new AbortController(), signals=[];
  const settle=value=>{queueAfter(turns,()=>{if(interruption==='parent-abort')parent.abort();else now=100;});return Promise.resolve(value);};
  const port=new KartaRuntimeIaoPort({buildContext:async input=>{signals.push(input.signal);return {operationId:receiptId,context:{sources:[]}};},control:input=>{signals.push(input.signal);return settle({action:'update',operationId:receiptId,replayed:false});}},{complete:input=>{signals.push(input.signal);return settle({text:'Synthetic answer',modelVersion:'test/local'});}},100);
  const result=await port.prepare(request(stage),parent.signal);
  const expected=turns===(stage==='control'?7:6)?'accepted':'blocked';
  assert.equal(result.kind,expected);
  if(expected==='blocked') {
   assert.equal(result.effect,'uncertain');
   assert.equal(result.dependency,'memory-unavailable:karta-runtime');
   assert(signals.every(signal=>signal.aborted));
  } else assert(signals.every(signal=>!signal.aborted));
  passed++;
  console.log(JSON.stringify({stage,turns,interruption,result:result.kind,effect:result.effect??null,pass:true}));
 } finally {if(previous)Object.defineProperty(performance,'now',previous);else Reflect.deleteProperty(performance,'now');}
}
console.log(JSON.stringify({suite:'independent final handoff and post-commit',passed,externalCalls:0}));

NODE
