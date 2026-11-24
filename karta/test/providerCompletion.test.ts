import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { AgentDecision, AgentDefinition, AgentRunResult, AgentType, ToolCallRecord } from "../src/engine/types.js";

const h = vi.hoisted(() => ({
  db: null as PGlite | null,
  definition: null as AgentDefinition | null,
  decision: null as AgentDecision | null,
  finish: vi.fn(), record: vi.fn(), following: vi.fn(),
  config: { docusealApiKey: "test-only-docuseal", docusealBaseUrl: "https://docuseal.example.invalid" },
}));

function database() {
  if (!h.db) throw new Error("Provider completion database is not initialized");
  return h.db;
}

// Only the Supabase transport is adapted: claims, finalization, outbox and quota
// reservations execute the production PostgreSQL functions in PGlite.
function rpc(name: string, params: Record<string, unknown>) {
  const signatures: Record<string, string[]> = {
    karta_claim_pending_action_bounded: ["p_id", "p_decision"],
    karta_finalize_pending_action: ["p_id", "p_status", "p_summary"],
    karta_reserve_daily_counter: ["p_user_id", "p_counter_key", "p_day", "p_limit"],
    partner_direct_send_guard: ["p_user_id", "p_recipient", "p_parent_gmail_id", "p_gmail_thread_id"],
  };
  const keys = signatures[name];
  if (!keys) throw new Error(`Unexpected test RPC: ${name}`);
  const response = (async () => {
    const sql = `SELECT * FROM purama_ai.${name}(${keys.map((_, i) => `$${i + 1}`).join(",")})`;
    const { rows } = await database().query<Record<string, unknown>>(sql, keys.map(key => params[key]));
    return { data: name === "karta_finalize_pending_action" ? rows : rows[0]?.[name], error: null };
  })();
  return Object.assign(response, { abortSignal: (_signal: AbortSignal) => response });
}

function select(table: string) {
  const columnsByTable: Record<string, string[]> = {
    karta_runs: ["tools_used", "id", "user_id", "agent_type"],
    email_agent_config: ["id", "user_id", "gmail_email", "updated_at", "gmail_refresh_token", "gmail_access_token", "gmail_token_expiry"],
  };
  const allowed = columnsByTable[table];
  if (!allowed) throw new Error(`Unexpected test table: ${table}`);
  let columns: string[] = [];
  const filters: Array<[string, unknown]> = [];
  const read = async () => {
    const where = filters.map(([column], i) => `${column} = $${i + 1}`).join(" AND ");
    const { rows } = await database().query<Record<string, unknown>>(
      `SELECT ${columns.join(",")} FROM purama_ai.${table} WHERE ${where}`, filters.map(([, value]) => value),
    );
    if (rows.length > 1) throw new Error("Test query must select at most one row");
    return { data: rows[0] ?? null, error: null };
  };
  const builder = {
    select(value: string) {
      columns = value.split(",");
      if (columns.some(column => !allowed.includes(column))) throw new Error("Unexpected selected column");
      return builder;
    },
    eq(column: string, value: unknown) {
      if (!allowed.includes(column)) throw new Error("Unexpected filter column");
      filters.push([column, value]);
      return builder;
    },
    abortSignal: (_signal: AbortSignal) => builder,
    single: read,
    maybeSingle: read,
  };
  return builder;
}

vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc, from: select } }));
vi.mock("../src/config.js", () => ({ config: h.config }));
vi.mock("../src/lib/gmail-token-crypto.js", () => ({ decryptGmailToken: (token: string) => token, encryptGmailToken: (token: string) => token }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: async () => h.decision }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async (userId: string, agentType: AgentType) => ({
    userId, agentType, isEnabled: true, killSwitch: false, simulationMode: false, autonomyLevel: 3,
  }),
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "00000000-0000-4000-8000-000000000002", finish: h.finish }) }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => undefined }));
vi.mock("../src/engine/resolveDefinition.js", () => ({
  resolveAgentDefinition: async () => {
    if (!h.definition) throw new Error("Missing test definition");
    return h.definition;
  },
  CustomAgentAuthorizationError: class extends Error {},
}));

const { runAgentCycle } = await import("../src/engine/loop.js");
const { resolvePendingAction } = await import("../src/engine/approval.js");
const { docusealCreateSubmissionTool } = await import("../src/tools/docuseal.js");
const { gmailSendTool } = await import("../src/tools/gmail.js");

