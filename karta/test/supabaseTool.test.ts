import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), updates: [] as Record<string,unknown>[] }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { from: () => {
  let row: any; let action = ""; const filters: Record<string,unknown> = {};
  const result = async () => {
    if (action === "update") { const current=h.rows.get(row.id); h.updates.push({...filters}); if (current && Object.entries(filters).every(([k,v])=>current[k]===v)) { h.rows.set(row.id,row); return {data:{id:row.id},error:null}; } return {data:null,error:null}; }
    const id=row.id??"new"; if(h.rows.has(id)) return {data:null,error:{message:"duplicate"}};
    h.rows.set(id,{...row,id}); return {data:{id},error:null};
  };
  const q:any={update:(v:unknown)=>{row=v;action="update";return q;},insert:(v:unknown)=>{row=v;action="insert";return q;},select:()=>q,eq:(k:string,v:unknown)=>{filters[k]=v;return q;},maybeSingle:result,single:result};
  return q;
} } }));
const { supabaseUpsertTool, supabaseSelectTool } = await import("../src/tools/supabase-tool.js");
const ctx={userId:"u1",agentType:"compta" as const,mode:"live" as const};
beforeEach(()=>{h.rows.clear();h.updates=[];});
describe("owner-guarded Supabase writes",()=>{
  it("rejects unknown tables for writes",async()=>{await expect(supabaseUpsertTool.execute({table:"auth.users",row:{}},ctx)).rejects.toThrow(/non autorisée/);});
  it("rejects unknown tables for reads",async()=>{await expect(supabaseSelectTool.execute({table:"profiles"},ctx)).rejects.toThrow(/non autorisée/);});
  it("inserts an allowed row bound to the authenticated owner",async()=>{await supabaseUpsertTool.execute({table:"compta_transactions",row:{amount:10,user_id:"attacker"}},ctx);expect(h.rows.get("new")?.user_id).toBe("u1");});
  it("updates an existing owned row",async()=>{h.rows.set("own",{id:"own",user_id:"u1"});await supabaseUpsertTool.execute({table:"compta_transactions",row:{id:"own",amount:10}},ctx);expect(h.rows.get("own")?.amount).toBe(10);expect(h.updates[0]).toEqual({id:"own",user_id:"u1"});});
  it("cannot take over a foreign primary key",async()=>{h.rows.set("foreign",{id:"foreign",user_id:"u2",amount:99});await expect(supabaseUpsertTool.execute({table:"compta_transactions",row:{id:"foreign",amount:10}},ctx)).rejects.toThrow();expect(h.rows.get("foreign")).toEqual({id:"foreign",user_id:"u2",amount:99});});
});
