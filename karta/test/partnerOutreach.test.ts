import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// Import the actual cross-runtime modules, not copied/extracted function bodies.
const handlerUrl = new URL("../../supabase/functions/partner-send-outreach/handler.ts", import.meta.url).href;
const feedbackUrl = new URL("../../src/lib/partner-outreach-result.ts", import.meta.url).href;
const { createPartnerOutreachHandler } = await import(/* @vite-ignore */ handlerUrl);
const { parseOutreachResult, outreachFeedback, outreachStepForStatus } = await import(/* @vite-ignore */ feedbackUrl);
const historical = readFileSync(new URL("../../supabase/migrations/20260406230000_partner_agent.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../supabase/migrations/20261110030000_partner_outreach_reservations.sql", import.meta.url), "utf8");
const user = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const prospect = "00000000-0000-4000-8000-000000000011";
const otherProspect = "00000000-0000-4000-8000-000000000012";
const token = "00000000-0000-4000-8000-000000000021";
const laterToken = "00000000-0000-4000-8000-000000000022";
type Row = Record<string, unknown>;
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    INSERT INTO auth.users(id) VALUES ('${user}'), ('${other}');
  `);
  await db.exec(historical);
  await db.exec(migration);
});

beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE purama_ai.partner_agent_config, purama_ai.partner_prospects, purama_ai.partner_outreach_suppressions CASCADE");
  await db.query(`INSERT INTO purama_ai.partner_agent_config
    (user_id,is_active,sender_name,sender_email,require_approval_new_prospect,require_approval_outreach)
    VALUES ($1,true,'Test Sender','sender@example.invalid',false,false),
      ($2,true,'Other Sender','other@example.invalid',false,false)`, [user, other]);
  await db.query(`INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status)
    VALUES ($1,$2,'Test prospect','recipient@example.invalid','ready_to_contact'),
      ($3,$4,'Other prospect','other-recipient@example.invalid','ready_to_contact')`,
  [prospect,user,otherProspect,other]);
});
afterAll(async () => { await db?.close(); });

const functions: Record<string, string[]> = {
  partner_outreach_reserve: ["p_user_id","p_prospect_id","p_step","p_claim_token"],
  partner_outreach_save_draft: ["p_user_id","p_action_id","p_claim_token","p_subject","p_body_html"],
  partner_outreach_approve: ["p_user_id","p_email_id","p_approval_version"],
  partner_outreach_begin_send: ["p_user_id","p_action_id","p_claim_token"],
  partner_outreach_finish: ["p_user_id","p_action_id","p_claim_token","p_outcome","p_provider_message_id"],
};
async function rpc(name: string, args: Row): Promise<{ data: Row | null; error: { message: string } | null }> {
  const keys = functions[name];
  if (!keys) throw new Error(`Unexpected RPC ${name}`);
  try {
    const result = await db.query<{ value: Row }>(
      `SELECT purama_ai.${name}(${keys.map((_,i)=>`$${i+1}`).join(",")}) AS value`,
      keys.map(key=>args[key] ?? null),
    );
    return { data: result.rows[0].value, error: null };
  } catch (error) { return { data: null, error: { message: String(error) } }; }
}
async function mustRpc(name: string, args: Row): Promise<Row> {
  const result = await rpc(name,args);
  if (result.error || !result.data) throw new Error(result.error?.message ?? "Missing RPC data");
  return result.data;
}
const request = (body: Row = { prospect_id: prospect }, authorization = "Bearer valid-user") => new Request("https://example.invalid/outreach", {
  method: "POST", headers: { Authorization: authorization, "Content-Type":"application/json" }, body: JSON.stringify(body),
});
async function prepare(id = prospect, claim = token): Promise<Row> {
  const reserved = await mustRpc("partner_outreach_reserve", { p_user_id:user,p_prospect_id:id,p_step:"outreach",p_claim_token:claim });
  return mustRpc("partner_outreach_save_draft", {
    p_user_id:user,p_action_id:reserved.action_id,p_claim_token:claim,p_subject:"Test",p_body_html:"<p>Test</p>",
  });
}

type HarnessOptions = {
  provider?: "ok" | "timeout" | "missing_id" | "server_error" | "rejected";
  onDraft?: () => Promise<void>;
  onReady?: () => Promise<void>;
  onProvider?: () => Promise<void>;
  failCompletion?: "before_commit" | "after_commit";
  authenticated?: string | null;
  anthropicModel?: string;
};
function harness(options: HarnessOptions = {}) {
  const calls: { url:string; headers:Headers; body:Row }[] = [];
  const handler = createPartnerOutreachHandler({
    authenticate: async (authToken: string) => authToken === "valid-user" ? (options.authenticated === undefined ? user : options.authenticated) : null,
    rpc: async (name: string,args: Row) => {
      if (name === "partner_outreach_finish" && args.p_outcome === "sent" && options.failCompletion) {
        if (options.failCompletion === "after_commit") await mustRpc(name,args);
        return { data:null,error:{message:"Simulated lost database acknowledgement"} };
      }
      const result = await rpc(name,args);
      if (name === "partner_outreach_save_draft" && result.data?.status === "ready") await options.onReady?.();
      return result;
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url,headers:new Headers(init?.headers),body:JSON.parse(String(init?.body)) as Row });
      if (url === "https://api.anthropic.com/v1/messages") {
        await options.onDraft?.();
        return new Response(JSON.stringify({content:[{text:JSON.stringify({subject:"Test",body_html:"<p>Test</p>"})}]}),{status:200});
      }
      if (url === "https://api.resend.com/emails") {
        await options.onProvider?.();
        if (options.provider === "timeout") throw new Error("Simulated timeout after possible acceptance");
        if (options.provider === "server_error") return new Response("Unavailable",{status:500});
        if (options.provider === "rejected") return new Response("Rejected",{status:422});
        return new Response(JSON.stringify(options.provider === "missing_id" ? {} : {id:"provider-message-1"}),{status:200});
      }
      throw new Error(`Unexpected external URL: ${url}`);
    },
    anthropicApiKey:"fake-draft-key",anthropicModel:options.anthropicModel,resendApiKey:"fake-email-key",
  });
  return { handler,calls,sends:()=>calls.filter(c=>c.url === "https://api.resend.com/emails"),drafts:()=>calls.filter(c=>c.url === "https://api.anthropic.com/v1/messages") };
}

const approvalRequest = (result: Row, overrides: Row = {}) => request({
  action:"approve",email_id:result.email_id,approval_version:(result.approval as Row).version,...overrides,
});
async function requireApproval() {
  await db.query("UPDATE purama_ai.partner_agent_config SET require_approval_outreach=true WHERE user_id=$1",[user]);
}

it("retains pending approval and reports it honestly without an email send", async () => {
  await db.query("UPDATE purama_ai.partner_agent_config SET require_approval_outreach=true WHERE user_id=$1",[user]);
  const h=harness();
  const result=await (await h.handler(request())).json();
  expect(result.status).toBe("pending_approval");
  expect(h.sends()).toHaveLength(0);
  expect(h.drafts()[0].body.model).toBe("claude-sonnet-4-20250514");
  expect(outreachFeedback(parseOutreachResult(result)).kind).toBe("info");
  expect(outreachFeedback(parseOutreachResult(result)).title).toBe("En attente de validation");
  await h.handler(request());
  expect(h.drafts()).toHaveLength(1);
  expect((await db.query("SELECT status FROM purama_ai.partner_emails")).rows).toEqual([{status:"pending_approval"}]);
});

it("approves exactly the frozen preview even if the editable legacy email row was changed", async () => {
  await requireApproval();
  const h=harness();
  const pending=await (await h.handler(request())).json();
  expect(parseOutreachResult(pending).approval).toEqual({
    version:expect.any(String),from:"Test Sender <sender@example.invalid>",
    to:"recipient@example.invalid",subject:"Test",body_html:"<p>Test</p>",
  });
  await db.query("UPDATE purama_ai.partner_emails SET subject='Tampered',body_html='<script>ignored</script>',status='approved' WHERE id=$1",[pending.email_id]);
  const reopened=await (await h.handler(request())).json();
  expect(reopened.approval).toEqual(pending.approval);
  expect(reopened.status).toBe("pending_approval");
  expect(h.sends()).toHaveLength(0);
  expect(await (await h.handler(approvalRequest(pending))).json()).toMatchObject({status:"sent",message_id:"provider-message-1"});
  expect(h.sends()[0].body).toEqual({from:pending.approval.from,to:pending.approval.to,
    subject:pending.approval.subject,html:pending.approval.body_html,reply_to:"sender@example.invalid"});
  expect(h.drafts()).toHaveLength(1);
  expect(await (await h.handler(approvalRequest(pending))).json()).toMatchObject({status:"sent",reused:true});
  expect(h.sends()).toHaveLength(1);
});

it("twenty simultaneous approval clicks dispatch the same frozen email only once", async () => {
  await requireApproval();
  const h=harness();
  const pending=await (await h.handler(request())).json();
  await Promise.all(Array.from({length:20},()=>h.handler(approvalRequest(pending))));
  expect(h.sends()).toHaveLength(1);
  expect(h.drafts()).toHaveLength(1);
  expect((await db.query("SELECT status,approved_at IS NOT NULL AS approved FROM purama_ai.partner_outreach_dispatches")).rows)
    .toEqual([{status:"sent",approved:true}]);
});

it("refuses another user's approval even with a forged user_id and the exact version", async () => {
  await requireApproval();
  const owner=harness();
  const pending=await (await owner.handler(request())).json();
  const attacker=harness({authenticated:other});
  expect(await (await attacker.handler(approvalRequest(pending,{user_id:user}))).json())
    .toMatchObject({status:"blocked",reason:"action_not_found"});
  expect(attacker.calls).toHaveLength(0);
  expect(owner.sends()).toHaveLength(0);
  expect((await db.query("SELECT status,approved_at FROM purama_ai.partner_outreach_dispatches")).rows)
    .toEqual([{status:"pending_approval",approved_at:null}]);
});

it("binds approval to both the email and its version, rejecting a different or stale draft", async () => {
  await requireApproval();
  await db.query("UPDATE purama_ai.partner_prospects SET user_id=$1 WHERE id=$2",[user,otherProspect]);
  const h=harness();
  const first=await (await h.handler(request())).json();
  const second=await (await h.handler(request({prospect_id:otherProspect}))).json();
  for (const approval_version of [second.approval.version,token]) {
    expect(await (await h.handler(approvalRequest(first,{approval_version}))).json())
      .toMatchObject({status:"blocked",reason:"stale_approval"});
  }
  expect(await (await h.handler(approvalRequest(first,{email_id:prospect}))).json())
    .toMatchObject({status:"blocked",reason:"action_not_found"});
  expect(h.sends()).toHaveLength(0);
  expect((await db.query("SELECT count(*)::integer AS total FROM purama_ai.partner_outreach_dispatches WHERE approved_at IS NOT NULL")).rows)
    .toEqual([{total:0}]);
});

it.each([
  ["status='rejected',has_replied=true","contact_suppressed","prospect"],
  ["has_replied=true","contact_has_replied","prospect"],
  ["email='changed@example.invalid'","recipient_changed","prospect"],
  ["is_active=false","agent_inactive","config"],
  ["sender_email='changed@example.invalid'","sender_changed","config"],
])("rechecks %s after preview and before an approved send", async (patch,reason,table) => {
  await requireApproval();
  const h=harness();
  const pending=await (await h.handler(request())).json();
  // The patches above are fixed fixtures, never caller input.
  if (table === "prospect") await db.query(`UPDATE purama_ai.partner_prospects SET ${patch} WHERE id=$1`,[prospect]);
  else await db.query(`UPDATE purama_ai.partner_agent_config SET ${patch} WHERE user_id=$1`,[user]);
  expect(await (await h.handler(approvalRequest(pending))).json()).toMatchObject({status:"blocked",reason});
  expect(h.sends()).toHaveLength(0);
});

it("does not interpret a configuration change as approval for an already pending email", async () => {
  await requireApproval();
  const h=harness();
  const pending=await (await h.handler(request())).json();
  await db.query("UPDATE purama_ai.partner_agent_config SET require_approval_outreach=false WHERE user_id=$1",[user]);
  expect(await (await h.handler(request())).json()).toMatchObject({status:"pending_approval",approval:pending.approval});
  expect(h.sends()).toHaveLength(0);
  expect(await (await h.handler(approvalRequest(pending))).json()).toMatchObject({status:"sent"});
});

it.each([1,2,3])("reopens and approves follow-up %i from the current prospect status without regenerating it", async (number) => {
  await requireApproval();
  const currentStatus=number === 1 ? "contacted" : `relance_${number-1}`;
  await db.query("UPDATE purama_ai.partner_prospects SET status=$1,relance_count=$2,first_contact_at=now()-interval '10 days',next_action_at=now()-interval '1 day' WHERE id=$3",[currentStatus,number-1,prospect]);
  const type=outreachStepForStatus(currentStatus);
  const h=harness();
  const pending=await (await h.handler(request({prospect_id:prospect,type}))).json();
  expect(pending.status).toBe("pending_approval");
  const reopened=await (await h.handler(request({prospect_id:prospect,type}))).json();
  expect(reopened.approval).toEqual(pending.approval);
  expect(await (await h.handler(approvalRequest(reopened))).json()).toMatchObject({status:"sent"});
  expect(h.drafts()).toHaveLength(1);
  expect(h.sends()).toHaveLength(1);
  expect((await db.query("SELECT status,relance_count FROM purama_ai.partner_prospects WHERE id=$1",[prospect])).rows)
    .toEqual([{status:`relance_${number}`,relance_count:number}]);
});

it("blocks a follow-up selected by the client until its server-side due date", async () => {
  await db.query("UPDATE purama_ai.partner_prospects SET status='contacted',first_contact_at=now(),next_action_at=now()+interval '1 day' WHERE id=$1",[prospect]);
  const h=harness();
  expect(await (await h.handler(request({prospect_id:prospect,type:outreachStepForStatus("contacted")}))).json())
    .toMatchObject({status:"blocked",reason:"followup_not_due"});
  expect(h.calls).toHaveLength(0);
});

it("does not equate approval with delivery or resend after an uncertain approval attempt", async () => {
  await requireApproval();
  const h=harness({provider:"timeout"});
  const pending=await (await h.handler(request())).json();
  const outcome=await (await h.handler(approvalRequest(pending))).json();
  expect(outcome).toMatchObject({status:"unknown"});
  expect(outcome.message_id).toBeUndefined();
  await db.exec("UPDATE purama_ai.partner_outreach_dispatches SET dispatch_started_at=now()-interval '25 hours'");
  expect(await (await h.handler(approvalRequest(pending))).json()).toMatchObject({status:"unknown"});
  expect(h.sends()).toHaveLength(1);
});

it("rejects malformed approval requests before calling providers", async () => {
  const h=harness();
  for (const body of [{action:"approve",email_id:prospect},
    {action:"approve",email_id:prospect,approval_version:" "},{action:"override",prospect_id:prospect}]) {
    expect((await h.handler(request(body))).status).toBe(400);
  }
  expect(h.calls).toHaveLength(0);
});

it("uses the explicitly configured model without selecting another tier", async () => {
  const h=harness({anthropicModel:" configured-model-id "});
  await h.handler(request());
  expect(h.drafts()[0].body.model).toBe("configured-model-id");
});

it("rejects an empty model configuration before any external API call", async () => {
  const h=harness({anthropicModel:"   "});
  expect((await h.handler(request())).status).toBe(503);
  expect(h.calls).toHaveLength(0);
});

it("twenty simultaneous requests reserve one action and one provider send", async () => {
  const h=harness();
  await Promise.all(Array.from({length:20},()=>h.handler(request())));
  expect(h.sends()).toHaveLength(1);
  expect(h.drafts()).toHaveLength(1);
  const actions=(await db.query<{id:string;status:string}>("SELECT id,status FROM purama_ai.partner_outreach_dispatches")).rows;
  expect(actions).toHaveLength(1);
  expect(actions[0].status).toBe("sent");
  expect(h.sends()[0].headers.get("Idempotency-Key")).toBe(`partner-outreach/${actions[0].id}`);
  const repeat=await (await h.handler(request())).json();
  expect(repeat).toMatchObject({status:"sent",reused:true,message_id:"provider-message-1"});
  expect(h.sends()).toHaveLength(1);
});

it("blocks a rejected/unsubscribed contact, including after a pipeline reset", async () => {
  await db.query("UPDATE purama_ai.partner_prospects SET status='rejected',has_replied=true WHERE id=$1",[prospect]);
  const h=harness();
  expect(await (await h.handler(request())).json()).toMatchObject({status:"blocked",reason:"contact_suppressed"});
  await db.query("UPDATE purama_ai.partner_prospects SET status='ready_to_contact',has_replied=false WHERE id=$1",[prospect]);
  expect(await (await h.handler(request())).json()).toMatchObject({status:"blocked",reason:"contact_suppressed"});
  expect(h.calls).toHaveLength(0);
});

it("preserves suppression after deletion and reimport with changed email casing", async () => {
  await db.query("UPDATE purama_ai.partner_prospects SET status='rejected' WHERE id=$1",[prospect]);
  await db.query("DELETE FROM purama_ai.partner_prospects WHERE id=$1",[prospect]);
  await db.query("INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status) VALUES ($1,$2,'Imported',' RECIPIENT@example.invalid ','ready_to_contact')",[prospect,user]);
  const h=harness();
  expect(await (await h.handler(request())).json()).toMatchObject({status:"blocked",reason:"contact_suppressed"});
  expect(h.calls).toHaveLength(0);
});

it("blocks replied contacts and inactive agents before paid drafting", async () => {
  await db.query("UPDATE purama_ai.partner_prospects SET has_replied=true WHERE id=$1",[prospect]);
  const h=harness();
  expect(await (await h.handler(request())).json()).toMatchObject({reason:"contact_has_replied"});
  await db.query("UPDATE purama_ai.partner_prospects SET has_replied=false WHERE id=$1",[prospect]);
  await db.query("UPDATE purama_ai.partner_agent_config SET is_active=false WHERE user_id=$1",[user]);
  expect(await (await h.handler(request())).json()).toMatchObject({reason:"agent_inactive"});
  expect(h.calls).toHaveLength(0);
});

it.each(["onDraft","onReady"] as const)("rechecks approval changed at %s", async (hook) => {
  const h=harness({[hook]:()=>db.query("UPDATE purama_ai.partner_agent_config SET require_approval_outreach=true WHERE user_id=$1",[user]).then(()=>undefined)});
  expect(await (await h.handler(request())).json()).toMatchObject({status:"pending_approval"});
  expect(h.sends()).toHaveLength(0);
});

it("rechecks opposition received while generation was running", async () => {
  const h=harness({onDraft:()=>db.query("UPDATE purama_ai.partner_prospects SET status='rejected',has_replied=true WHERE id=$1",[prospect]).then(()=>undefined)});
  expect(await (await h.handler(request())).json()).toMatchObject({status:"blocked",reason:"contact_suppressed"});
  expect(h.sends()).toHaveLength(0);
});

it("late provider acceptance cannot undo a reply or schedule a new follow-up", async () => {
  const h=harness({onProvider:()=>db.query("UPDATE purama_ai.partner_prospects SET status='rejected',has_replied=true,next_action_at=NULL WHERE id=$1",[prospect]).then(()=>undefined)});
  expect(await (await h.handler(request())).json()).toMatchObject({status:"sent"});
  expect((await db.query("SELECT status,has_replied,next_action_at FROM purama_ai.partner_prospects WHERE id=$1",[prospect])).rows)
    .toEqual([{status:"rejected",has_replied:true,next_action_at:null}]);
});

it.each(["timeout","missing_id","server_error"] as const)("keeps %s uncertain and never sends a second time", async (provider) => {
  const h=harness({provider});
  expect(await (await h.handler(request())).json()).toMatchObject({status:"unknown"});
  await db.exec("UPDATE purama_ai.partner_outreach_dispatches SET dispatch_started_at=now()-interval '25 hours'");
  expect(await (await h.handler(request())).json()).toMatchObject({status:"unknown"});
  expect(h.sends()).toHaveLength(1);
  expect((await db.query("SELECT status,sent_at,resend_message_id FROM purama_ai.partner_emails")).rows)
    .toEqual([{status:"unknown",sent_at:null,resend_message_id:null}]);
});

it.each(["before_commit","after_commit"] as const)("does not claim success or resend after acknowledgement lost %s", async (failCompletion) => {
  const h=harness({failCompletion});
  expect(await (await h.handler(request())).json()).toMatchObject({status:"unknown"});
  const second=await (await h.handler(request())).json();
  expect(second.status).toBe(failCompletion==="after_commit"?"sent":"unknown");
  expect(h.sends()).toHaveLength(1);
});

it("keeps an uncertain dispatch reserved after prospect deletion and reimport of the same identity", async () => {
  const h=harness({provider:"timeout"});
  expect(await (await h.handler(request())).json()).toMatchObject({status:"unknown"});
  await db.query("DELETE FROM purama_ai.partner_prospects WHERE id=$1",[prospect]);
  await db.query("INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status) VALUES ($1,$2,'Reimported','recipient@example.invalid','ready_to_contact')",[prospect,user]);
  expect(await (await h.handler(request())).json()).toMatchObject({status:"unknown"});
  expect(h.sends()).toHaveLength(1);
  expect(h.drafts()).toHaveLength(1);
});

it.each(["ok","timeout"] as const)("blocks %s attempts after deletion and reimport under a new ID with the same normalized email", async (provider) => {
  const h=harness({provider});
  expect(await (await h.handler(request())).json()).toMatchObject({status:provider === "ok" ? "sent" : "unknown"});
  await db.query("DELETE FROM purama_ai.partner_prospects WHERE id=$1",[prospect]);
  const imported="00000000-0000-4000-8000-000000000099";
  await db.query("INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status) VALUES ($1,$2,'Reimported',' RECIPIENT@example.invalid ','ready_to_contact')",[imported,user]);
  expect(await (await h.handler(request({prospect_id:imported}))).json()).toMatchObject({status:"blocked",reason:"previous_attempt_requires_review"});
  expect(h.sends()).toHaveLength(1);
  expect(h.drafts()).toHaveLength(1);
});

it("does not automatically retry a known provider rejection", async () => {
  const h=harness({provider:"rejected"});
  expect(await (await h.handler(request())).json()).toMatchObject({status:"failed"});
  expect(await (await h.handler(request())).json()).toMatchObject({status:"failed"});
  expect(h.sends()).toHaveLength(1);
});

it("uses authenticated identity and refuses another account's prospect", async () => {
  const h=harness();
  const response=await h.handler(request({prospect_id:otherProspect,user_id:other,require_approval_outreach:false}));
  expect(await response.json()).toMatchObject({status:"blocked",reason:"prospect_not_found"});
  expect(h.calls).toHaveLength(0);
});

it("rejects missing authentication and unauthorized step names without calls", async () => {
  const h=harness();
  expect((await h.handler(request({},"Bearer invalid"))).status).toBe(401);
  expect((await h.handler(request({prospect_id:prospect,type:"custom"}))).status).toBe(400);
  expect(h.calls).toHaveLength(0);
});

it("serializes the daily cap across different prospects and counts legacy sends", async () => {
  await db.query("UPDATE purama_ai.partner_agent_config SET daily_outreach_limit=1 WHERE user_id=$1",[user]);
  await db.query("UPDATE purama_ai.partner_prospects SET user_id=$1 WHERE id=$2",[user,otherProspect]);
  const h=harness();
  await Promise.all([h.handler(request()),h.handler(request({prospect_id:otherProspect}))]);
  expect(h.sends()).toHaveLength(1);
  expect((await db.query("SELECT count(*)::integer AS total FROM purama_ai.partner_outreach_dispatches WHERE dispatch_started_at IS NOT NULL")).rows)
    .toEqual([{total:1}]);
});

it("counts pre-migration outreach towards the daily cap", async () => {
  await db.query("UPDATE purama_ai.partner_agent_config SET daily_outreach_limit=1 WHERE user_id=$1",[user]);
  await db.query("UPDATE purama_ai.partner_prospects SET user_id=$1 WHERE id=$2",[user,otherProspect]);
  await db.query("INSERT INTO purama_ai.partner_emails(user_id,prospect_id,type,subject,body_html,status,sent_at) VALUES ($1,$2,'outreach','Old','Old','sent',now())",[user,otherProspect]);
  const h=harness();
  expect(await (await h.handler(request())).json()).toMatchObject({status:"blocked",reason:"daily_limit"});
  expect(h.sends()).toHaveLength(0);
});

it("does not replay a historical attempt whose provider outcome was never persisted", async () => {
  await db.query("INSERT INTO purama_ai.partner_emails(user_id,prospect_id,type,subject,body_html,status) VALUES ($1,$2,'outreach','Old','Old','draft')",[user,prospect]);
  const h=harness();
  expect(await (await h.handler(request())).json()).toMatchObject({status:"blocked",reason:"previous_attempt_requires_review"});
  expect(h.calls).toHaveLength(0);
});

it("fences a stale generation claim and reserves the same action on safe recovery", async () => {
  const first=await mustRpc("partner_outreach_reserve",{p_user_id:user,p_prospect_id:prospect,p_step:"outreach",p_claim_token:token});
  await db.exec("UPDATE purama_ai.partner_outreach_dispatches SET lease_until=now()-interval '1 minute'");
  const recovered=await mustRpc("partner_outreach_reserve",{p_user_id:user,p_prospect_id:prospect,p_step:"outreach",p_claim_token:laterToken});
  expect(recovered.action_id).toBe(first.action_id);
  expect(recovered.claimed).toBe(true);
  const stale=await mustRpc("partner_outreach_save_draft",{p_user_id:user,p_action_id:first.action_id,p_claim_token:token,p_subject:"Old",p_body_html:"Old"});
  expect(stale).toMatchObject({status:"blocked",reason:"stale_claim"});
  expect((await db.query("SELECT count(*)::integer AS total FROM purama_ai.partner_emails")).rows).toEqual([{total:0}]);
});

it("requires provider proof and the dispatch owner's token to finish", async () => {
  const ready=await prepare();
  await mustRpc("partner_outreach_begin_send",{p_user_id:user,p_action_id:ready.action_id,p_claim_token:token});
  expect((await rpc("partner_outreach_finish",{p_user_id:user,p_action_id:ready.action_id,p_claim_token:token,p_outcome:"sent"})).error).not.toBeNull();
  expect(await mustRpc("partner_outreach_finish",{p_user_id:user,p_action_id:ready.action_id,p_claim_token:laterToken,p_outcome:"sent",p_provider_message_id:"forged"}))
    .toMatchObject({status:"blocked",reason:"stale_claim"});
});

describe.each(["anon","authenticated"])("client permissions for %s",(role)=>{
  it("cannot reserve, approve, inspect another frozen payload, alter evidence, or erase suppressions",async()=>{
    const privileges=(await db.query<{allowed:boolean}>("SELECT has_function_privilege($1,'purama_ai.partner_outreach_reserve(uuid,uuid,text,uuid)','EXECUTE') AS allowed",[role])).rows;
    expect(privileges).toEqual([{allowed:false}]);
    await db.exec(`SET ROLE ${role}`);
    try {
      await expect(db.query("SELECT purama_ai.partner_outreach_reserve($1,$2,'outreach',$3)",[user,prospect,token])).rejects.toThrow(/permission denied/);
      await expect(db.query("SELECT purama_ai.partner_outreach_approve($1,$2,$3)",[user,prospect,token])).rejects.toThrow(/permission denied/);
      await expect(db.query("SELECT purama_ai.partner_outreach_result($1)",[prospect])).rejects.toThrow(/permission denied/);
      await expect(db.exec("DELETE FROM purama_ai.partner_outreach_suppressions")).rejects.toThrow(/permission denied/);
      await expect(db.exec("UPDATE purama_ai.partner_outreach_dispatches SET status='sent'")).rejects.toThrow(/permission denied/);
    } finally { await db.exec("RESET ROLE"); }
  });
});

it("reapplies the migration without losing evidence or reopening client permissions", async () => {
  const h=harness(); await h.handler(request());
  const before=(await db.query("SELECT * FROM purama_ai.partner_outreach_dispatches")).rows;
  await db.exec(migration);
  expect((await db.query("SELECT * FROM purama_ai.partner_outreach_dispatches")).rows).toEqual(before);
  expect((await db.query("SELECT has_function_privilege('authenticated','purama_ai.partner_outreach_finish(uuid,uuid,uuid,text,text)','EXECUTE') AS allowed")).rows).toEqual([{allowed:false}]);
});

it("the presentation layer rejects unproved sent statuses and unknown schemas",()=>{
  expect(()=>parseOutreachResult({status:"sent"})).toThrow(/Confirmation/);
  expect(()=>parseOutreachResult({ok:true})).toThrow(/Statut/);
  expect(()=>parseOutreachResult({status:"pending_approval",email_id:prospect})).toThrow(/Aperçu/);
  expect(outreachFeedback(parseOutreachResult({status:"unknown"})).kind).toBe("warning");
  expect(outreachFeedback(parseOutreachResult({status:"sent",message_id:"proof",reused:true})).title).toBe("Email déjà transmis");
});
