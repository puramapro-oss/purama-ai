import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import type { AgentDecision, AgentRunResult, AgentState } from "../src/engine/types.js";
import type { SocialStatusResult } from "../src/tools/social-status.js";

const h = vi.hoisted(() => ({
  dbFetch: vi.fn<typeof fetch>(), modelFetch: vi.fn<typeof fetch>(),
  state: {} as AgentState, isMock: false as boolean | undefined,
  claim: vi.fn(), peek: vi.fn(), arm: vi.fn(), finish: vi.fn(), record: vi.fn(),
  notify: vi.fn(), pending: vi.fn(), decide: vi.fn<(input: ClaudeDecideInput) => Promise<AgentDecision>>(),
  accounts: [] as Array<Record<string, unknown>>, posts: [] as Array<Record<string, unknown>>,
  unavailable: new Set<string>(), events: [] as string[],
}));

vi.mock("../src/config.js", () => ({ config: {
  get mockClaude() { return h.isMock; },
  anthropicApiKey: "social-cycle-fixture-not-a-secret", anthropicTimeoutMs: 60_000,
  anthropicModelMain: "social-fixture-main", anthropicModelFast: "social-fixture-fast",
} }));
// Preserve both real SDKs and the real reader. Only their network boundaries
// are replaced; no test can contact a database or model provider.
vi.mock("../src/db/supabase.js", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  return { supabase: createClient("https://social-cycle-database.invalid", "social-cycle-db-fixture", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => h.dbFetch(input, init) },
  }) };
});
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ isMock: h.isMock, decide: h.decide }) }));
vi.mock("../src/engine/brief.js", () => ({ claimPendingBrief: h.claim, peekPendingBrief: h.peek, armPendingBrief: h.arm }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async () => ({ ...h.state }), recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "social-cycle-run", finish: h.finish }) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));