const uid = "00000000-0000-4000-8000-000000000001";
const rid = "00000000-0000-4000-8000-000000000002";
const aid = "00000000-0000-4000-8000-000000000003";
const send = vi.fn<typeof fetch>();
const signer = "signer@example.test";
const docusealInput = { templateId: "12", signerName: "Signer", signerEmail: signer };
const gmailInput = { to: signer, subject: "Completion fixture", body: "Reply fixture", threadId: "thread-1", replyToMessageId: "parent-1" };
const scenarios = [
  { name: "DocuSeal", type: "legal", tool: docusealCreateSubmissionTool, params: docusealInput,
    timeoutMs: 20_000, url: "https://docuseal.example.invalid/api/submissions",
    receipt: [{ id: 17, submission_id: 42, email: signer }],
    unconfirmed: "Création DocuSeal non confirmée : vérifier la demande avant toute reprise" },
  { name: "Gmail", type: "email", tool: gmailSendTool, params: gmailInput,
    timeoutMs: 40_000, url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    receipt: { id: "sent-42" },
    unconfirmed: "Envoi Gmail non confirmé : vérifier son état avant toute reprise" },
] as const;
type Scenario = typeof scenarios[number];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function definition(scenario: Scenario): AgentDefinition {
  const result: AgentDefinition = {
    type: scenario.type, systemPrompt: "Deterministic provider completion fixture", buildContext: async () => ({}),
    tools: [scenario.tool, { name: "following_step", description: "Next dependent effect", sensitive: false, execute: h.following }],
  };
  h.definition = result;
  // The model is stubbed; mock:false exercises the live tool control flow.
  h.decision = { summary: "Create the request, then continue", requiresApproval: false, mock: false,
    toolCalls: [{ tool: scenario.tool.name, params: { ...scenario.params } }, { tool: "following_step", params: {} }] };
  return result;
}

function provider(scenario: Scenario, response: Response | Promise<Response>) {
  const started = deferred<RequestInit>();
  send.mockImplementation(async (url, init) => {
    if (scenario.name === "Gmail" && String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/messages/parent-1?format=full"
      && (init?.method === undefined || init.method === "GET")) {
      const body = Buffer.from("Parent fixture");
      return Response.json({ id: "parent-1", threadId: "thread-1", payload: {
        mimeType: "text/plain", body: { data: body.toString("base64url"), size: body.length },
        headers: [{ name: "Subject", value: gmailInput.subject }, { name: "From", value: signer },
          { name: "Message-ID", value: "<parent@example.test>" }],
      } });
    }
    if (String(url) !== scenario.url || init?.method !== "POST") throw new Error("Unexpected provider request in test");
    started.resolve(init);
    // Deliberately ignore AbortSignal to exercise a non-cooperative transport.
    return response;
  });
  return started.promise;
}

function posts() { return send.mock.calls.filter(([, init]) => init?.method === "POST"); }

function expectStopped(result: AgentRunResult, scenario: Scenario) {
  expect(result).toMatchObject({ status: "error", retryable: false, mock: false });
  expect(result.toolsUsed).toEqual([
    expect.objectContaining({ tool: scenario.tool.name, outcome: "failed", success: false, resultSummary: scenario.unconfirmed }),
    expect.objectContaining({ tool: "following_step", outcome: "skipped", success: false }),
  ]);
  expect(h.following).not.toHaveBeenCalled();
  expect(h.finish).toHaveBeenCalledExactlyOnceWith(result);
  expect(h.record).toHaveBeenCalledOnce();
  expect(posts()).toHaveLength(1);
}

async function seedApproval(scenario: Scenario) {
  definition(scenario);
  const entry = { tool: scenario.tool.name, success: false, outcome: "pending", pendingActionId: aid };
  await database().query(
    "INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode,status,duration_ms,tools_used) VALUES($1,$2,$3,'manual','live','awaiting_approval',1,$4)",
    [rid, uid, scenario.type, JSON.stringify([entry])],
  );
  await database().query(
    "INSERT INTO purama_ai.karta_pending_actions(id,user_id,run_id,agent_type,tool_name,tool_params) VALUES($1,$2,$3,$4,$5,$6)",
    [aid, uid, rid, scenario.type, scenario.tool.name, JSON.stringify(scenario.params)],
  );
}

