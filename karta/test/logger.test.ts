import {beforeEach,expect,it,vi} from "vitest";
const h=vi.hoisted(()=>({rows:new Map<string,any>()}));
vi.mock("../src/db/supabase.js",()=>({supabase:{from:()=>{
 let insert:any;let patch:any;const filters:Record<string,unknown>={};
 const result=async()=>{
  if(insert){if(h.rows.has(insert.execution_key))return {data:null,error:{code:"23505"}};const row={id:"run-"+h.rows.size,...insert};h.rows.set(insert.execution_key,row);return {data:{id:row.id},error:null};}
  const row=[...h.rows.values()].find(r=>Object.entries(filters).every(([k,v])=>r[k]===v));
  if(patch&&row)Object.assign(row,patch);
  return {data:row??null,error:null};
 };
 const q:any={insert:(v:any)=>{insert=v;return q;},update:(v:any)=>{patch=v;return q;},select:()=>q,eq:(k:string,v:unknown)=>{filters[k]=v;return q;},single:result,then:(resolve:any,reject:any)=>result().then(resolve,reject)};
 return q;
}}}));
const {startRun}=await import("../src/engine/logger.js");
const trigger={type:"manual" as const,source:"test"};
beforeEach(()=>{h.rows.clear();});
it("returns the completed result when the same delivery is received again",async()=>{
 const run=await startRun("u","compta",trigger,"live","same");
 await run.finish({status:"success",decision:"done",toolsUsed:[{tool:"act",success:true,outcome:"executed",paramsSummary:"",resultSummary:"receipt"}],resultSummary:"done",mock:false});
 const repeated=await startRun("u","compta",trigger,"live","same");
 expect(repeated.existingResult).toMatchObject({status:"success",retryable:false,toolsUsed:[{outcome:"executed"}]});expect(h.rows.size).toBe(1);
});
it("does not replay a claimed delivery with an uncertain outcome",async()=>{
 await startRun("u","compta",trigger,"live","same");
 const repeat=await startRun("u","compta",trigger,"live","same");
 expect(repeat.existingResult).toMatchObject({status:"error",retryable:false});
});
it("never returns another user's journal after a key collision",async()=>{
 await startRun("other","compta",trigger,"live","same");
 await expect(startRun("u","compta",trigger,"live","same")).rejects.toThrow(/vérifier/);
});
it("records mocked results with simulation mode",async()=>{
 const run=await startRun("u","compta",trigger,"live","same");
 await run.finish({status:"simulated",decision:"mock",toolsUsed:[],resultSummary:"none",mock:true});
 expect(h.rows.get("same").mode).toBe("simulation");
});
