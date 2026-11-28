/** Real lock contention on a disposable socket-only PostgreSQL cluster.
 * PG_BIN=/path/to/postgres/bin node test/gmailInboxReceipts.native.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";

const bin=process.env.PG_BIN;
assert(bin && process.getuid?.()!==0, "Set PG_BIN to local PostgreSQL binaries and run without root");
const fixture=await mkdtemp(join(tmpdir(),"gmail-inbox-locks-"));
const data=join(fixture,"pg"), port=randomInt(53001,58000), exec=promisify(execFile);
const binary=(name,args)=>exec(join(bin,name),args,{timeout:name==="initdb"?120_000:50_000});
let started=false;
const clients=[];
async function connect(){
  const client=new pg.Client({host:fixture,port,user:"gmail_test",database:"postgres",ssl:false,connectionTimeoutMillis:4_000});
  clients.push(client); await client.connect(); return client;
}
async function callee(client,name,...args){
  return (await client.query(`SELECT purama_ai.gmail_inbox_${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) result`,args)).rows[0].result;
}
async function waitForLock(observer,blocked,blocker) {
  const until=Date.now()+15_000;
  while(Date.now()<until) {
    const r=await observer.query("SELECT $2::int=ANY(pg_blocking_pids($1::int)) held",[blocked.processID,blocker.processID]);
    if(r.rows[0].held) return;
    await delay(20);
  }
  assert.fail("No overlapping PostgreSQL lock was observed");
}
try {
  await binary("initdb",["-D",data,"-U","gmail_test","-A","trust","--no-locale","-E","UTF8"]);
  await binary("pg_ctl",["-D",data,"-l",join(fixture,"postgres.log"),"-w","-t","45","-o",
    `-h '' -k '${fixture}' -p ${port} -c shared_buffers=16MB -c unix_socket_permissions=0700`,"start"]);
  started=true;
  const observer=await connect(),a=await connect(),b=await connect();
  const proof=(await observer.query("SELECT current_setting('listen_addresses') addr,current_setting('data_directory') dir")).rows[0];
  assert.equal(proof.addr,""); assert.equal(proof.dir,data);
  await observer.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  for(const file of ["../../supabase/migrations/20260406210000_email_agent.sql","../migrations/001_karta_core.sql",
    "../migrations/005_karta_pending_actions.sql","../migrations/006_execution_claims.sql","../../supabase/migrations/20261128010000_gmail_inbox_receipts.sql"]){
    await observer.query(await readFile(new URL(file,import.meta.url),"utf8"));
  }
  await observer.query("GRANT USAGE ON SCHEMA purama_ai TO service_role");
  await Promise.all([a.query("SET ROLE service_role"),b.query("SET ROLE service_role")]);
  const user=randomUUID(),r1=randomUUID(),r2=randomUUID();
  await observer.query("INSERT INTO auth.users(id) VALUES($1)",[user]);
  const cfg=(await observer.query(`INSERT INTO purama_ai.email_agent_config(user_id,gmail_email,is_active) VALUES($1,'mail@example.invalid',true)
    RETURNING id,updated_at::text AS stamp,gmail_inbox_policy_version AS version`,[user])).rows[0];
  await observer.query(`INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode)
    VALUES($1,$3,'email','cron','live'),($2,$3,'repondeur-intelligent','cron','live')`,[r1,r2,user]);
  const inputs=[user,cfg.id,cfg.stamp,null,new Date().toISOString(),JSON.stringify([{id:"message",threadId:"thread"}])];
  await a.query("BEGIN");
  assert.equal((await callee(a,"capture",...inputs)).status,"captured");
  const duplicate=callee(b,"capture",...inputs);
  await waitForLock(observer,b,a); await a.query("COMMIT");
  assert.equal((await duplicate).status,"stale");
  await a.query("BEGIN");
  const winner=await callee(a,"claim",user,cfg.id,r1,"email",cfg.version);
  assert.equal(winner.status,"claimed");
  const second=callee(b,"claim",user,cfg.id,r2,"repondeur-intelligent",cfg.version);
  await waitForLock(observer,b,a); await a.query("COMMIT");
  assert.equal((await second).status,"empty");
  await a.query("BEGIN");
  assert.equal((await callee(a,"begin",user,winner.item_id,r1,cfg.version)).status,"armed");
  const duplicateBegin=callee(b,"begin",user,winner.item_id,r1,cfg.version);
  await waitForLock(observer,b,a); await a.query("COMMIT");
  assert.equal((await duplicateBegin).status,"blocked");
  await observer.query("UPDATE purama_ai.gmail_inbox_items SET claimed_until=clock_timestamp()-interval '1 second' WHERE id=$1",[winner.item_id]);
  assert.equal((await callee(b,"claim",user,cfg.id,r2,"repondeur-intelligent",cfg.version)).status,"empty");
  assert.equal((await callee(b,"finish",user,winner.item_id,r1,"retry",null)).status,"review");
  console.log("PASS — three overlapping PostgreSQL sessions: capture, cross-role claim, arm, and crash after arm.");
} catch (error) {
  if (!started) {
    const log=await readFile(join(fixture,"postgres.log"),"utf8").catch(()=>"");
    if(log) console.error(log.trim());
  }
  throw error;
} finally {
  // Close sessions before stopping this private server, even if a query is still blocked.
  await Promise.allSettled(clients.map(c=>c.end()));
  if(started) await binary("pg_ctl",["-D",data,"-m","immediate","-w","stop"]);
  await rm(fixture,{recursive:true,force:true});
}