async function approvalState() {
  const action = (await database().query<{ status: string }>("SELECT status FROM purama_ai.karta_pending_actions WHERE id=$1", [aid])).rows[0];
  const run = (await database().query<{ status: string; tools_used: ToolCallRecord[] }>("SELECT status,tools_used FROM purama_ai.karta_runs WHERE id=$1", [rid])).rows[0];
  const outbox = (await database().query("SELECT pending_action_id,resolution,status FROM purama_ai.karta_approval_outbox")).rows;
  const counters = (await database().query("SELECT counter_key,count FROM purama_ai.karta_daily_counters")).rows;
  return { action, run, outbox, counters };
}

async function expectFailedApproval(scenario: Scenario) {
  const state = await approvalState();
  expect(state.action.status).toBe("failed");
  expect(state.run.status).toBe("error");
  expect(state.run.tools_used).toEqual([
    expect.objectContaining({ tool: scenario.tool.name, outcome: "failed", success: false, pendingActionId: aid }),
  ]);
  expect(state.outbox).toEqual([]);
  expect(state.counters).toEqual(scenario.name === "Gmail" ? [{ counter_key: "gmail_send", count: 1 }] : []);
  expect(posts()).toHaveLength(1);
  return state;
}

beforeAll(async () => {
  h.db = new PGlite();
  await database().exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'; CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  for (const file of ["001_karta_core.sql", "002_karta_global_kill_switch.sql", "005_karta_pending_actions.sql", "006_execution_claims.sql",
    "007_runtime_hardening.sql", "019_karta_approval_parent_guard.sql", "020_execution_fingerprints.sql",
    "026_pending_action_execution_origin.sql", "027_approval_continuation_outbox.sql"]) {
    await database().exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  // Cached OAuth fixture only: no refresh or external credentials are used.
  await database().exec("CREATE TABLE purama_ai.email_agent_config (id uuid PRIMARY KEY, user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE, gmail_email text, updated_at text, gmail_refresh_token text, gmail_access_token text, gmail_token_expiry text)");
  // Scope this provider-completion fixture to empty partner history, while
  // executing the real classifier rather than mocking an authorization result.
  await database().exec(`
    CREATE TABLE purama_ai.partner_prospects(id uuid,user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,email text,outreach_profile text,status text,email_permission jsonb);
    CREATE TABLE purama_ai.partner_active(user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,prospect_id uuid,partner_email text);
    CREATE TABLE purama_ai.partner_outreach_dispatches(id uuid,user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,prospect_id uuid,recipient text,policy_snapshot jsonb);
    CREATE TABLE purama_ai.partner_outreach_suppressions(user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,email_normalized text);
    CREATE TABLE purama_ai.partner_reply_receipts(user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,action_id uuid,prospect_id uuid,gmail_message_id text,gmail_thread_id text,kind text);
    CREATE TABLE purama_ai.partner_reply_drafts(user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,gmail_message_id text,payload jsonb,policy_snapshot jsonb);
  `);
  await database().exec(await readFile(new URL("../../supabase/migrations/20261124050600_partner_direct_send_guard.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  vi.clearAllMocks();
  send.mockReset();
  vi.stubGlobal("fetch", send);
  h.finish.mockResolvedValue(undefined);
  h.record.mockResolvedValue(undefined);
  h.following.mockResolvedValue({ ok: true });
  h.definition = null;
  h.decision = null;
  await database().exec("TRUNCATE auth.users CASCADE; INSERT INTO purama_ai.karta_global_state(id,kill_switch) VALUES('global',false) ON CONFLICT(id) DO UPDATE SET kill_switch=false;");
  await database().query("INSERT INTO auth.users VALUES($1)", [uid]);
  for (const agentType of ["legal", "email"]) {
    await database().query("INSERT INTO purama_ai.karta_agent_state(user_id,agent_type,simulation_mode,autonomy_level) VALUES($1,$2,false,3)", [uid, agentType]);
  }
  await database().query("INSERT INTO purama_ai.email_agent_config VALUES($1,$1,$2,$3,'fixture-refresh-token','fixture-access-token',$4)",
    [uid, "owner@example.test", new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString()]);
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(async () => { await h.db?.close(); });

describe("real provider tools through the agent loop", () => {
  it("rejects an invalid DocuSeal receipt before the next effect and disables replay", async () => {
    const scenario = scenarios[0];
    provider(scenario, Response.json([{ id: 17, email: signer }]));
    const result = await runAgentCycle(uid, definition(scenario), { type: "manual", source: "provider-completion-test" });
    expectStopped(result, scenario);
  });

  it.each(scenarios)("$name: timeout stops the cycle and a late receipt cannot start another effect", async scenario => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const late = deferred<Response>();
    const started = provider(scenario, late.promise);
    const pending = runAgentCycle(uid, definition(scenario), { type: "manual", source: "provider-completion-test" });
    const request = await started;
    await vi.advanceTimersByTimeAsync(scenario.timeoutMs);
    const result = await pending;
    expect(request.signal?.aborted).toBe(true);
    expectStopped(result, scenario);
    const recorded = JSON.stringify(result);
    const response = Response.json(scenario.receipt);
    const cancel = vi.spyOn(response.body!, "cancel");
    late.resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).toBe(recorded);
    expectStopped(result, scenario);
  });

  it("continues after a valid DocuSeal receipt, proving that the fixture permits completion", async () => {
    const scenario = scenarios[0];
    provider(scenario, Response.json(scenario.receipt));
    const result = await runAgentCycle(uid, definition(scenario), { type: "manual", source: "provider-completion-test" });
    expect(result).toMatchObject({ status: "success", retryable: false });
    expect(result.toolsUsed.map(tool => tool.outcome)).toEqual(["executed", "executed"]);
    expect(result.toolsUsed[0].resultSummary).toBe('{"submissionId":"42"}');
    expect(h.following).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(result);
    expect(posts()).toHaveLength(1);
  });
});

describe("real provider tools through durable PostgreSQL approvals", () => {
  it("persists DocuSeal's explicit failure and rejects a second approval without another POST", async () => {
    const scenario = scenarios[0];
    await seedApproval(scenario);
    provider(scenario, Response.json([{ submission_id: 42, email: signer, success: false }]));
    expect(await resolvePendingAction(aid, "approve")).toEqual({ ok: false, error: scenario.unconfirmed });
    const failed = await expectFailedApproval(scenario);
    expect((await resolvePendingAction(aid, "approve")).ok).toBe(false);
    expect(await approvalState()).toEqual(failed);
    expect(posts()).toHaveLength(1);
  });

  it.each(scenarios)("$name: expired POST remains failed and non-replayable after a late receipt", async scenario => {
    await seedApproval(scenario);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const late = deferred<Response>();
    const started = provider(scenario, late.promise);
    const pending = resolvePendingAction(aid, "approve");
    const request = await started;
    await vi.advanceTimersByTimeAsync(scenario.timeoutMs);
    expect(await pending).toEqual({ ok: false, error: scenario.unconfirmed });
    expect(request.signal?.aborted).toBe(true);
    const failed = await expectFailedApproval(scenario);
    expect((await resolvePendingAction(aid, "approve")).ok).toBe(false);
    const response = Response.json(scenario.receipt);
    const cancel = vi.spyOn(response.body!, "cancel");
    late.resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect((await resolvePendingAction(aid, "approve")).ok).toBe(false);
    expect(await approvalState()).toEqual(failed);
    await expectFailedApproval(scenario);
  });

  it("commits one successful DocuSeal receipt and one continuation, without replaying its POST", async () => {
    const scenario = scenarios[0];
    await seedApproval(scenario);
    provider(scenario, Response.json(scenario.receipt));
    expect(await resolvePendingAction(aid, "approve")).toEqual({ ok: true, resultSummary: '{"submissionId":"42"}' });
    const state = await approvalState();
    expect(state.action.status).toBe("executed");
    expect(state.run.status).toBe("success");
    expect(state.run.tools_used[0]).toMatchObject({ tool: scenario.tool.name, success: true, outcome: "executed" });
    expect(state.outbox).toEqual([{ pending_action_id: aid, resolution: "executed", status: "pending" }]);
    expect((await resolvePendingAction(aid, "approve")).ok).toBe(false);
    expect(await approvalState()).toEqual(state);
    expect(posts()).toHaveLength(1);
  });
});
