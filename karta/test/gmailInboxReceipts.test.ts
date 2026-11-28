import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const sqlFile = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = sqlFile("../../supabase/migrations/20261128010000_gmail_inbox_receipts.sql");
const user: string = randomUUID(), other: string = randomUUID();
const started = "2026-01-12T10:00:00.000Z";
const email = "owner@example.invalid";
type State = { status: string; item_id: string; policy_version: string; items: State[]; next_before_id: string | null; reference: string | null; message_id: string; mailbox: string };
type Config = { id: string; updated: string; policy: string; cursor: string | null; token: string | null; scan: string | null };
let db: PGlite;
async function row<T>(query: string, args: unknown[] = []): Promise<T> {
  return (await db.query<T>(query,args)).rows[0];
}
async function cfg(uid=user) {
  return row<Config>(`SELECT id,updated_at::text updated,gmail_inbox_policy_version policy,last_sync_at::text cursor,
    gmail_inbox_page_token token,gmail_inbox_scan_started_at::text scan FROM purama_ai.email_agent_config WHERE user_id=$1`,[uid]);
}
async function rpc(name: string, args: unknown[]) {
  const r=await row<{v:State}>(`SELECT purama_ai.gmail_inbox_${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) v`,args);
  return r.v;
}
const msg=(id: string,threadId="thread_1")=>({id,threadId});
async function capture(messages: unknown[], options: {uid?:string; snap?:Config; next?:string|null; restart?:boolean; start?:string}={}) {
  const uid=options.uid??user, c=options.snap??await cfg(uid);
  return rpc("capture",[uid,c.id,c.updated,c.cursor,options.start??c.scan??started,JSON.stringify(messages),c.token,options.next??null,options.restart??false]);
}
async function run(role="email",uid=user,mode="live") {
  const id=randomUUID(); await db.query(`INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode) VALUES($1,$2,$3,'cron',$4)`,[id,uid,role,mode]);
  return id;
}
async function claim(runId: string, role="email", uid=user, c?:Config) {
  const snap=c??await cfg(uid); return rpc("claim",[uid,snap.id,runId,role,snap.policy]);
}
async function begin(item:State,runId:string,uid=user) {
  return rpc("begin",[uid,item.item_id,runId,item.policy_version]);
}
async function finish(item:State,runId:string,outcome:string,reference:string|null=null,uid=user) {
  return rpc("finish",[uid,item.item_id,runId,outcome,reference]);
}
async function untilPast(id:string) {await db.query("UPDATE purama_ai.gmail_inbox_items SET claimed_until=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);}
async function asOwner(uid:string) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[uid]); await db.exec("SET ROLE authenticated");
}
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  await db.query("INSERT INTO auth.users VALUES($1),($2)",[user,other]);
  await db.exec(sqlFile("../../supabase/migrations/20260406210000_email_agent.sql"));
  await db.exec(sqlFile("../migrations/001_karta_core.sql"));
  await db.exec(sqlFile("../migrations/005_karta_pending_actions.sql"));
  await db.exec(sqlFile("../migrations/006_execution_claims.sql"));
  await db.exec(migration);
  await db.exec(migration);
  await db.exec("GRANT USAGE ON SCHEMA purama_ai TO anon,authenticated,service_role");
});
beforeEach(async()=>{
  await db.exec("RESET ROLE; TRUNCATE purama_ai.gmail_inbox_items,purama_ai.email_agent_config,purama_ai.karta_runs CASCADE;");
  await db.query(`INSERT INTO purama_ai.email_agent_config(user_id,gmail_email,is_active) VALUES($1,$3,true),($2,'other@example.invalid',true)`,[user,other,email]);
});
afterAll(async()=>{await db?.close();});
describe("durable Gmail inbox SQL",()=>{
  it("persists more than five pages using one scan time; advances only after the last page",async()=>{
    for(let page=0;page<6;page++) {
      const messages=Array.from({length:50},(_,i)=>msg(String(page*50+i)));
      expect((await capture(messages,{next:page===5?null:`page-${page+1}`})).status).toBe("captured");
      const c=await cfg(); expect(c.token).toBe(page===5?null:`page-${page+1}`);
      expect(c.cursor===null).toBe(page<5); expect(c.scan===null).toBe(page===5);
    }
    expect((await row<{n:number}>("SELECT count(*)::int n FROM purama_ai.gmail_inbox_items")).n).toBe(300);
  });
  it("keeps existing manual approval versions valid across polling but changes the version for real edits",async()=>{
    const before=await cfg();
    await capture([msg("first")],{next:"page-two"});
    expect((await cfg()).updated).toBe(before.updated);
    await capture([],{restart:true});
    expect((await cfg()).updated).toBe(before.updated);
    await capture([]);
    expect((await cfg()).updated).toBe(before.updated);
    await db.query("UPDATE purama_ai.email_agent_config SET signature='Updated signature' WHERE user_id=$1",[user]);
    const change=await cfg();expect(change.updated).not.toBe(before.updated);expect(change.policy).not.toBe(before.policy);
    await db.query("UPDATE purama_ai.email_agent_config SET gmail_access_token='fixture-refreshed' WHERE user_id=$1",[user]);
    expect((await cfg()).updated).not.toBe(change.updated);expect((await cfg()).policy).toBe(change.policy);
  });
  it("rolls back the whole page on contradictory rows, malformed IDs or oversized pages",async()=>{
    await capture([msg("present")],{next:"next"});
    const c=await cfg();
    for(const invalid of [[msg("new"),msg("present","wrong")],[msg("new"),msg("../bad")],
      [{...msg("new"),body:"never store"}],Array(51).fill(msg("many"))]) {
      await expect(capture(invalid,{snap:c})).rejects.toThrow();
      expect(await cfg()).toEqual(c); expect((await row<{n:number}>("SELECT count(*)::int n FROM purama_ai.gmail_inbox_items")).n).toBe(1);
    }
  });
  it("restarts an invalid continuation safely; replayed IDs are unique and cursor regression is refused",async()=>{
    await capture([msg("one")],{next:"page2"});
    const before=await cfg();
    expect((await capture([],{start:"2026-01-12T10:05:00Z"})).status).toBe("stale");
    expect((await capture([msg("wrong")],{restart:true})).status).toBe("stale");
    await expect(capture([],{next:"page2"})).rejects.toThrow(/page token/);
    expect((await capture([],{restart:true})).status).toBe("captured");
    expect(await cfg()).toMatchObject({token:null,scan:null,cursor:null});
    expect((await capture([msg("stale")],{snap:before})).status).toBe("stale");
    await capture([msg("one"),msg("two")]);
    expect((await capture([],{start:"2026-01-12T09:59:00Z"})).status).toBe("stale");
    expect((await row<{n:number}>("SELECT count(*)::int n FROM purama_ai.gmail_inbox_items")).n).toBe(2);
  });
  it("elects one role for the same message; repeated run cannot claim a second item",async()=>{
    await capture([msg("one")]); const a=await run(),b=await run("repondeur-intelligent");
    const choices=await Promise.all([claim(a),claim(b,"repondeur-intelligent")]);
    expect(choices.map(c=>c.status).sort()).toEqual(["claimed","empty"]);
    const ix=choices.findIndex(c=>c.status==="claimed"), r=[a,b][ix], role=["email","repondeur-intelligent"][ix];
    const winner=choices[ix]; expect((await finish(winner,r,"complete","draft:fake")).status).toBe("blocked");
    expect((await finish(winner,r,"ignored")).status).toBe("ignored");
    await capture([msg("one"),msg("two")]); expect((await claim(r,role)).status).toBe("blocked");
    expect((await claim(await run())).message_id).toBe("two");
  });
  it("allows other work through after a pre-effect retry then makes the first item available again",async()=>{
    await capture([msg("one"),msg("two")]); const r=await run(), first=await claim(r);
    expect((await finish(first,r,"retry")).status).toBe("ready");
    const r2=await run(), second=await claim(r2); expect(second.item_id).not.toBe(first.item_id);
    expect((await finish(second,r2,"ignored")).status).toBe("ignored");
    expect((await claim(await run())).status).toBe("empty");
    await db.query("UPDATE purama_ai.gmail_inbox_items SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[first.item_id]);
    expect((await claim(await run())).item_id).toBe(first.item_id);
  });
  it("returns an abandoned pre-effect item only to another run; stale workers cannot arm or ack",async()=>{
    await capture([msg("one")]); const r=await run(), item=await claim(r); await untilPast(item.item_id);
    const s=await run("repondeur-intelligent"), second=await claim(s,"repondeur-intelligent"); expect(second.item_id).toBe(item.item_id);
    expect((await begin(item,r)).status).toBe("blocked"); expect((await finish(item,r,"complete")).status).toBe("blocked");
    expect((await begin(second,s)).status).toBe("armed"); expect((await begin(second,s)).status).toBe("blocked");
  });
  it.each(["retry","unknown","ignored","complete"])("never re-emits after arm and an unproven %s",async outcome=>{
    await capture([msg("one")]); const r=await run(), item=await claim(r); await begin(item,r);
    expect((await finish(item,r,outcome)).status).toBe("review");
    expect((await claim(await run())).status).toBe("empty"); expect((await begin(item,r)).status).toBe("blocked");
    await asOwner(user); const reviews=await rpc("reviews",[]); expect(reviews.items).toHaveLength(1);
    expect(reviews.items[0]).toMatchObject({item_id:item.item_id,mailbox:email,reference:null});
  });
  it("uses provider receipts and preserves the first finalization after acknowledgement loss",async()=>{
    await capture([msg("one")]); const r=await run(), item=await claim(r); await begin(item,r);
    const receipt="notification:"+"n".repeat(256);
    expect((await finish(item,r,"complete",receipt+"n")).status).toBe("blocked");
    expect((await finish(item,r,"complete",receipt)).status).toBe("done");
    expect((await finish(item,r,"retry")).status).toBe("done");
    expect((await row<{reference:string}>("SELECT reference FROM purama_ai.gmail_inbox_items WHERE id=$1",[item.item_id])).reference).toBe(receipt);
    expect((await claim(await run())).status).toBe("empty");
  });
  it("preserves the mailbox across refreshes, resets pagination on account switch, and detects A-B-A",async()=>{
    const initial=await cfg(); await capture([msg("one")],{next:"more"}); const r=await run(), item=await claim(r);
    await db.query("UPDATE purama_ai.email_agent_config SET gmail_access_token='mock-rotation' WHERE user_id=$1",[user]);
    expect((await cfg()).policy).toBe(initial.policy);
    await db.query("UPDATE purama_ai.email_agent_config SET gmail_email='b@example.invalid' WHERE user_id=$1",[user]);
    expect(await cfg()).toMatchObject({token:null,scan:null,cursor:null}); expect((await claim(await run())).status).toBe("empty");
    await db.query("UPDATE purama_ai.email_agent_config SET gmail_email=$2 WHERE user_id=$1",[user,email]);
    expect((await begin(item,r)).status).toBe("blocked");
    expect((await claim(await run(),"email",user,initial)).status).toBe("blocked");
    expect((await finish(item,r,"ignored")).status).toBe("ready");
    expect((await claim(await run())).item_id).toBe(item.item_id);
  });
  it("rechecks edited exclusions or deactivation, rejects wrong owners, roles, mock-mode runs",async()=>{
    await capture([msg("one")]); const r=await run(), item=await claim(r);
    expect((await begin(item,r,other)).status).toBe("blocked");
    expect((await finish(item,r,"complete",null,other)).status).toBe("blocked");
    await db.query("UPDATE purama_ai.email_agent_config SET excluded_domains=ARRAY['private.invalid'] WHERE user_id=$1",[user]);
    expect((await begin(item,r)).status).toBe("blocked"); expect((await finish(item,r,"ignored")).status).toBe("ready");
    expect((await claim(await run("email",user,"simulation"))).status).toBe("blocked");
    expect((await claim(await run("email",other))).status).toBe("blocked");
    expect((await claim(await run(),"repondeur-intelligent")).status).toBe("blocked");
    await db.query("UPDATE purama_ai.email_agent_config SET is_active=false WHERE user_id=$1",[user]);
    expect((await capture([msg("no")])).status).toBe("stale"); expect((await claim(await run())).status).toBe("blocked");
  });
  it("lets only the owner inspect an abandoned armed claim and close it without retry",async()=>{
    await capture([msg("one")]); const r=await run(),item=await claim(r); await begin(item,r); await untilPast(item.item_id);
    await db.query("UPDATE purama_ai.email_agent_config SET is_active=false WHERE user_id=$1",[user]);
    await db.exec("SET ROLE anon"); await expect(rpc("reviews",[])).rejects.toThrow(/permission denied/); await db.exec("RESET ROLE");
    await asOwner(other); expect((await rpc("reviews",[])).items).toEqual([]);
    expect((await rpc("resolve",[item.item_id,"observed","Seen",email])).status).toBe("blocked"); await db.exec("RESET ROLE");
    await asOwner(user); expect((await rpc("reviews",[])).items).toHaveLength(1);
    expect((await rpc("resolve",[item.item_id,"observed","Proof","wrong@example.invalid"])).status).toBe("blocked");
    expect((await rpc("resolve",[item.item_id,"retry","Proof",email])).status).toBe("blocked");
    for(let i=0;i<2;i++) expect((await rpc("resolve",[item.item_id,"observed","Verified draft d-01",email])).status).toBe("observed");
    expect((await rpc("resolve",[item.item_id,"closed_without_retry","Conflict",email])).status).toBe("blocked");
    expect((await rpc("reviews",[])).items).toHaveLength(0);
    await expect(rpc("begin",[user,item.item_id,r,item.policy_version])).rejects.toThrow(/permission denied/);
    await expect(db.query("SELECT * FROM purama_ai.gmail_inbox_items")).rejects.toThrow(/permission denied/);
  });
  it("paginates 30 private review entries without losing an entry when the anchor is resolved",async()=>{
    await db.query(`INSERT INTO purama_ai.gmail_inbox_items(user_id,mailbox,message_id,thread_id,state,review_at)
      SELECT $1,$2,i::text,'thread','review',now() FROM generate_series(1,32) i`,[user,email]);
    await asOwner(user); const first=await rpc("reviews",[]); expect(first.items).toHaveLength(30);
    expect(first.next_before_id).toBe(first.items[29].item_id);
    await rpc("resolve",[first.next_before_id,"closed_without_retry","Archived",email]);
    const second=await rpc("reviews",[first.next_before_id]); expect(second.items).toHaveLength(2);
    expect(second.next_before_id).toBeNull(); expect(new Set([...first.items,...second.items].map(x=>x.item_id)).size).toBe(32);
  });
  it.each(["failed","stalled"] as const)("exposes an uncertain deferred approval only once %s",async end=>{
    await capture([msg("one")]); const r=await run(), item=await claim(r),approval=randomUUID();
    await begin(item,r);
    await db.query(`INSERT INTO purama_ai.karta_pending_actions(id,user_id,run_id,agent_type,tool_name,tool_params,status)
      VALUES($1,$2,$3,'email','gmail_send','{}','pending')`,[approval,user,r]);
    expect((await finish(item,r,"complete",`approval:${approval}`)).status).toBe("done");
    for(const actionState of ["pending","executing","executed"]){
      await db.query("UPDATE purama_ai.karta_pending_actions SET status=$2,claimed_at=clock_timestamp() WHERE id=$1",[approval,actionState]);
      await asOwner(user); expect((await rpc("reviews",[])).items).toHaveLength(0);
      expect((await rpc("resolve",[item.item_id,"closed_without_retry","Not yet",email])).status).toBe("blocked"); await db.exec("RESET ROLE");
    }
    await db.query("UPDATE purama_ai.karta_pending_actions SET status=$2,claimed_at=clock_timestamp()-interval '12 minutes' WHERE id=$1",[approval,end==="failed"?"failed":"executing"]);
    await asOwner(user); expect((await rpc("reviews",[])).items[0]).toMatchObject({item_id:item.item_id,reference:`approval:${approval}`,followup_tools:[]});
    expect((await rpc("resolve",[item.item_id,"observed","Checked provider",email])).status).toBe("observed");
    expect((await rpc("reviews",[])).items).toHaveLength(0);
    await db.exec("RESET ROLE");
    expect((await row<{reference:string}>("SELECT reference FROM purama_ai.gmail_inbox_items WHERE id=$1",[item.item_id])).reference).toBe(`approval:${approval}`);
  });
  it("reserves only bounded known followups and reports the first receipt without authorizing another effect",async()=>{
    await capture([msg("one")]);const r=await run(),item=await claim(r);
    for(const invalid of [["arbitrary_effect"],Array(33).fill("gmail_send"),[null]]) {
      expect((await rpc("begin",[user,item.item_id,r,item.policy_version,invalid])).status).toBe("blocked");
    }
    expect((await rpc("begin",[user,item.item_id,r,item.policy_version,["send_notification","gmail_create_draft","send_notification"]])).status).toBe("armed");
    expect((await finish(item,r,"complete","draft:d_1")).status).toBe("review");
    expect((await finish(item,r,"complete","draft:d_1")).status).toBe("review");
    expect((await begin(item,r)).status).toBe("blocked");
    await asOwner(user); const reviews=await rpc("reviews",[]);
    expect(reviews.items[0]).toMatchObject({item_id:item.item_id,reference:"draft:d_1",followup_tools:["send_notification","gmail_create_draft"]});
    expect((await rpc("resolve",[item.item_id,"closed_without_retry","Checked draft",email])).status).toBe("closed_without_retry");
    await db.exec("RESET ROLE"); expect((await claim(await run())).status).toBe("empty");
  });
  it("binds a deferred approval only to its journal, current claim policy and exact Gmail parent",async()=>{
    await capture([msg("one")]); const r=await run(), item=await claim(r); await rpc("begin",[user,item.item_id,r,item.policy_version,["send_notification"]]);
    const approval=randomUUID();
    const makeApproval=async(rid:string,id:string)=>{
      await db.query(`INSERT INTO purama_ai.karta_pending_actions(id,user_id,run_id,agent_type,tool_name,tool_params,status)
        VALUES($1,$2,$3,'email','gmail_send','{"replyToMessageId":"one","threadId":"thread_1"}','executing')`,[id,user,rid]);
      await db.query("UPDATE purama_ai.karta_runs SET status='awaiting_approval',tools_used=$2::jsonb WHERE id=$1",[rid,JSON.stringify([{pendingActionId:id,tool:"gmail_send",outcome:"pending",success:false}])]);
    };
    await makeApproval(r,approval);
    expect((await rpc("approval_binding",[user,r,approval])).status).toBe("blocked");
    expect((await finish(item,r,"complete",`approval:${approval}`)).status).toBe("review");
    expect(await rpc("approval_binding",[user,r,approval])).toMatchObject({status:"bound",message_id:"one",mailbox:email,policy_version:item.policy_version});
    expect((await rpc("approval_binding",[other,r,approval])).status).toBe("blocked");
    await db.query("UPDATE purama_ai.karta_pending_actions SET tool_params='{}' WHERE id=$1",[approval]);
    expect((await rpc("approval_binding",[user,r,approval])).status).toBe("blocked");
    await db.query(`UPDATE purama_ai.karta_pending_actions SET tool_params='{"replyToMessageId":"one","threadId":"thread_1"}' WHERE id=$1`,[approval]);
    await db.query("UPDATE purama_ai.email_agent_config SET excluded_emails=ARRAY['private@example.invalid'] WHERE user_id=$1",[user]);
    expect((await rpc("approval_binding",[user,r,approval])).status).toBe("blocked");
    const legacy=await run(),old=randomUUID(); await makeApproval(legacy,old);
    expect((await rpc("approval_binding",[user,legacy,old])).status).toBe("blocked");
    await db.query("UPDATE purama_ai.karta_runs SET started_at='2020-01-01' WHERE id=$1",[legacy]);
    await db.query("UPDATE purama_ai.karta_pending_actions SET created_at='2020-01-01' WHERE id=$1",[old]);
    expect((await rpc("approval_binding",[user,legacy,old])).status).toBe("legacy");
    expect((await rpc("approval_binding",[user,r,old])).status).toBe("blocked");
  });
});
