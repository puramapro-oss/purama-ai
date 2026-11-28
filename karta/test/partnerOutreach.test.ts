import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// Import the actual cross-runtime modules, not copied/extracted function bodies.
const handlerUrl = new URL("../../supabase/functions/partner-send-outreach/handler.ts", import.meta.url).href;
const securityUrl = new URL("../../supabase/functions/_shared/webhook-security.ts", import.meta.url).href;
const { verifyBearerSecret } = await import(/* @vite-ignore */ securityUrl);
const feedbackUrl = new URL("../../src/lib/partner-outreach-result.ts", import.meta.url).href;
const { createPartnerOutreachHandler } = await import(/* @vite-ignore */ handlerUrl);
const { parseOutreachResult, outreachFeedback, outreachStepForStatus } = await import(/* @vite-ignore */ feedbackUrl);
const historical = readFileSync(new URL("../../supabase/migrations/20260406230000_partner_agent.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../supabase/migrations/20261110030000_partner_outreach_reservations.sql", import.meta.url), "utf8");
const scheduleMigration = readFileSync(new URL("../../supabase/migrations/20261123020000_partner_outreach_schedule.sql", import.meta.url), "utf8");
const discoveryMigration = readFileSync(new URL("../../supabase/migrations/20261124050000_partner_discovery_evidence.sql", import.meta.url), "utf8");
const mediaPolicyMigration = readFileSync(new URL("../../supabase/migrations/20261124050100_partner_media_policy.sql", import.meta.url), "utf8");
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
  await db.exec(readFileSync(new URL("../../supabase/migrations/20260406210000_email_agent.sql", import.meta.url), "utf8"));
  await db.exec(migration);
  await db.exec(scheduleMigration);
  await db.exec(discoveryMigration);
  await db.exec(mediaPolicyMigration);
});

beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE purama_ai.partner_agent_config, purama_ai.partner_prospects, purama_ai.partner_outreach_suppressions CASCADE");
  await db.query(`INSERT INTO purama_ai.partner_agent_config
    (user_id,is_active,sender_name,sender_email,require_approval_new_prospect,require_approval_outreach)
    VALUES ($1,true,'Test Sender','sender@example.invalid',false,false),
      ($2,true,'Other Sender','other@example.invalid',false,false)`, [user, other]);
  // Keep non-schedule regressions independent of wall-clock execution time.
  // The time-zone/window cases below use explicit SQL timestamps instead.
  await db.exec("UPDATE purama_ai.partner_agent_config SET outreach_timezone='UTC',outreach_hours_start='00:00',outreach_hours_end='24:00',outreach_days=ARRAY['MO','TU','WE','TH','FR','SA','SU']");
  await db.query(`INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status)
    VALUES ($1,$2,'Test prospect','recipient@example.invalid','ready_to_contact'),
      ($3,$4,'Other prospect','other-recipient@example.invalid','ready_to_contact')`,
  [prospect,user,otherProspect,other]);
  await qualifyFixture(prospect, user);
  await qualifyFixture(otherProspect, other);
});
afterAll(async () => { await db?.close(); });

// Positive fixtures represent an operator-recorded, explicit opt-in. Discovery
// alone is deliberately never enough to make a recipient eligible for Resend.
async function qualifyFixture(id: string, owner: string) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner]);
  await db.exec('SET ROLE authenticated');
  try {
    const result = await db.query<{ value: Row }>("SELECT purama_ai.partner_prospect_qualify($1,$2::jsonb) AS value", [id, JSON.stringify({
      profile: 'legacy', role: 'commercial', source_url: 'https://fixture.example.invalid/contact',
      country: 'FR', language: 'fr', consent_reference: 'Fictitious explicit opt-in receipt for this owned test contact',
      consent_at: '2020-01-01T00:00:00Z', offer: {},
    })]);
    expect(result.rows[0].value).toMatchObject({ status: 'qualified' });
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
  }
}

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
const request = (body: Row = { prospect_id: prospect }, authorization = "Bearer valid-user", delegatedUserId?: string) => new Request("https://example.invalid/outreach", {
  method: "POST", headers: { Authorization: authorization, "Content-Type":"application/json", ...(delegatedUserId !== undefined ? {"X-Impersonate-User-Id":delegatedUserId} : {}) }, body: JSON.stringify(body),
});
async function prepare(id = prospect, claim = token): Promise<Row> {
  const reserved = await mustRpc("partner_outreach_reserve", { p_user_id:user,p_prospect_id:id,p_step:"outreach",p_claim_token:claim });
  return mustRpc("partner_outreach_save_draft", {
    p_user_id:user,p_action_id:reserved.action_id,p_claim_token:claim,p_subject:"Test",p_body_html:"<p>Test</p>",
  });
}

