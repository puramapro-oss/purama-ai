import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDefinition, AgentRunResult, AgentState, GmailInboxBinding, GmailInboxCycle } from "../src/engine/types.js";

const h = vi.hoisted(() => ({
  mockClaude: false, state: {} as AgentState, decision: {} as AgentDecision, events: [] as string[],
  resume: undefined as unknown, prior: undefined as AgentRunResult | undefined,
  prepare: vi.fn(), beforeInference: vi.fn(), candidate: vi.fn(), arm: vi.fn(), finish: vi.fn(), log: vi.fn(), execute: vi.fn(),
  stateRead: vi.fn(), build: vi.fn(), decide: vi.fn(), pend: vi.fn(), notice: vi.fn(), switchedOff: false,
}));
vi.mock("../src/db/supabase.js", () => ({ supabase: {} }));
vi.mock("../src/config.js", () => ({ config: { get mockClaude() { return h.mockClaude; } } }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide, isMock: h.mockClaude }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => h.switchedOff }));
vi.mock("../src/engine/resolveDefinition.js", () => ({ resolveAgentDefinition: vi.fn(), CustomAgentAuthorizationError: class extends Error {} }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pend }));
vi.mock("../src/engine/approval-continuation.js", async factory => ({
  ...await factory<typeof import("../src/engine/approval-continuation.js")>(),
  loadApprovalContinuation: async () => h.resume,
}));
vi.mock("../src/engine/autonomy.js", async factory => ({
  ...await factory<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: h.stateRead, recordRunOutcome: async () => {},
}));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "owned-run", finish: h.log, existingResult: h.prior }) }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notice }));
vi.mock("../src/engine/private-tool-results.js", () => ({ persistPrivateToolResult: async () => ({ status: "none" }) }));

const { runAgentCycle } = await import("../src/engine/loop.js");
const binding: GmailInboxBinding = { mailbox: "owner@example.invalid", messageId: "source", threadId: "thread", policyVersion: "policy" };
const context = { newEmails: [{ body: "private-example", threadId: "thread", id: "source" }] };
const claim: GmailInboxCycle = { isCandidate: h.candidate, beforeInference: h.beforeInference, binding, hasMessage: true, context, beforeEffect: h.arm, finish: h.finish };
const noMessage = { ...claim, hasMessage: false, binding: undefined, context: {} };
const call = { tool: "gmail_create_draft", params: { threadId: "thread", replyToMessageId: "source" } };
const definition = (type: "email" | "repondeur-intelligent" = "email"): AgentDefinition => ({
  type, prepareInboxCycle: h.prepare, buildContext: h.build, systemPrompt: "email",
  tools: ["gmail_create_draft", "gmail_send", "send_notification"].map(name => ({
    name, sensitive: false, description: name, inputSchema: { type: "object", additionalProperties: false,
      properties: { threadId: { type: "string" }, replyToMessageId: { type: "string" } } }, execute: h.execute,
  })),
});
const run = (type: "email" | "repondeur-intelligent" = "email") => runAgentCycle("owner", definition(type),
  { type: "manual", source: "test" }, "delivery-key");
