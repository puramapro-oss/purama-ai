import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { request } from "node:http";
const h=vi.hoisted(()=>({set:vi.fn(),active:false}));
vi.mock("../src/engine/killswitch.js",()=>({setGlobalKillSwitch:h.set,isGlobalKillSwitchActive:async()=>h.active}));
vi.mock("../src/queue/queues.js",()=>({enqueueAgentCycle:vi.fn()}));
vi.mock("../src/agents/index.js",()=>({AGENT_REGISTRY:{compta:{}}}));
vi.mock("../src/agents/customAgent.js",()=>({loadCustomAgent:vi.fn()}));
vi.mock("../src/engine/approval.js",()=>({resolvePendingAction:vi.fn()}));
const {startApiServer}=await import("../src/api/server.js");
let server:ReturnType<typeof startApiServer>;let port:number;
beforeAll(async()=>{server=startApiServer();await new Promise<void>(r=>server.once("listening",r));port=(server.address() as {port:number}).port;});
afterAll(async()=>{await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));});
beforeEach(()=>{ h.set.mockReset(); });
function post(body:string,token="test-only-admin"):Promise<{status:number,body:string}>{
 return new Promise((resolve,reject)=>{const req=request({host:"127.0.0.1",port,path:"/kill-switch/global",method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json","content-length":Buffer.byteLength(body)}},res=>{let data="";res.on("data",c=>data+=c);res.on("end",()=>resolve({status:res.statusCode!,body:data}));});req.on("error",reject);req.end(body);});
}
it("rejects an invalid administrative token before mutation",async()=>{expect((await post('{"active":true}',"wrong")).status).toBe(401);expect(h.set).not.toHaveBeenCalled();});
it.each(['{"active":"false"}','{"active":0}','{}','[]','{'])("rejects malformed commands %s",async body=>{expect((await post(body)).status).toBe(400);expect(h.set).not.toHaveBeenCalled();});
it("keeps false as false",async()=>{expect((await post('{"active":false}')).status).toBe(200);expect(h.set).toHaveBeenCalledWith(false);});
it("rejects an oversized JSON body",async()=>{expect((await post(JSON.stringify({active:true,pad:"x".repeat(70000)}))).status).toBe(413);expect(h.set).not.toHaveBeenCalled();});
it("does not expose internal exception details",async()=>{h.set.mockRejectedValue(new Error("credential=private-value"));const r=await post('{"active":true}');expect(r.status).toBe(500);expect(r.body).not.toContain("private-value");});
