#!/usr/bin/env node
/**
 * Native PostgreSQL concurrency checks for workshop admission.
 * Creates its own private temporary cluster. Never connects to an existing DB.
 * Usage: node test/chefWorkshopConcurrency.native.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const execute = promisify(execFile);
const kartaRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(kartaRoot, "../test-results/workshop-native-concurrency.json");
const owner = "00000000-0000-4000-8000-000000003201";
const other = "00000000-0000-4000-8000-000000003202";
const instanceA = "00000000-0000-4000-8000-000000003203";
const instanceB = "00000000-0000-4000-8000-000000003204";
const hash = "a".repeat(64);
const report = {
  status: "RUNNING", startedAt: new Date().toISOString(),
  isolation: "new private temporary cluster; Unix socket only; no existing PostgreSQL service used",
  checks: [], migrations: [], cleanup: { stopped: false, removed: false },
};
const binaries = [
  "/opt/homebrew/opt/postgresql@18/bin", "/opt/homebrew/opt/postgresql/bin", "/usr/local/opt/postgresql@18/bin",
  "/usr/lib/postgresql/18/bin", "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin",
];
let bin;
let cluster;
let data;
let socket;
let coordinator;
let first;
let second;
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
const binaryEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
const binary = (name, args, timeout = 30_000) => execute(join(bin,name),args,{
  timeout, maxBuffer:1024*1024, env:binaryEnv,
});
const sleep = ms => new Promise(done => setTimeout(done,ms));

async function ephemeralPort() {
  const server = createServer();
  await new Promise((done,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",done); });
  const port = server.address().port;
  await new Promise((done,reject) => server.close(error => error ? reject(error) : done()));
  return port;
}
async function waitForBlockedConnection(pid) {
  const deadline = Date.now()+3_000;
  while (Date.now()<deadline && !stopping) {
    const rows = (await coordinator.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows;
    if (rows[0]?.wait_event_type === "Lock") return true;
    await sleep(15);
  }
  throw new Error("No overlapping database lock observed for the second connection");
}
async function raceWhileFirstHoldsTransaction(firstOperation, secondOperation) {
  let pending;
  await first.query("BEGIN");
  await first.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='6s'");
  try {
    const firstResult = await firstOperation(first);
    pending = (async () => {
      await second.query("BEGIN");
      await second.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='6s'");
      try {
        const result = await secondOperation(second);
        await second.query("COMMIT");
        return {ok:true,result};
      } catch (error) {
        await second.query("ROLLBACK");
        return {ok:false,code:error.code,message:error.message};
      }
    })();
    const observedLockWait = await waitForBlockedConnection(second.processID);
    await first.query("COMMIT");
    const secondResult = await pending;
    return {first:firstResult,second:secondResult,observedLockWait};
  } catch (error) {
    await first.query("ROLLBACK");
    if (pending) await pending;
    throw error;
  }
}
function missionBrief(id) {
  return {
    briefId:"workshop:example:"+id,version:1,goal:"Native concurrency fixture",repo:"test/example",
    requirements:[{key:"PRODUCT",description:"Fixture product",critical:true}],
    tasks:[{
      key:"build",title:"Build",instructions:"Fixture only; no external process",
      provider:"codex",accessMode:"write",worktree:"/isolated/native-fixture",scopeKey:"native-fixture",
      allowedPaths:["src"],requirementKeys:["PRODUCT"],verificationProfiles:["unit"],estimatedTokens:10,maxAttempts:3,
    }],
  };
}
async function heartbeat(client, id=instanceA) {
  return (await client.query("SELECT purama_ai.chef_workshop_heartbeat('example',$1,$2,true) AS ok",[id,hash])).rows[0].ok;
}
async function submit(client, id=randomUUID(), user=owner) {
  const brief = missionBrief(id);
  return (await client.query(
    "SELECT purama_ai.chef_workshop_submit($1,'example',$2,$3,$3,$4::jsonb,$5,2,100,NULL) AS id",
    [user,id,hash,JSON.stringify(brief),createHash("sha256").update(JSON.stringify(brief)).digest("hex")],
  )).rows[0].id;
}
async function cancel(client,id) {
  return (await client.query("SELECT purama_ai.chef_workshop_cancel($1,$2) AS ok",[owner,id])).rows[0].ok;
}
async function finish(client,id) {
  return (await client.query("SELECT purama_ai.chef_workshop_finish_cancel($1) AS ok",[id])).rows[0].ok;
}
async function worker() {
  const id="native-"+randomUUID(), session="session-"+id;
  await coordinator.query("SELECT purama_ai.chef_heartbeat_worker($1,'codex','fixture','idle',$2,1,NULL,'test/example','/isolated/native-fixture',NULL,'{}'::jsonb)",[id,session]);
  return {id,session};
}
async function claim(client,mission,agent) {
  return (await client.query("SELECT id,fencing_token,attempt FROM purama_ai.chef_claim_next_task($1,$2,$3,'codex',300)",[mission,agent.id,agent.session])).rows;
}
async function reset() {
  await coordinator.query("TRUNCATE purama_ai.chef_workshop_runtimes,purama_ai.chef_process_quarantines,purama_ai.chef_workers,auth.users CASCADE");
  await coordinator.query("INSERT INTO auth.users(id) VALUES($1),($2)",[owner,other]);
}
async function check(name,fn) {
  if (stopping) throw new Error("Stop requested; preserving cleanup");
  await reset();
  const started = Date.now();
  try {
    const detail = await fn();
    report.checks.push({name,status:"PASS",durationMs:Date.now()-started,...detail});
    console.log(JSON.stringify({check:name,status:"PASS"}));
  } catch (error) {
    report.checks.push({name,status:"FAIL",durationMs:Date.now()-started,error:error.message,code:error.code});
    throw error;
  }
}
async function main() {
  for (const candidate of binaries) {
    try {
      for (const name of ["initdb","pg_ctl","postgres"]) await access(join(candidate,name),constants.X_OK);
      bin=candidate; break;
    } catch { /* Existing installations only; never install or use a service fallback. */ }
  }
  if (!bin) {
    report.status="NON_TESTE"; report.reason="No installed PostgreSQL binary set found";
    process.exitCode=1;
    return;
  }
  report.postgresVersion=(await binary("postgres",["--version"])).stdout.trim();
  cluster=await mkdtemp("/tmp/purama-workshop-pg-");
  await chmod(cluster,0o700);
  data=join(cluster,"data");
  socket=cluster;
  report.privateCluster=cluster;
  await binary("initdb",["--pgdata",data,"--username","workshop_test","--auth","trust","--encoding","UTF8","--no-locale"]);
  const port=await ephemeralPort();
  report.port=port;
  await binary("pg_ctl",["-D",data,"-l",join(cluster,"server.log"),"-w","-t","15","-o",
    "-h '' -k '"+socket+"' -p "+port+" -c max_connections=12 -c shared_buffers=16MB -c unix_socket_permissions=0700","start"],25_000);
  const config={host:socket,port,user:"workshop_test",database:"postgres",ssl:false,connectionTimeoutMillis:5000};
  coordinator=new pg.Client({...config,application_name:"workshop-native-coordinator"});
  first=new pg.Client({...config,application_name:"workshop-native-first"});
  second=new pg.Client({...config,application_name:"workshop-native-second"});
  await Promise.all([coordinator.connect(),first.connect(),second.connect()]);
  await coordinator.query([
    "CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);",
    "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';",
    "CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
    "GRANT USAGE ON SCHEMA purama_ai TO anon,authenticated,service_role;",
  ].join(" "));
  for (const file of [
    "008_chef_control_plane.sql","009_chef_hardening.sql","010_chef_reliability.sql","011_chef_runtime_policy.sql",
    "012_chef_mission_ingest.sql","013_chef_independent_review.sql","014_chef_file_ownership.sql","015_chef_mission_file_ownership.sql",
    "016_chef_scoped_evidence.sql","017_chef_evidence_generation.sql","021_chef_budget_admission.sql","022_chef_mission_estimates.sql",
    "023_chef_process_quarantine.sql","024_chef_claim_budget_reconciliation.sql",
    "030_chef_capability_selection.sql","031_chef_workshop.sql",
  ]) {
    const sql=await readFile(join(kartaRoot,"migrations",file),"utf8");
    await coordinator.query(sql);
    report.migrations.push({file,sha256:createHash("sha256").update(sql).digest("hex")});
  }
  await Promise.all([first.query("SET ROLE service_role"),second.query("SET ROLE service_role")]);
  report.connectionPids=[first.processID,second.processID];
  assert.notEqual(first.processID,second.processID);

  await check("same request id admits exactly one mission across two connections",async () => {
    await heartbeat(coordinator);
    const id=randomUUID();
    const race=await raceWhileFirstHoldsTransaction(client=>submit(client,id),client=>submit(client,id));
    assert.equal(race.second.ok,true);
    assert.equal(race.first,race.second.result);
    const rows=(await coordinator.query("SELECT (SELECT count(*)::int FROM purama_ai.chef_missions) AS missions,(SELECT count(*)::int FROM purama_ai.chef_workshop_runs) AS runs")).rows[0];
    assert.deepEqual(rows,{missions:1,runs:1});
    return {observedLockWait:race.observedLockWait,...rows};
  });

  await check("two request ids sharing one project yield one admission and one busy response",async () => {
    await heartbeat(coordinator);
    const race=await raceWhileFirstHoldsTransaction(client=>submit(client,randomUUID(),owner),client=>submit(client,randomUUID(),other));
    assert.equal(race.second.ok,false);
    assert.equal(race.second.code,"PW423");
    const rows=(await coordinator.query("SELECT count(*)::int AS runs FROM purama_ai.chef_workshop_runs")).rows[0];
    assert.equal(rows.runs,1);
    return {observedLockWait:race.observedLockWait,rejectedCode:race.second.code,...rows};
  });

  await check("two consumer instances cannot both acquire one live project lease",async () => {
    const race=await raceWhileFirstHoldsTransaction(client=>heartbeat(client,instanceA),client=>heartbeat(client,instanceB));
    assert.equal(race.first,true);
    assert.equal(race.second.ok,true);
    assert.equal(race.second.result,false);
    assert.equal((await coordinator.query("SELECT instance_id FROM purama_ai.chef_workshop_runtimes")).rows[0].instance_id,instanceA);
    return {observedLockWait:race.observedLockWait,leaseWinners:1};
  });

  await check("cancellation commits first and prevents the concurrent task claim",async () => {
    await heartbeat(coordinator);
    const mission=await submit(coordinator);
    const agent=await worker();
    const race=await raceWhileFirstHoldsTransaction(client=>cancel(client,mission),client=>claim(client,mission,agent));
    assert.equal(race.first,true);
    assert.equal(race.second.ok,true);
    assert.deepEqual(race.second.result,[]);
    assert.equal(await finish(coordinator,mission),true);
    return {observedLockWait:race.observedLockWait,claimedTasks:0,cancellationFinalized:true};
  });

  await check("claim commits first and cancellation retains its active scope until worker stop receipt",async () => {
    await heartbeat(coordinator);
    const mission=await submit(coordinator);
    const agent=await worker();
    const race=await raceWhileFirstHoldsTransaction(client=>claim(client,mission,agent),client=>cancel(client,mission));
    assert.equal(race.first.length,1);
    assert.equal(race.second.ok,true);
    assert.equal(race.second.result,true);
    assert.equal(await finish(coordinator,mission),false);
    const task=race.first[0];
    const row=(await coordinator.query("SELECT state,lease_owner FROM purama_ai.chef_tasks WHERE id=$1",[task.id])).rows[0];
    assert.deepEqual(row,{state:"claimed",lease_owner:agent.id});
    const stopped=(await coordinator.query("SELECT purama_ai.chef_transition_task($1,$2,$3,'retryable') AS ok",[task.id,agent.id,task.fencing_token])).rows[0].ok;
    assert.equal(stopped,true);
    assert.equal(await finish(coordinator,mission),true);
    return {observedLockWait:race.observedLockWait,claimedTasks:1,finalizationBeforeStop:false,finalizationAfterStop:true};
  });
  report.status="PASS";
}
try {
  await main();
} catch (error) {
  report.status="FAIL";
  report.error=error.message;
  process.exitCode=1;
} finally {
  await Promise.allSettled([coordinator,first,second].filter(Boolean).map(client=>client.end()));
  if (cluster) {
    try {
      try {
        await access(join(data,"postmaster.pid"));
        await binary("pg_ctl",["-D",data,"-m","fast","-w","-t","15","stop"],20_000);
      } catch (error) {
        if (error.code!=="ENOENT") throw error;
      }
      // Only remove the unique directory this invocation created, after confirmed stop.
      let live=false;
      try { await access(join(data,"postmaster.pid")); live=true; } catch {}
      if (live) throw new Error("Private server PID file remains; temporary cluster retained");
      report.cleanup.stopped=true;
      assert(cluster.startsWith("/tmp/purama-workshop-pg-"));
      await rm(cluster,{recursive:true,force:true});
      report.cleanup.removed=true;
    } catch (error) {
      report.status="FAIL"; report.cleanup.error=error.message; process.exitCode=1;
    }
  }
  report.finishedAt=new Date().toISOString();
  await mkdir(dirname(reportPath),{recursive:true});
  await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({status:report.status,checks:report.checks.length,cleanup:report.cleanup,report:reportPath}));
}