async function seedFollowupHistory(number: number) {
  for (let index = 0; index < number; index++) {
    const step = index === 0 ? 'outreach' : `relance_${index}`;
    if (index > 0) await db.query("UPDATE purama_ai.partner_prospects SET next_action_at=now()-interval '1 second' WHERE id=$1", [prospect]);
    const reserved = await mustRpc('partner_outreach_reserve', { p_user_id: user, p_prospect_id: prospect, p_step: step, p_claim_token: token });
    expect(reserved).toMatchObject({ status: 'preparing', claimed: true });
    let ready = await mustRpc('partner_outreach_save_draft', { p_user_id: user, p_action_id: reserved.action_id,
      p_claim_token: token, p_subject: 'Prior fixture subject', p_body_html: '<p>Previously recorded fixture email</p>' });
    if (ready.status === 'pending_approval') ready = await mustRpc('partner_outreach_approve', {
      p_user_id: user, p_email_id: ready.email_id, p_approval_version: (ready.approval as Row).version,
    });
    expect(await mustRpc('partner_outreach_begin_send', { p_user_id: user, p_action_id: ready.action_id, p_claim_token: token }))
      .toMatchObject({ status: 'sending', claimed: true });
    expect(await mustRpc('partner_outreach_finish', { p_user_id: user, p_action_id: ready.action_id,
      p_claim_token: token, p_outcome: 'sent', p_provider_message_id: `prior-provider-${index}` }))
      .toMatchObject({ status: 'sent' });
    // Distinct provider UUID and verified RFC Message-ID are intentional. The
    // reply suite separately verifies the real GET-provider binding operation.
    await db.query('UPDATE purama_ai.partner_outreach_dispatches SET rfc_message_id=$1 WHERE id=$2',
      [`<prior-fixture-${index}@example.invalid>`, ready.action_id]);
  }
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
    authenticateScheduled: (authToken: string) => verifyBearerSecret(`Bearer ${authToken}`, "server-scheduler-secret"),
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
    version:expect.any(String),from:"IAO — Purama <sender@example.invalid>",
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
  await qualifyFixture(otherProspect, user);
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
  ["email='changed@example.invalid'","contact_qualification_required","prospect"],
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

it('rejects the frozen recipient even when the replacement address was subsequently qualified', async () => {
  await requireApproval();
  const h = harness();
  const pending = await (await h.handler(request())).json();
  await db.query("UPDATE purama_ai.partner_prospects SET email='changed@example.invalid' WHERE id=$1", [prospect]);
  await qualifyFixture(prospect, user);
  expect(await (await h.handler(approvalRequest(pending))).json()).toMatchObject({ status: 'blocked', reason: 'recipient_changed' });
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
  await seedFollowupHistory(number);
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
  await qualifyFixture(otherProspect, user);
  const h=harness();
  await Promise.all([h.handler(request()),h.handler(request({prospect_id:otherProspect}))]);
  expect(h.sends()).toHaveLength(1);
  expect((await db.query("SELECT count(*)::integer AS total FROM purama_ai.partner_outreach_dispatches WHERE dispatch_started_at IS NOT NULL")).rows)
    .toEqual([{total:1}]);
});

it("counts pre-migration outreach towards the daily cap", async () => {
  await db.query("UPDATE purama_ai.partner_agent_config SET daily_outreach_limit=1 WHERE user_id=$1",[user]);
  await db.query("UPDATE purama_ai.partner_prospects SET user_id=$1 WHERE id=$2",[user,otherProspect]);
  await qualifyFixture(otherProspect, user);
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
  await db.exec(scheduleMigration);
  await db.exec(discoveryMigration);
  await db.exec(mediaPolicyMigration);
  expect((await db.query("SELECT * FROM purama_ai.partner_outreach_dispatches")).rows).toEqual(before);
  expect((await db.query("SELECT has_function_privilege('authenticated','purama_ai.partner_outreach_finish(uuid,uuid,uuid,text,text)','EXECUTE') AS allowed")).rows).toEqual([{allowed:false}]);
});

it("the presentation layer rejects unproved sent statuses and unknown schemas",()=>{
  expect(()=>parseOutreachResult({status:"sent"})).toThrow(/Confirmation/);
  expect(()=>parseOutreachResult({ok:true})).toThrow(/Statut/);
  expect(()=>parseOutreachResult({status:['sent'],message_id:'untrusted'})).toThrow(/Statut/);
  expect(()=>parseOutreachResult({status:"pending_approval",email_id:prospect})).toThrow(/Aperçu/);
  expect(outreachFeedback(parseOutreachResult({status:"unknown"})).kind).toBe("warning");
  expect(outreachFeedback(parseOutreachResult({status:"sent",message_id:"proof",reused:true})).title).toBe("Email déjà transmis");
});

// New cases exercise the same server handler and deployed SQL, not scheduler
// copies of the rules. Fixed timestamps cover timezone and DST semantics.
describe('account outreach schedules', () => {
  const reason = async (zone: string | null, start: string | null, end: string | null,
    days: (string | null)[] | null, at: string) => (await db.query<{ reason: string | null }>(
      'SELECT purama_ai.partner_outreach_schedule_reason($1,$2::time,$3::time,$4::text[],$5::timestamptz) AS reason',
      [zone,start,end,days,at],
    )).rows[0].reason;

  it.each([
    ['Europe/Paris','09:00','18:00',['MO'],'2026-11-23T08:00:00Z',null],
    ['Europe/Paris','09:00','18:00',['MO'],'2026-11-23T07:59:59Z','outside_outreach_hours'],
    ['Europe/Paris','09:00','18:00',['MO'],'2026-11-23T17:00:00Z','outside_outreach_hours'],
    ['America/New_York','09:00','18:00',['MO'],'2026-11-23T10:00:00Z','outside_outreach_hours'],
    ['America/New_York','09:00','18:00',['MO'],'2026-11-23T14:00:00Z',null],
    ['Asia/Kathmandu','09:00','10:00',['MO'],'2026-11-23T03:15:00Z',null],
    ['Pacific/Auckland','09:00','18:00',['TU'],'2026-11-23T20:00:00Z',null],
    ['UTC','09:00','18:00',['SA'],'2026-11-23T10:00:00Z','outside_outreach_hours'],
    ['UTC','22:00','02:00',['MO'],'2026-11-23T22:00:00Z',null],
    ['UTC','22:00','02:00',['MO'],'2026-11-24T01:59:59Z',null],
    ['UTC','22:00','02:00',['MO'],'2026-11-24T02:00:00Z','outside_outreach_hours'],
    ['UTC','22:00','02:00',['SU'],'2026-11-23T01:00:00Z',null],
    ['UTC','09:00','09:00',['MO'],'2026-11-23T10:00:00Z','outside_outreach_hours'],
    ['UTC','00:00','24:00',[],'2026-11-23T10:00:00Z','outside_outreach_hours'],
    ['Mars/Unknown','09:00','18:00',['MO'],'2026-11-23T10:00:00Z','invalid_outreach_schedule'],
    [null,'09:00','18:00',['MO'],'2026-11-23T10:00:00Z','invalid_outreach_schedule'],
    ['UTC',null,'18:00',['MO'],'2026-11-23T10:00:00Z','invalid_outreach_schedule'],
    ['UTC','09:00','18:00',['XX'],'2026-11-23T10:00:00Z','invalid_outreach_schedule'],
    ['UTC','09:00','18:00',[null],'2026-11-23T10:00:00Z','invalid_outreach_schedule'],
    ['UTC','09:00','18:00',null,'2026-11-23T10:00:00Z','invalid_outreach_schedule'],
    // Spring-forward: the missing local 02:30 never becomes an admitted time.
    ['Europe/Paris','02:00','03:00',['SU'],'2026-03-29T00:59:59Z','outside_outreach_hours'],
    ['Europe/Paris','02:00','03:00',['SU'],'2026-03-29T01:00:00Z','outside_outreach_hours'],
    // Fall-back: both instants map into the same wall-clock window, with one
    // durable prospect/step identity preventing another send on the second pass.
    ['Europe/Paris','02:00','03:00',['SU'],'2026-10-25T00:30:00Z',null],
    ['Europe/Paris','02:00','03:00',['SU'],'2026-10-25T01:30:00Z',null],
  ] as const)('checks %s %s-%s %j at %s', async (zone,start,end,days,at,expected) => {
    expect(await reason(zone,start,end,days ? [...days] : null,at)).toBe(expected);
  });

  it('refuses paid preparation outside an admitted window', async () => {
    await db.query("UPDATE purama_ai.partner_agent_config SET outreach_days='{}' WHERE user_id=$1",[user]);
    const h=harness();
    expect(await (await h.handler(request())).json()).toMatchObject({status:'blocked',reason:'outside_outreach_hours'});
    expect(h.calls).toHaveLength(0);
  });

  it('rechecks a closed window at dispatch and later resumes the same frozen draft', async () => {
    const h=harness({onReady:async()=>{
      await db.query("UPDATE purama_ai.partner_agent_config SET outreach_days='{}' WHERE user_id=$1",[user]);
    }});
    expect(await (await h.handler(request())).json()).toMatchObject({status:'blocked',reason:'outside_outreach_hours'});
    expect(h.sends()).toHaveLength(0);
    const saved=(await db.query<{id:string;status:string;payload:Row}>('SELECT id,status,payload FROM purama_ai.partner_outreach_dispatches')).rows;
    expect(saved).toMatchObject([{status:'ready'}]);
    await db.query("UPDATE purama_ai.partner_agent_config SET outreach_days=ARRAY['MO','TU','WE','TH','FR','SA','SU'] WHERE user_id=$1",[user]);
    expect(await (await h.handler(request())).json()).toMatchObject({status:'sent'});
    expect(h.drafts()).toHaveLength(1);
    expect(h.sends()).toHaveLength(1);
    expect((await db.query('SELECT id,payload FROM purama_ai.partner_outreach_dispatches')).rows)
      .toEqual(saved.map(({id,payload})=>({id,payload})));
  });

  it('preserves exact approval when its send waits for the next allowed window', async () => {
    await requireApproval();
    // Manual preparation is allowed for this account's identified prospect.
    // Merely discovering it must not enroll it in automatic first contact.
    await db.query("UPDATE purama_ai.partner_prospects SET status='identified' WHERE id=$1",[prospect]);
    expect((await db.query("SELECT * FROM purama_ai.partner_outreach_due('outreach',100)")).rows)
      .not.toContainEqual({prospect_id:prospect,user_id:user,step:'outreach'});
    const h=harness();
    const pending=await (await h.handler(request())).json();
    await db.query("UPDATE purama_ai.partner_agent_config SET outreach_days='{}' WHERE user_id=$1",[user]);
    expect(await (await h.handler(approvalRequest(pending))).json())
      .toMatchObject({status:'blocked',reason:'outside_outreach_hours'});
    expect((await db.query('SELECT status,approved_at IS NOT NULL AS approved FROM purama_ai.partner_outreach_dispatches')).rows)
      .toEqual([{status:'ready',approved:true}]);
    expect(h.sends()).toHaveLength(0);
    await db.query("UPDATE purama_ai.partner_agent_config SET outreach_days=ARRAY['MO','TU','WE','TH','FR','SA','SU'] WHERE user_id=$1",[user]);
    expect((await db.query("SELECT * FROM purama_ai.partner_outreach_due('outreach',100)")).rows)
      .toContainEqual({prospect_id:prospect,user_id:user,step:'outreach'});
    expect(await (await h.handler(request())).json()).toMatchObject({status:'sent'});
    expect(h.drafts()).toHaveLength(1);
    expect(h.sends()).toHaveLength(1);
  });

  it('counts the selected calendar day and legacy sends across local midnight', async () => {
    await db.query(`INSERT INTO purama_ai.partner_emails(user_id,prospect_id,type,subject,body_html,status,sent_at)
      VALUES ($1,$2,'outreach','Fictitious','Fictitious','sent','2026-11-23T14:50:00Z')`,[user,otherProspect]);
    const counts=(await db.query(`SELECT
      purama_ai.partner_outreach_daily_count($1,'UTC','2026-11-23T16:00:00Z')::integer AS utc,
      purama_ai.partner_outreach_daily_count($1,'Asia/Tokyo','2026-11-23T16:00:00Z')::integer AS tokyo`,[user])).rows;
    expect(counts).toEqual([{utc:1,tokyo:0}]);
  });

  it('selects all eligible accounts and no unscheduled, exhausted or already reserved candidate', async () => {
    const due=()=>db.query('SELECT * FROM purama_ai.partner_outreach_due($1,$2)',['outreach',100]);
    expect((await due()).rows).toHaveLength(2);
    await db.query("UPDATE purama_ai.partner_agent_config SET outreach_timezone='Invalid/Zone' WHERE user_id=$1",[other]);
    expect((await due()).rows).toEqual([{prospect_id:prospect,user_id:user,step:'outreach'}]);
    await requireApproval(); const h=harness(); await h.handler(request());
    expect((await due()).rows).toEqual([]);
    await expect(db.query("SELECT * FROM purama_ai.partner_outreach_due('outreach',101)")).rejects.toThrow(/Invalid scheduler query/);
  });

  it('selects only due follow-ups and rechecks opposition when their queued call reaches the server', async () => {
    await seedFollowupHistory(1);
    await db.query("UPDATE purama_ai.partner_prospects SET status='contacted',first_contact_at=now()-interval '5 days',next_action_at=now()-interval '1 day',relance_count=0 WHERE id=$1",[prospect]);
    expect((await db.query("SELECT * FROM purama_ai.partner_outreach_due('followup',100)")).rows)
      .toEqual([{prospect_id:prospect,user_id:user,step:'relance_1'}]);
    await db.query("UPDATE purama_ai.partner_prospects SET status='rejected',has_replied=true WHERE id=$1",[prospect]);
    const h=harness();
    expect(await (await h.handler(request({prospect_id:prospect,type:'relance_1'},'Bearer server-scheduler-secret',user))).json())
      .toMatchObject({status:'blocked',reason:'contact_suppressed'});
    expect(h.calls).toHaveLength(0);
  });

  it.each(['anon','authenticated'])('does not expose scheduler discovery or private quota helpers to %s',async role=>{
    await db.exec(`SET ROLE ${role}`);
    try {
      await expect(db.query("SELECT * FROM purama_ai.partner_outreach_due('outreach',100)")).rejects.toThrow(/permission denied/);
      await expect(db.query("SELECT purama_ai.partner_outreach_daily_count($1,'UTC',now())",[user])).rejects.toThrow(/permission denied/);
    } finally { await db.exec('RESET ROLE'); }
  });
});

describe('bounded scheduler delegation', () => {
  it('accepts a real server delegation and preserves account ownership and the existing send gate', async () => {
    const h=harness();
    expect(await (await h.handler(request({prospect_id:otherProspect},'Bearer server-scheduler-secret',user))).json())
      .toMatchObject({status:'blocked',reason:'prospect_not_found'});
    expect(h.calls).toHaveLength(0);
    expect(await (await h.handler(request({prospect_id:prospect,user_id:other},'Bearer server-scheduler-secret',user))).json())
      .toMatchObject({status:'sent'});
    expect(h.sends()).toHaveLength(1);
    expect(h.sends()[0].body.to).toBe('recipient@example.invalid');
  });
  it.each([
    ['Bearer valid-user',user], ['Bearer wrong-service-secret',user],
    ['Bearer server-scheduler-secret',''], ['Bearer server-scheduler-secret','not-a-uuid'],
  ])('rejects an unauthenticated delegation (%s) before providers',async (authorization,delegated)=>{
    const h=harness();
    expect((await h.handler(request({prospect_id:prospect},authorization,delegated))).status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });
  it('requires the user to approve, even when the scheduler has the valid service secret', async () => {
    await requireApproval();
    const h=harness();
    const pending=await (await h.handler(request({prospect_id:prospect},'Bearer server-scheduler-secret',user))).json();
    expect(pending.status).toBe('pending_approval');
    expect((await h.handler(request({action:'approve',email_id:pending.email_id,approval_version:pending.approval.version},
      'Bearer server-scheduler-secret',user))).status).toBe(403);
    expect(h.sends()).toHaveLength(0);
    expect((await db.query('SELECT approved_at FROM purama_ai.partner_outreach_dispatches')).rows).toEqual([{approved_at:null}]);
  });
});

it('uses admission wall time after the transaction started for its counted dispatch', async () => {
  await db.exec('BEGIN');
  try {
    const ready=await prepare();
    const clock=(await db.query<{at:string}>('SELECT clock_timestamp()::text AS at')).rows[0].at;
    expect(await mustRpc('partner_outreach_begin_send',{p_user_id:user,p_action_id:ready.action_id,p_claim_token:token}))
      .toMatchObject({status:'sending'});
    const actual=(await db.query<{current:boolean}>(
      'SELECT dispatch_started_at >= $1::timestamptz AS current FROM purama_ai.partner_outreach_dispatches',[clock],
    )).rows;
    expect(actual).toEqual([{current:true}]);
  } finally { await db.exec('ROLLBACK'); }
});

it('bounds discovery per account by remaining quota and five candidate drafts per run', async () => {
  for(let i=0;i<9;i++) {
    const inserted = await db.query<{ id: string }>(`INSERT INTO purama_ai.partner_prospects(user_id,name,email,status)
      VALUES ($1,'Additional fictitious recipient',$2,'ready_to_contact') RETURNING id`,[user,`candidate${i}@example.invalid`]);
    await qualifyFixture(inserted.rows[0].id, user);
  }
  const due=()=>db.query<{user_id:string}>("SELECT * FROM purama_ai.partner_outreach_due('outreach',100)");
  expect((await due()).rows.filter(r=>r.user_id===user)).toHaveLength(5);
  await db.query('UPDATE purama_ai.partner_agent_config SET daily_outreach_limit=2 WHERE user_id=$1',[user]);
  expect((await due()).rows.filter(r=>r.user_id===user)).toHaveLength(2);
  await db.query('UPDATE purama_ai.partner_agent_config SET daily_outreach_limit=0 WHERE user_id=$1',[user]);
  const h=harness();
  expect(await (await h.handler(request())).json()).toMatchObject({status:'blocked',reason:'daily_limit'});
  expect(h.drafts()).toHaveLength(0);
  expect((await due()).rows).toEqual([{prospect_id:otherProspect,user_id:other,step:'outreach'}]);
});

it('isolates malformed multidimensional day arrays to their account during candidate discovery', async () => {
  await db.query("UPDATE purama_ai.partner_agent_config SET outreach_days=ARRAY[['MO','TU']]::text[] WHERE user_id=$1",[other]);
  expect((await db.query("SELECT purama_ai.partner_outreach_schedule_reason('UTC','00:00','24:00',ARRAY[['MO','TU']]::text[],now()) AS reason")).rows)
    .toEqual([{reason:'invalid_outreach_schedule'}]);
  expect((await db.query("SELECT * FROM purama_ai.partner_outreach_due('outreach',100)")).rows)
    .toEqual([{prospect_id:prospect,user_id:user,step:'outreach'}]);
});