beforeEach(() => {
  vi.resetAllMocks(); h.mockClaude = false; h.prior = undefined; h.resume = undefined; h.switchedOff = false; h.events = [];
  h.state = { userId: "owner", agentType: "email", autonomyLevel: 3, isEnabled: true, killSwitch: false, simulationMode: false };
  h.decision = { summary: "private-example", toolCalls: [call], mock: false, requiresApproval: false };
  h.stateRead.mockImplementation(async () => ({ ...h.state }));
  h.prepare.mockImplementation(async (_user, _type, _run, mode) => { h.events.push("prepare"); return mode === "live" ? claim : noMessage; });
  h.beforeInference.mockResolvedValue(undefined); h.candidate.mockReturnValue(true);
  h.decide.mockImplementation(async () => { h.events.push("infer"); return h.decision; });
  h.arm.mockImplementation(async () => { h.events.push("arm"); });
  h.execute.mockImplementation(async () => { h.events.push("effect"); return { draftId: "draft-1" }; });
  h.pend.mockImplementation(async () => { h.events.push("approval"); return "approval-1"; });
  h.finish.mockImplementation(async () => { h.events.push("settle"); });
  h.log.mockImplementation(async () => { h.events.push("log"); });
});
describe("one owned inbox item in the real KARTA cycle", () => {
  it.each(["email", "repondeur-intelligent"] as const)("binds %s to the claim and confirms the real receipt before journaling success", async type => {
    const result = await run(type);
    expect(result.status).toBe("success");
    expect(h.prepare).toHaveBeenCalledWith("owner", type, "owned-run", "live");
    expect(h.decide.mock.calls[0][0].context).toEqual(context);
    expect(h.arm).toHaveBeenCalledWith(call.tool, call.params, "execute", []);
    expect(h.execute.mock.calls[0][1]).toMatchObject({ gmailInboxBinding: binding, userId: "owner", agentType: type });
    expect(h.finish).toHaveBeenCalledWith("done", "draft:draft-1");
    expect(h.events).toEqual(["prepare", "infer", "arm", "effect", "settle", "log"]);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("private-example");
    expect(h.build).not.toHaveBeenCalled();
  });
  it.each(["simulation", "mock"] as const)("makes no real inbox effects in %s mode", async mode => {
    h.mockClaude = mode === "mock"; h.state.simulationMode = mode === "simulation";
    expect((await run()).status).toBe("skipped");
    expect(h.prepare).toHaveBeenCalledWith("owner", "email", "owned-run", "simulation");
    expect(h.build).not.toHaveBeenCalled(); expect(h.decide).not.toHaveBeenCalled();
    expect(h.arm).not.toHaveBeenCalled(); expect(h.finish).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled();
  });
  it("rechecks mailbox authority before releasing the message to the model", async () => {
    h.beforeInference.mockRejectedValue(new Error("consent changed"));
    expect((await run()).status).toBe("error"); expect(h.decide).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith("release"); expect(h.arm).not.toHaveBeenCalled();
  });
  it("allows a documented no-action decision on one owned message", async () => {
    h.decision.toolCalls = []; expect((await run()).status).toBe("success");
    expect(h.finish).toHaveBeenCalledWith("done", undefined); expect(h.arm).not.toHaveBeenCalled();
  });
  it.each(["model", "wrong-parent"] as const)("performs no external action on %s", async why => {
    if (why === "model") h.decide.mockRejectedValue(new Error("not available"));
    if (why === "wrong-parent") h.arm.mockRejectedValue(new Error("not source"));
    expect((await run()).status).toBe("error"); expect(h.finish).toHaveBeenCalledWith("release");
    expect(h.execute).not.toHaveBeenCalled(); expect(h.pend).not.toHaveBeenCalled();
  });
  it("takes the first admissible effect when higher priority proposals have the wrong parent or schema", async () => {
    h.candidate.mockImplementation((_tool, params) => params.threadId !== "unrelated");
    const invalidParent = { ...call, params: { ...call.params, threadId: "unrelated" } };
    const malformed = { ...call, params: { arbitrary: "private-example" } };
    h.decision.toolCalls = [invalidParent, malformed, call, { tool: "send_notification", params: {} }, invalidParent];
    const result = await run();
    expect(result.status).toBe("partial");
    expect(h.arm).toHaveBeenCalledWith(call.tool, call.params, "execute", ["send_notification"]);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.execute.mock.calls[0][0]).toEqual(call.params);
    expect(result.toolsUsed.filter(t => t.inboxFollowup)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("unrelated");
  });
  it("withholds all effects if every candidate is outside the mailbox policy", async () => {
    h.candidate.mockReturnValue(false); h.decision.toolCalls = [call, call];
    expect((await run()).status).toBe("error"); expect(h.arm).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled(); expect(h.finish).toHaveBeenCalledWith("release");
  });
  it.each(["executed", "approval", "unknown"] as const)("preserves remaining action names before the %s primary effect", async mode => {
    h.decision.toolCalls = [call, { tool: "send_notification", params: {} }, { tool: "send_notification", params: {} }, call];
    h.decision.requiresApproval = mode === "approval";
    if (mode === "unknown") h.execute.mockRejectedValue(new Error("response lost"));
    const result = await run();
    expect(h.arm).toHaveBeenCalledWith(call.tool, call.params, mode === "approval" ? "approval" : "execute",
      ["send_notification", "gmail_create_draft"]);
    expect(h.execute).toHaveBeenCalledTimes(mode === "approval" ? 0 : 1);
    expect(h.pend).toHaveBeenCalledTimes(mode === "approval" ? 1 : 0);
    expect(result.status).toBe(mode === "approval" ? "awaiting_approval" : mode === "unknown" ? "error" : "partial");
    expect(result.resultSummary).toContain("2 suite(s) à vérifier");
    expect(result.toolsUsed.slice(-2).map(t => [t.tool, t.inboxFollowup])).toEqual([["send_notification", true], ["gmail_create_draft", true]]);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("private-example");
    if (mode === "unknown") expect(h.finish).toHaveBeenCalledWith("review");
    else expect(h.finish).toHaveBeenCalledWith("done", mode === "approval" ? "approval:approval-1" : "draft:draft-1");
    // An idempotent delivery must preserve the still outstanding actions in its redacted projection.
    h.prior = result;
    expect((await run()).resultSummary).toContain("2 suite(s) à vérifier");
    expect(h.prepare).toHaveBeenCalledOnce();
  });
  it.each(["provider-error", "missing-receipt", "invalid-receipt"] as const)("suspends ambiguous action %s without retrying", async why => {
    if (why === "provider-error") h.execute.mockRejectedValue(new Error("lost"));
    else h.execute.mockResolvedValue(why === "missing-receipt" ? {} : { draftId: "bogus\n" });
    expect(await run()).toMatchObject({ status: "error", retryable: false });
    expect(h.execute).toHaveBeenCalledOnce(); expect(h.finish).toHaveBeenCalledWith("review");
  });
  it("stops a worker disabled during reservation before its provider call", async () => {
    h.arm.mockImplementation(async () => { h.state.isEnabled = false; });
    expect((await run()).status).toBe("cancelled"); expect(h.execute).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith("review");
  });
  it("records the local human approval as a handoff without sending Gmail", async () => {
    h.decision.requiresApproval = true;
    expect((await run()).status).toBe("awaiting_approval");
    expect(h.arm).toHaveBeenCalledWith(call.tool, call.params, "approval", []);
    expect(h.finish).toHaveBeenCalledWith("done", "approval:approval-1");
    expect(h.execute).not.toHaveBeenCalled(); expect(h.pend).toHaveBeenCalledOnce();
  });
  it("does not mark a lost approval response as retryable", async () => {
    h.decision.requiresApproval = true; h.pend.mockRejectedValue(new Error("lost"));
    expect((await run()).status).toBe("error"); expect(h.finish).toHaveBeenCalledWith("review"); expect(h.pend).toHaveBeenCalledOnce();
  });
  it("does not acquire an unrelated message from a verified approval continuation", async () => {
    h.resume = { context: { resolution: "executed" }, repeatsResolvedAction: () => true };
    expect((await run()).status).toBe("skipped");
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.decide).not.toHaveBeenCalled();
  });
  it("does not reacquire or repeat an already journaled run", async () => {
    h.prior = { status: "success", decision: "summary", toolsUsed: [], resultSummary: "", mock: false };
    expect((await run()).status).toBe("success"); expect(h.prepare).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled();
  });
  it("does not report success or repeat an effect when recording its receipt fails", async () => {
    h.finish.mockRejectedValue(new Error("unknown result"));
    expect(await run()).toMatchObject({ status: "error", retryable: false });
    expect(h.execute).toHaveBeenCalledOnce(); expect(h.finish).toHaveBeenCalledOnce();
  });
});