const { runAgentCycle } = await import("../src/engine/loop.js");
const { maitreDesPublicites } = await import("../src/agents/actionAgents.js");
const { buildSocialBriefContext } = await import("../src/agents/social-status-context.js");
const { generatePdfTool } = await import("../src/tools/pdf.js");
const { createRealClaudeClient } = await import("../src/claude/real.js");

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRIEF = "PRIVATE_SOCIAL_BRIEF_FOR_THE_AUTHORIZED_MODEL";
const PRIVATE = "PRIVATE_RAW_DATABASE_CONTENT_MUST_NOT_ESCAPE";
const PROVIDER_ID = "social_provider_receipt_private_reference";
const trigger = { type: "manual" as const, source: "social-cycle-test" };
type Page = SocialStatusResult | { status: "unavailable"; resource: "accounts" | "posts" };
interface Context {
  items: Array<{ brief: string }>;
  socialStatus?: {
    availability: "available" | "partial" | "unavailable";
    coverage: "bounded_first_pages_by_id";
    atomicSnapshot: false;
    limits: { accounts: number; posts: number };
    providerHealth: "not_checked";
    liveProviderCheckPerformed: false;
    publicationPerformed: false;
    accounts: Page; posts: Page;
  };
}
function postId(index: number): string { return `bbbbbbbb-bbbb-4bbb-8bbb-${index.toString(16).padStart(12, "0")}`; }
function account(): Record<string, unknown> {
  return { id: ACCOUNT, user_id: USER, platform: "instagram", is_active: true,
    connected_at: "2026-11-20T10:00:00+00:00", publishing_verified_at: null,
    disconnect_pending: false, account_username: PRIVATE, metadata: { secret: PRIVATE } };
}
function post(index = 1): Record<string, unknown> {
  return { id: postId(index), user_id: USER, status: "publish_unconfirmed", target_platforms: ["instagram"],
    scheduled_at: null, published_at: null, created_at: "2026-11-21T12:00:00+00:00",
    updated_at: "2026-11-21T12:01:00+00:00", zernio_post_id: PROVIDER_ID,
    content_text: PRIVATE, zernio_response: { secret: PRIVATE }, error_message: PRIVATE };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
function modelRequest() {
  const [input, init] = h.modelFetch.mock.calls[0]!;
  const body = JSON.parse(String(init?.body)) as {
    messages: Array<{ content: string }>;
    tools: Array<{ name: string }>;
  };
  const content = body.messages[0]!.content;
  const prefix = "Contexte actuel:\n";
  const suffix = "\n\nDécide quelle(s) action(s) prendre.";
  expect(content.startsWith(prefix)).toBe(true);
  expect(content.endsWith(suffix)).toBe(true);
  return { input, body, context: JSON.parse(content.slice(prefix.length, -suffix.length)) as Context };
}
function outputParagraphs(context: Context): string[] {
  const page = context.socialStatus?.posts;
  const item = page?.status === "read" ? page.items.find(item => "postId" in item) : undefined;
  return item && "postId" in item
    ? [`Publication ${item.postId} : ${item.status}.`]
    : ["Les métadonnées de publication ne sont pas disponibles dans cet aperçu."];
}
function assertPrivateTrace(result: AgentRunResult): void {
  const traces = JSON.stringify([result, h.finish.mock.calls, h.notify.mock.calls]);
  for (const value of [BRIEF, ACCOUNT, postId(1), PROVIDER_ID, PRIVATE]) expect(traces).not.toContain(value);
}
async function run(payload?: Record<string, unknown>) {
  return await runAgentCycle(USER, maitreDesPublicites, { ...trigger, ...(payload ? { payload } : {}) }, "social-cycle-delivery");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isMock = false; h.events = []; h.accounts = [account()]; h.posts = [post()]; h.unavailable = new Set();
  h.state = { userId: USER, agentType: "maitre-des-publicites", isEnabled: true,
    autonomyLevel: 3, killSwitch: false, simulationMode: false };
  h.claim.mockImplementation(async () => { h.events.push("claim"); return { brief: BRIEF, briefId: "social-brief" }; });
  h.peek.mockImplementation(async () => { h.events.push("peek"); return { brief: BRIEF, briefId: "social-brief" }; });
  h.arm.mockImplementation(async () => { h.events.push("arm"); });
  h.finish.mockImplementation(async () => { h.events.push("finish"); });
  h.record.mockResolvedValue(undefined); h.notify.mockResolvedValue(undefined); h.pending.mockResolvedValue("social-approval");
  h.dbFetch.mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const resource = url.pathname.split("/").at(-1)!;
    h.events.push(resource);
    if (h.unavailable.has(resource)) return json({ code: "42703", message: PRIVATE, details: PRIVATE }, 400);
    if (resource === "social_accounts") return json(h.accounts);
    if (resource === "social_posts") return json(h.posts);
    throw new Error("Unexpected database request in social cycle test");
  });
  vi.stubEnv("SOCIAL_DB_SCHEMA", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", "unused-social-cycle-fixture");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://social-cycle-model.invalid");
  vi.stubEnv("ANTHROPIC_LOG", "off");
  vi.stubGlobal("fetch", h.modelFetch);
  h.modelFetch.mockImplementation(async () => {
    h.events.push("model-request");
    const { context } = modelRequest();
    return json({
      id: "msg_social_cycle_fixture", type: "message", role: "assistant", model: "social-fixture-main",
      content: [{ type: "text", text: `${BRIEF} ${PROVIDER_ID}` }, {
        type: "tool_use", id: "tool_social_document", name: "generate_pdf",
        input: { title: "État social enregistré", fileName: "social-status.pdf", paragraphs: outputParagraphs(context) },
      }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 40, output_tokens: 12 },
    });
  });
  const client = createRealClaudeClient();
  h.decide.mockImplementation(async input => { h.events.push("decide"); return await client.decide(input); });
  vi.spyOn(generatePdfTool, "execute").mockImplementation(async () => {
    h.events.push("pdf"); return { url: "https://social-document.invalid/result" };
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("social metadata reaches the single decision before an action", () => {
  it("passes real scoped reader output into the real model SDK and derives an action from it", async () => {
    const result = await run();
    expect(result.status).toBe("success");
    const { context, body } = modelRequest();
    expect(context.items).toEqual([{ brief: BRIEF }]);
    expect(context.socialStatus).toMatchObject({ availability: "available", coverage: "bounded_first_pages_by_id",
      atomicSnapshot: false, limits: { accounts: 14, posts: 10 }, providerHealth: "not_checked",
      liveProviderCheckPerformed: false, publicationPerformed: false,
      accounts: { status: "read", items: [{ accountId: ACCOUNT, associationRecordedAt: null }] },
      posts: { status: "read", items: [{ postId: postId(1), status: "publish_unconfirmed", providerPostId: PROVIDER_ID }] },
    });
    expect(JSON.stringify(context)).not.toContain(PRIVATE);
    expect(body.tools.map(tool => tool.name)).not.toContain("social_status");
    expect(generatePdfTool.execute).toHaveBeenCalledWith({ title: "État social enregistré", fileName: "social-status.pdf",
      paragraphs: [`Publication ${postId(1)} : publish_unconfirmed.`] }, expect.objectContaining({ userId: USER, mode: "live" }));
    expect(h.dbFetch).toHaveBeenCalledTimes(2); expect(h.modelFetch).toHaveBeenCalledOnce(); expect(h.decide).toHaveBeenCalledOnce();
    expect(h.events.indexOf("claim")).toBeLessThan(h.events.indexOf("social_accounts"));
    for (const resource of ["social_accounts", "social_posts"]) expect(h.events.indexOf(resource)).toBeLessThan(h.events.indexOf("decide"));
    expect(h.events.indexOf("decide")).toBeLessThan(h.events.indexOf("arm"));
    expect(h.events.indexOf("arm")).toBeLessThan(h.events.indexOf("pdf"));
    expect(result.toolsUsed[0]).toMatchObject({ tool: "generate_pdf", outcome: "executed", tracePolicy: "metadata_only" });
    assertPrivateTrace(result);
  });

  it("preserves the first-page limit and incompleteness without dispatching another read after the decision", async () => {
    h.posts = Array.from({ length: 11 }, (_, index) => post(index + 1));
    await run();
    const snapshot = modelRequest().context.socialStatus!;
    expect(snapshot.posts).toMatchObject({ status: "read", page: { limit: 10, hasMore: true, nextAfterId: postId(10) } });
    if (snapshot.posts.status !== "read") throw new Error("Expected a validated first page");
    expect(snapshot.posts.items).toHaveLength(10);
    expect(JSON.stringify(snapshot)).not.toContain(postId(11));
    const queries = h.dbFetch.mock.calls.map(([input, init]) => ({
      url: new URL(input instanceof Request ? input.url : String(input)), headers: new Headers(init?.headers),
    }));
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.url.searchParams.get("user_id")).toBe(`eq.${USER}`);
      expect(query.url.searchParams.get("order")).toBe("id.asc");
      expect(query.headers.get("Accept-Profile")).toBe("purama_ai");
      expect(query.url.searchParams.get("limit")).toBe(query.url.pathname.endsWith("social_accounts") ? "15" : "11");
    }
  });

  it("starts both bounded reads before either completes", async () => {
    let releaseAccounts!: (response: Response) => void;
    h.dbFetch.mockImplementation(async input => {
      if (String(input).includes("social_accounts")) return await new Promise<Response>(resolve => { releaseAccounts = resolve; });
      releaseAccounts(json(h.accounts)); return json(h.posts);
    });
    const context = await buildSocialBriefContext(USER, trigger, { pendingBrief: BRIEF, executionMode: "live" });
    expect(context).toMatchObject({ socialStatus: { availability: "available" } });
    expect(h.dbFetch).toHaveBeenCalledTimes(2);
  });

  it("does not read, infer or arm when the live brief has not been acquired", async () => {
    h.claim.mockResolvedValue(null);
    expect(await run()).toMatchObject({ status: "skipped", toolsUsed: [] });
    expect(h.dbFetch).not.toHaveBeenCalled(); expect(h.decide).not.toHaveBeenCalled(); expect(h.arm).not.toHaveBeenCalled();
  });

  it("never trusts a forged execution mode or owner in the trigger", async () => {
    h.state.simulationMode = true;
    const result = await run({ executionMode: "live", mode: "live", pendingBrief: "forged", userId: OTHER });
    expect(result.status).toBe("simulated");
    expect(h.dbFetch).not.toHaveBeenCalled(); expect(h.claim).not.toHaveBeenCalled(); expect(h.peek).toHaveBeenCalledOnce();
    expect(modelRequest().context).toEqual({ items: [{ brief: BRIEF }] });
    expect(generatePdfTool.execute).not.toHaveBeenCalled(); expect(h.arm).not.toHaveBeenCalled();
    assertPrivateTrace(result);
  });

  it.each([true, undefined])("does not preload live metadata for a mock or unknown model (isMock=%s)", async isMock => {
    h.isMock = isMock;
    h.decide.mockResolvedValue({ summary: BRIEF, toolCalls: [], requiresApproval: false, mock: true });
    const result = await run();
    expect(result.status).toBe("simulated");
    expect(h.claim).toHaveBeenCalledOnce();
    expect(h.decide.mock.calls[0]![0].context).toEqual({ items: [{ brief: BRIEF }] });
    expect(h.dbFetch).not.toHaveBeenCalled(); expect(h.modelFetch).not.toHaveBeenCalled(); expect(h.arm).not.toHaveBeenCalled();
    assertPrivateTrace(result);
  });

  it.each(["missing-mode", "simulation", "missing-brief"] as const)("keeps a direct builder inert for %s", async kind => {
    const prepared = kind === "missing-mode" ? { pendingBrief: BRIEF }
      : kind === "simulation" ? { pendingBrief: BRIEF, executionMode: "simulation" as const }
      : { executionMode: "live" as const };
    const context = await buildSocialBriefContext(USER, { ...trigger, payload: { executionMode: "live" } }, prepared);
    expect(context).toEqual(kind === "missing-brief" ? { items: [], reason: "aucun brief en attente" } : { items: [{ brief: BRIEF }] });
    expect(h.dbFetch).not.toHaveBeenCalled(); expect(h.modelFetch).not.toHaveBeenCalled();
  });

  it("marks an unavailable capability without inventing an empty account list or leaking its error", async () => {
    h.unavailable.add("social_accounts");
    const result = await run();
    const context = modelRequest().context;
    expect(context.socialStatus).toMatchObject({ availability: "partial", accounts: { status: "unavailable", resource: "accounts" }, posts: { status: "read" } });
    expect(context.socialStatus!.accounts).not.toHaveProperty("items");
    expect(JSON.stringify(context)).not.toContain(PRIVATE);
    expect(h.dbFetch).toHaveBeenCalledTimes(2);
    assertPrivateTrace(result);
  });

  it("distinguishes a complete database outage from successfully empty pages", async () => {
    h.unavailable = new Set(["social_accounts", "social_posts"]);
    const result = await run();
    const snapshot = modelRequest().context.socialStatus!;
    expect(snapshot.availability).toBe("unavailable");
    expect(snapshot.accounts).toEqual({ status: "unavailable", resource: "accounts" });
    expect(snapshot.posts).toEqual({ status: "unavailable", resource: "posts" });
    expect(generatePdfTool.execute).toHaveBeenCalledWith(expect.objectContaining({
      paragraphs: ["Les métadonnées de publication ne sont pas disponibles dans cet aperçu."],
    }), expect.anything());
    assertPrivateTrace(result);
  });

  it("does not send a foreign sentinel to the model or use it as evidence", async () => {
    h.posts = Array.from({ length: 11 }, (_, index) => post(index + 1));
    h.posts[10]!.user_id = OTHER;
    const result = await run();
    const context = modelRequest().context;
    expect(context.socialStatus).toMatchObject({ availability: "partial", posts: { status: "unavailable", resource: "posts" } });
    expect(context.socialStatus!.posts).not.toHaveProperty("items");
    for (const id of [OTHER, postId(1), postId(11)]) expect(JSON.stringify(context)).not.toContain(id);
    assertPrivateTrace(result);
  });

  it("does not accept trigger fields as replacements for the authenticated owner's live data", async () => {
    await run({ userId: OTHER, socialStatus: { accounts: [{ user_id: OTHER }] }, executionMode: "simulation" });
    expect(modelRequest().context.socialStatus!.availability).toBe("available");
    for (const [input] of h.dbFetch.mock.calls) {
      expect(new URL(String(input)).searchParams.get("user_id")).toBe(`eq.${USER}`);
    }
    expect(JSON.stringify(modelRequest().context)).not.toContain(OTHER);
  });
});
