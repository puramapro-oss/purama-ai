import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import type { AgentDecision, AgentDefinition, AgentRunResult, AgentState, AnyToolDefinition } from "../src/engine/types.js";
import { normalizeModelUsage } from "../src/claude/usage.js";

const h = vi.hoisted(() => ({
  flag: "on", configMock: false, clientMock: false, autoUsage: true, stopped: false, state: {} as AgentState,
  runId: "00000000-0000-4000-8000-000000000801", agent: undefined as AgentDefinition | undefined,
  decide: vi.fn(), execute: vi.fn(), stateRead: vi.fn(), global: vi.fn(), resolve: vi.fn(),
  finish: vi.fn(), record: vi.fn(), pending: vi.fn(), persist: vi.fn(), arm: vi.fn(), claim: vi.fn(),
  existing: undefined as AgentRunResult | undefined,
}));
vi.mock("../src/config.js", async original => {
  const actual = await original<typeof import("../src/config.js")>();
  return { ...actual, config: { ...actual.config,
    get anthropicProgrammaticReads() { return h.flag; }, get mockClaude() { return h.configMock; },
  } };
});
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ isMock: h.clientMock,
  decide: async (input: ClaudeDecideInput) => {
    let used = false; let receivedUsage = false;
    const bridge = input.programmaticReads;
    const observed: ClaudeDecideInput = { ...input,
      onUsage: (receipt, programmatic) => { receivedUsage = true; input.onUsage?.(receipt, programmatic); },
      ...(bridge ? { programmaticReads: { toolNames: bridge.toolNames,
        beforeRequest: async signal => { used = true; await bridge.beforeRequest(signal); },
        execute: async (call, signal) => { used = true; return bridge.execute(call, signal); },
      } } : {}),
    };
    const result = await h.decide(observed);
    if (used && !receivedUsage && h.autoUsage) input.onUsage?.(normalizeModelUsage({
      id: "msg_final", model: "qualified-model", usage: { input_tokens: 20, output_tokens: 10 },
    }, "qualified-model", "https://api.anthropic.com"), { codeExecutionRequests: 1 });
    return result;
  },
}) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: h.global }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(), loadAgentState: h.stateRead, recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: h.runId, finish: h.finish, existingResult: h.existing }) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: vi.fn() }));
vi.mock("../src/engine/brief.js", () => ({ claimPendingBrief: h.claim, peekPendingBrief: h.claim, armPendingBrief: h.arm }));
vi.mock("../src/engine/private-tool-results.js", () => ({ persistPrivateToolResult: h.persist }));
vi.mock("../src/engine/resolveDefinition.js", () => ({
  CustomAgentAuthorizationError: class CustomAgentAuthorizationError extends Error {}, resolveAgentDefinition: h.resolve,
}));
vi.mock("../src/engine/approval-continuation.js", () => ({
  APPROVAL_CONTINUATION_GUIDANCE: "", ApprovalContinuationError: class ApprovalContinuationError extends Error {},
  loadApprovalContinuation: async () => undefined,
}));
const { runAgentCycle } = await import("../src/engine/loop.js");
const USER = "00000000-0000-4000-8000-000000000811";
const AGENT = "custom:00000000-0000-4000-8000-000000000812" as const;
const PRIVATE = "PRIVATE_READ_DATA_AND_PROVIDER_DIAGNOSTIC";
const runId = "00000000-0000-4000-8000-000000000801";
const completed = (): AgentDecision => ({ summary: "Completed read", toolCalls: [], requiresApproval: false, mock: false });
function tool(overrides: Partial<AnyToolDefinition> = {}): AnyToolDefinition {
  return { name: "web_search", description: "Qualified public read", sensitive: false, programmaticRead: true,
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
    execute: h.execute, ...overrides };
}
function definition(tools: AnyToolDefinition[] = [tool()]): AgentDefinition {
  return { type: AGENT, systemPrompt: "Read only fixture", buildContext: async () => ({ untrustedOwner: "forged-owner" }), tools };
}
const cycle = (agent = definition(), owner = USER) => {
  h.agent = agent;
  return runAgentCycle(owner, agent, { type: "manual", source: "programmatic-fixture", payload: { userId: "forged-owner" } }, "read-delivery");
};
const call = (id = "read_1", query = "public query") => ({ id, tool: "web_search", params: { query } });
function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function assertPrivate(result: AgentRunResult) {
  expect(JSON.stringify([result, h.finish.mock.calls, h.record.mock.calls])).not.toContain(PRIVATE);
  expect(JSON.stringify([result, h.finish.mock.calls, h.record.mock.calls])).not.toContain("forged-owner");
}
beforeEach(() => {
  vi.resetAllMocks(); h.flag = "on"; h.configMock = false; h.clientMock = false; h.autoUsage = true; h.stopped = false; h.existing = undefined;
  h.runId = runId; h.agent = undefined;
  h.state = { userId: USER, agentType: AGENT, isEnabled: true, autonomyLevel: 2, simulationMode: false, killSwitch: false };
  h.stateRead.mockImplementation(async () => ({ ...h.state }));
  h.global.mockImplementation(async () => h.stopped);
  h.execute.mockResolvedValue({ ok: true, rows: [{ id: "public-row", title: PRIVATE }] });
  h.persist.mockImplementation(async input => input.toolName === "programmatic_report"
    ? { status: "stored", id: "00000000-0000-4000-8000-000000000813" } : { status: "not_applicable" });
  h.resolve.mockImplementation(async () => h.agent ?? definition());
  h.finish.mockResolvedValue(undefined); h.record.mockResolvedValue(undefined); h.pending.mockResolvedValue("pending-read");
  h.claim.mockResolvedValue({ brief: "Read a public source", briefId: "00000000-0000-4000-8000-000000000802" });
  h.arm.mockResolvedValue(undefined);
  h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
    const signal = new AbortController().signal;
    await input.programmaticReads!.beforeRequest(signal);
    const result = await input.programmaticReads!.execute(call(), signal);
    expect(JSON.parse(result)).toEqual({ ok: true, rows: [{ id: "public-row", title: PRIVATE }] });
    return { ...completed(), summary: PRIVATE };
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("programmatic admission without changing the direct route", () => {
  it("executes a qualified read through the existing engine and server-owned identity", async () => {
    const result = await cycle();
    expect(result.status).toBe("success"); expect(h.execute).toHaveBeenCalledOnce();
    expect(h.execute.mock.calls[0]).toEqual([{ query: "public query" }, {
      userId: USER, agentType: AGENT, mode: "live", operationId: `${runId}:0`,
      trigger: { type: "manual", source: "programmatic-fixture" },
      signal: expect.any(AbortSignal),
    }]);
    expect(h.persist.mock.calls[0][0]).toMatchObject({ userId: USER, operationId: `${runId}:0`, toolName: "web_search" });
    expect(h.pending).not.toHaveBeenCalled();
    expect(result.toolsUsed).toHaveLength(1); expect(result.toolsUsed[0]).toMatchObject({ outcome: "executed", success: true });
    assertPrivate(result);
  });

  it.each(["off", "config mock", "client mock", "simulation", "level one", "unqualified", "unknown reader", "sensitive", "explicit", "mixed", "empty", "static", "invalid agent", "invalid user", "invalid run"])(
    "keeps the bridge absent for %s", async scenario => {
      let agent = definition();
      if (scenario === "off") h.flag = "off";
      if (scenario === "config mock") h.configMock = true;
      if (scenario === "client mock") h.clientMock = true;
      if (scenario === "simulation") h.state.simulationMode = true;
      if (scenario === "level one") h.state.autonomyLevel = 1;
      if (scenario === "unqualified") agent = definition([tool({ programmaticRead: undefined })]);
      if (scenario === "unknown reader") agent = definition([tool({ name: "unknown_read" })]);
      if (scenario === "sensitive") agent = definition([tool({ sensitive: true })]);
      if (scenario === "explicit") agent = definition([tool({ requiresExplicitApproval: true })]);
      if (scenario === "mixed") agent = definition([tool(), tool({ name: "write", programmaticRead: undefined })]);
      if (scenario === "empty") agent = definition([]);
      if (scenario === "static") agent = { ...definition(), type: "legal" };
      if (scenario === "invalid agent") agent = { ...definition(), type: "custom:invalid" };
      if (scenario === "invalid run") h.runId = "invalid-run";
      h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
        expect(input.programmaticReads).toBeUndefined();
        return completed();
      });
      const result = await cycle(agent, scenario === "invalid user" ? "invalid-owner" : USER);
      expect(h.execute).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled();
      expect(result.status).toBe(scenario === "simulation" ? "simulated" : "success");
      expect(result.decision).toBe(scenario === "static" ? "Completed read" : "Contenu de la décision non conservé dans les traces");
    },
  );

  it("does not inherit read qualification or evaluate a prototype getter", async () => {
    const reader = tool();
    Reflect.deleteProperty(reader, "programmaticRead");
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "programmaticRead");
    const inheritedQualification = vi.fn(() => true);
    Object.defineProperty(Object.prototype, "programmaticRead", { configurable: true, get: inheritedQualification });
    try {
      h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
        expect(input.programmaticReads).toBeUndefined();
        return completed();
      });
      expect((await cycle(definition([reader]))).status).toBe("success");
      expect(inheritedQualification).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.persist).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "programmaticRead", previous);
      else Reflect.deleteProperty(Object.prototype, "programmaticRead");
    }
  });

  it("preserves direct trace policy when the provider declines an available bridge", async () => {
    h.decide.mockResolvedValue({ ...completed(), summary: "Direct public decision" });
    const offered = await cycle();
    expect(h.decide.mock.calls[0][0].programmaticReads).toBeDefined();
    h.flag = "off";
    const disabled = await cycle();
    expect(h.decide.mock.calls[1][0].programmaticReads).toBeUndefined();
    expect(offered.decision).toBe(disabled.decision);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("keeps direct approval behavior on a mixed catalogue", async () => {
    h.state.autonomyLevel = 1;
    h.decide.mockResolvedValue({ ...completed(), toolCalls: [{ tool: "web_search", params: { query: "public query" } }] });
    const result = await cycle(definition([tool(), tool({ name: "write", programmaticRead: undefined })]));
    expect(result.status).toBe("awaiting_approval"); expect(h.pending).toHaveBeenCalledOnce(); expect(h.execute).not.toHaveBeenCalled();
  });
});

describe("programmatic authority, abort and replay boundaries", () => {
  it.each(["global", "individual", "disabled", "simulation", "autonomy"])("blocks a %s change before the read", async change => {
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      const signal = new AbortController().signal;
      await input.programmaticReads!.beforeRequest(signal);
      if (change === "global") h.stopped = true;
      if (change === "individual") h.state.killSwitch = true;
      if (change === "disabled") h.state.isEnabled = false;
      if (change === "simulation") h.state.simulationMode = true;
      if (change === "autonomy") h.state.autonomyLevel = 1;
      await input.programmaticReads!.execute(call(), signal);
      return completed();
    });
    const result = await cycle();
    expect(result.status).toBe("error"); expect(result.retryable).toBe(false);
    expect(h.execute).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled(); assertPrivate(result);
  });

  it("forbids replay after admitted inference loses its response without a durable delivery key", async () => {
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      await input.programmaticReads!.beforeRequest(new AbortController().signal);
      throw new Error(PRIVATE);
    });
    const result = await runAgentCycle(USER, definition(), { type: "manual", source: "ambiguous-inference" });
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.execute).not.toHaveBeenCalled(); expect(h.finish.mock.calls[0][0]).not.toHaveProperty("modelUsage");
    assertPrivate(result);
  });

  it("rechecks mutable qualification after the final inference-admission await", async () => {
    const read = tool(); const sent = vi.fn();
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      h.global.mockImplementationOnce(async () => { read.programmaticRead = undefined; return false; });
      await input.programmaticReads!.beforeRequest(new AbortController().signal);
      sent(); return completed();
    });
    expect((await cycle(definition([read]))).status).toBe("error");
    expect(sent).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(["state", "stop", "brief"])("rechecks the qualified handler after awaiting %s", async boundary => {
    const read = tool();
    const unexpectedHandler = vi.fn(async () => ({ ok: true }));
    const agent = { ...definition([read]), ...(boundary === "brief" ? { pendingBriefKey: "pending_brief" } : {}) };
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      const signal = new AbortController().signal;
      await input.programmaticReads!.beforeRequest(signal);
      if (boundary === "state") h.stateRead.mockImplementationOnce(async () => { read.execute = unexpectedHandler; return { ...h.state }; });
      if (boundary === "stop") h.global.mockImplementationOnce(async () => { read.execute = unexpectedHandler; return false; });
      if (boundary === "brief") h.arm.mockImplementationOnce(async () => { read.execute = unexpectedHandler; });
      await input.programmaticReads!.execute(call(), signal);
      return completed();
    });
    const result = await cycle(agent);
    expect(result.status).toBe("error"); expect(unexpectedHandler).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled(); expect(h.persist).not.toHaveBeenCalled();
  });

  it("refuses a new provider request after a global stop without executing another tool", async () => {
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      const signal = new AbortController().signal;
      await input.programmaticReads!.beforeRequest(signal);
      h.stopped = true;
      await input.programmaticReads!.beforeRequest(signal);
      return completed();
    });
    expect((await cycle()).status).toBe("error"); expect(h.execute).not.toHaveBeenCalled();
  });

  it("does not hand a completed read back after a stop during its I/O", async () => {
    h.execute.mockImplementation(async () => { h.stopped = true; return { ok: true, private: PRIVATE }; });
    const result = await cycle();
    expect(result.status).toBe("error"); expect(h.execute).toHaveBeenCalledOnce();
    expect(result.toolsUsed[0].success).toBe(false); expect(h.pending).not.toHaveBeenCalled(); assertPrivate(result);
  });

  it.each(["model", "tool removed", "qualification", "sensitive"])("checks fresh custom %s authority", async change => {
    const agent = { ...definition(), type: AGENT, modelPreferences: { model: "qualified-model" } };
    let current = agent;
    h.resolve.mockImplementation(async () => current);
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      const signal = new AbortController().signal;
      await input.programmaticReads!.beforeRequest(signal);
      current = change === "model" ? { ...agent, modelPreferences: { model: "different-model" } }
        : { ...agent, tools: change === "tool removed" ? [] : [tool(change === "qualification" ? { programmaticRead: undefined } : { sensitive: true })] };
      await input.programmaticReads!.execute(call(), signal);
      return completed();
    });
    expect((await cycle(agent)).status).toBe("error"); expect(h.execute).not.toHaveBeenCalled();
  });

  it("snapshots parameters before awaiting authority", async () => {
    const params = { query: "original" };
    const entered = gate(); const release = gate();
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      const signal = new AbortController().signal;
      await input.programmaticReads!.beforeRequest(signal);
      h.stateRead.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { ...h.state }; });
      const reading = input.programmaticReads!.execute({ id: "snapshot", tool: "web_search", params }, signal);
      await entered.promise; params.query = "mutated"; release.resolve(); await reading;
      return completed();
    });
    expect((await cycle()).status).toBe("success"); expect(h.execute.mock.calls[0][0]).toEqual({ query: "original" });
  });

  it.each(["read_1\n", "read_1\r", "read_1 ", "", "x".repeat(201)])("rejects a malformed call ID %j before a read", async id => {
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      await input.programmaticReads!.execute(call(id), new AbortController().signal);
      return completed();
    });
    expect((await cycle()).status).toBe("error"); expect(h.execute).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled();
  });

  it("never reexecutes a repeated provider call identifier", async () => {
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      const signal = new AbortController().signal;
      await input.programmaticReads!.beforeRequest(signal);
      await input.programmaticReads!.execute(call(), signal);
      await input.programmaticReads!.execute(call(), signal);
      return completed();
    });
    expect((await cycle()).status).toBe("error"); expect(h.execute).toHaveBeenCalledOnce();
  });

  it("does not hide a callback error behind a later successful model decision", async () => {
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      try { await input.programmaticReads!.execute({ ...call(), tool: "unknown" }, new AbortController().signal); } catch { /* provider wrapper ignores */ }
      return completed();
    });
    expect((await cycle()).status).toBe("error"); expect(h.execute).not.toHaveBeenCalled();
  });

  it("closes unresolved reads before logging and forbids late effects on the journal", async () => {
    const entered = gate(); const release = gate<unknown>();
    let callback: Promise<string> | undefined;
    let observed: AbortSignal | undefined;
    h.execute.mockImplementation(async (_params, ctx) => { observed = ctx.signal; entered.resolve(); return release.promise; });
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      const controller = new AbortController();
      await input.programmaticReads!.beforeRequest(controller.signal);
      callback = input.programmaticReads!.execute(call(), controller.signal);
      void callback.catch(() => undefined);
      await entered.promise; controller.abort(); throw new Error(PRIVATE);
    });
    const result = await cycle();
    expect(observed?.aborted).toBe(true);
    expect(result.status).toBe("error"); expect(result.toolsUsed[0]).toMatchObject({ outcome: "failed", success: false });
    const closed = JSON.stringify([result, h.finish.mock.calls]);
    release.resolve({ ok: true, private: PRIVATE });
    await expect(callback).rejects.toThrow();
    expect(JSON.stringify([result, h.finish.mock.calls])).toBe(closed);
    expect(h.persist).not.toHaveBeenCalled(); expect(h.finish).toHaveBeenCalledOnce(); assertPrivate(result);
  });

  it("rejects a provider decision returned while a read is still in flight", async () => {
    const entered = gate(); const release = gate<unknown>(); let callback: Promise<string> | undefined;
    let observed: AbortSignal | undefined;
    h.execute.mockImplementation(async (_params, ctx) => { observed = ctx.signal; entered.resolve(); return release.promise; });
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      callback = input.programmaticReads!.execute(call(), new AbortController().signal);
      void callback.catch(() => undefined); await entered.promise; return completed();
    });
    const result = await cycle(); expect(result.status).toBe("error");
    expect(observed?.aborted).toBe(true);
    release.resolve({ ok: true }); await expect(callback).rejects.toThrow(); expect(h.persist).not.toHaveBeenCalled();
  });

  it("propagates a parent interruption while the read is running without exposing its reason", async () => {
    const entered = gate(); const release = gate<unknown>();
    const parent = new AbortController();
    let observed: AbortSignal | undefined;
    let abortedDuringRead = false;
    h.execute.mockImplementation(async (_params, ctx) => {
      observed = ctx.signal; entered.resolve(); return release.promise;
    });
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      await input.programmaticReads!.beforeRequest(parent.signal);
      const reading = input.programmaticReads!.execute(call(), parent.signal);
      void reading.catch(() => undefined);
      await entered.promise;
      parent.abort(new Error(PRIVATE));
      abortedDuringRead = observed?.aborted === true;
      release.resolve({ ok: true });
      await expect(reading).rejects.toThrow();
      return completed();
    });
    const result = await cycle();
    expect(abortedDuringRead).toBe(true);
    expect(result.status).toBe("error");
    expect(h.persist).not.toHaveBeenCalled();
    assertPrivate(result);
  });
});

describe("programmatic briefs, bounded complete results and usage", () => {
  it("arms a brief before the read and recognizes a completed read-only mission", async () => {
    h.execute.mockImplementation(async () => {
      expect(h.arm).toHaveBeenCalledOnce(); return { ok: true, rows: [{ id: "public-row", title: PRIVATE }] };
    });
    const result = await cycle({ ...definition(), pendingBriefKey: "pending_brief" });
    expect(result.status).toBe("success"); expect(h.arm).toHaveBeenCalledOnce(); expect(h.execute).toHaveBeenCalledOnce();
  });

  it("shares one brief-arm barrier across concurrent reads", async () => {
    const entered = gate(); const release = gate();
    h.arm.mockImplementation(async () => { entered.resolve(); await release.promise; });
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      const signal = new AbortController().signal;
      const first = input.programmaticReads!.execute(call("parallel_1"), signal);
      const second = input.programmaticReads!.execute(call("parallel_2"), signal);
      await entered.promise; await Promise.resolve(); expect(h.arm).toHaveBeenCalledOnce();
      release.resolve(); await Promise.all([first, second]); return completed();
    });
    expect((await cycle({ ...definition(), pendingBriefKey: "pending_brief" })).status).toBe("success");
    expect(h.arm).toHaveBeenCalledOnce(); expect(h.execute).toHaveBeenCalledTimes(2);
    expect(new Set(h.execute.mock.calls.map(([, ctx]) => ctx.operationId)).size).toBe(2);
  });

  it("does not execute after an ambiguous brief arm acknowledgement", async () => {
    h.arm.mockRejectedValue(new Error(PRIVATE));
    const result = await cycle({ ...definition(), pendingBriefKey: "pending_brief" });
    expect(result).toMatchObject({ status: "error", retryable: false }); expect(h.execute).not.toHaveBeenCalled(); assertPrivate(result);
  });

  it("rechecks autonomy after arming the brief", async () => {
    h.arm.mockImplementation(async () => { h.state.autonomyLevel = 1; });
    expect((await cycle({ ...definition(), pendingBriefKey: "pending_brief" })).status).toBe("error");
    expect(h.execute).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled();
  });

  it("uses distinct operation identities for reads and the delivered report", async () => {
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      const signal = new AbortController().signal;
      await input.programmaticReads!.execute(call("first"), signal);
      await input.programmaticReads!.execute({ ...call("second"), tool: "knowledge_search" }, signal);
      await input.programmaticReads!.execute(call("third"), signal);
      return completed();
    });
    expect((await cycle(definition([tool(), tool({ name: "knowledge_search" })]))).status).toBe("success");
    expect(h.execute.mock.calls.map(([, ctx]) => ctx.operationId)).toEqual([`${runId}:0`, `${runId}:1`, `${runId}:2`]);
    expect(h.persist.mock.calls.map(([input]) => input.operationId)).toEqual([`${runId}:0`, `${runId}:1`, `${runId}:2`, `${runId}:3`]);
    expect(h.persist.mock.calls[3][0]).toMatchObject({ toolName: "programmatic_report", result: { read_tools: ["web_search", "knowledge_search"] } });
  });

  it("never creates an approval after composed reads when autonomy is lowered", async () => {
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      await input.programmaticReads!.execute(call(), new AbortController().signal);
      h.state.autonomyLevel = 1;
      return { ...completed(), toolCalls: [{ tool: "web_search", params: { query: "next" } }] };
    });
    const result = await cycle();
    expect(result.status).toBe("error"); expect(h.pending).not.toHaveBeenCalled(); expect(h.execute).toHaveBeenCalledOnce();
    expect(result.toolsUsed.map(item => item.outcome)).toEqual(["executed"]);
    expect(h.persist.mock.calls.some(([input]) => input.toolName === "programmatic_report")).toBe(false);
  });

  it("stops before a seventeenth call", async () => {
    h.execute.mockResolvedValue({ ok: true });
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      for (let i = 0; i < 17; i++) await input.programmaticReads!.execute(call(`read_${i}`), new AbortController().signal);
      return completed();
    });
    expect((await cycle()).status).toBe("error"); expect(h.execute).toHaveBeenCalledTimes(16);
  });

  it.each(["too large", "invalid number", "accessor", "toJSON", "cyclic"])("refuses an incomplete or unsafe %s result", async scenario => {
    const getter = vi.fn(() => PRIVATE);
    const value: Record<string, unknown> = scenario === "too large" ? { data: "é".repeat(40_000) }
      : scenario === "invalid number" ? { data: NaN } : scenario === "toJSON" ? { toJSON: getter } : {};
    if (scenario === "accessor") Object.defineProperty(value, "data", { enumerable: true, get: getter });
    if (scenario === "cyclic") value.self = value;
    h.execute.mockResolvedValue(value);
    const result = await cycle(); expect(result.status).toBe("error"); expect(getter).not.toHaveBeenCalled(); assertPrivate(result);
  });

  it("applies the complete aggregate result limit without truncating a fifth response", async () => {
    h.execute.mockResolvedValue({ data: "x".repeat(60_000) });
    let delivered = 0;
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      for (let i = 0; i < 5; i++) {
        const output = await input.programmaticReads!.execute(call(`large_${i}`), new AbortController().signal);
        expect(JSON.parse(output).data).toHaveLength(60_000); delivered++;
      }
      return completed();
    });
    expect((await cycle()).status).toBe("error"); expect(delivered).toBe(4); expect(h.execute).toHaveBeenCalledTimes(5);
  });

  it("preserves every provider usage receipt even when a later turn fails", async () => {
    const receipts = [1, 2].map(index => normalizeModelUsage({ id: `msg_${index}`, model: "qualified-model", usage: { input_tokens: index * 10, output_tokens: index } }, "qualified-model", "https://api.anthropic.com"));
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      await input.programmaticReads!.beforeRequest(new AbortController().signal);
      input.onUsage!(receipts[0], { codeExecutionRequests: 1 });
      input.onUsage!(receipts[1], { codeExecutionRequests: null });
      throw new Error(PRIVATE);
    });
    const result = await cycle(); expect(result.status).toBe("error");
    expect(h.finish.mock.calls[0][0].modelUsage).toEqual({ version: 2, apiFormat: "anthropic_messages", routeKind: "anthropic",
      responses: [{ receipt: receipts[0], codeExecutionRequests: 1 }, { receipt: receipts[1], codeExecutionRequests: null }] });
    expect(result).not.toHaveProperty("modelUsage"); assertPrivate(result);
  });

  it("retains the direct first-receipt contract", async () => {
    h.flag = "off";
    const first = normalizeModelUsage({ id: "first", usage: { input_tokens: 10 } }, "model", "https://api.anthropic.com");
    const second = normalizeModelUsage({ id: "second", usage: { input_tokens: 20 } }, "model", "https://api.anthropic.com");
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => { input.onUsage!(first); input.onUsage!(second); return completed(); });
    expect((await cycle()).status).toBe("success"); expect(h.finish.mock.calls[0][0].modelUsage).toEqual(first);
  });
});

describe("private delivery of the final programmatic answer", () => {
  const reports = () => h.persist.mock.calls.map(([input]) => input).filter(input => input.toolName === "programmatic_report");
  const withoutReads = async (input: ClaudeDecideInput) => {
    await input.programmaticReads!.beforeRequest(new AbortController().signal);
    return { ...completed(), summary: PRIVATE };
  };

  it("delivers the complete final answer to the run owner before closing, without exposing it as telemetry", async () => {
    const summary = `${PRIVATE}\n${"Un résultat complet. ".repeat(400)}`;
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      await input.programmaticReads!.execute(call(), new AbortController().signal);
      return { ...completed(), summary };
    });
    const result = await cycle();
    expect(result.status).toBe("success");
    expect(reports()).toEqual([{ userId: USER, agentType: AGENT, runId,
      operationId: `${runId}:1`, toolName: "programmatic_report", result: { summary, read_tools: ["web_search"] } }]);
    expect(h.persist.mock.invocationCallOrder.at(-1)!).toBeLessThan(h.finish.mock.invocationCallOrder[0]);
    expect(result.toolsUsed).toHaveLength(1); expect(result.toolsUsed[0].tool).toBe("web_search");
    assertPrivate(result);
  });

  it("arms and completes a brief whose final report requires no external read", async () => {
    h.decide.mockImplementation(withoutReads);
    h.persist.mockImplementation(async input => {
      expect(input.toolName).toBe("programmatic_report"); expect(h.arm).toHaveBeenCalledOnce();
      return { status: "stored", id: "00000000-0000-4000-8000-000000000813" };
    });
    const result = await cycle({ ...definition(), pendingBriefKey: "pending_brief" });
    expect(result.status).toBe("success"); expect(result.toolsUsed).toEqual([]); expect(h.execute).not.toHaveBeenCalled();
    expect(reports()[0]).toMatchObject({ operationId: `${runId}:0`, result: { summary: PRIVATE, read_tools: [] } });
    assertPrivate(result);
  });

  it.each(["missing receipt", "direct receipt", "compatible receipt", "mock", "approval", "deferred action"])(
    "never delivers an unqualified %s as a real final report", async scenario => {
      h.autoUsage = false;
      h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
        await input.programmaticReads!.beforeRequest(new AbortController().signal);
        const receipt = normalizeModelUsage({ id: "msg_unqualified", model: "qualified-model", usage: { output_tokens: 1 } },
          "qualified-model", scenario === "compatible receipt" ? "https://compatible.invalid" : "https://api.anthropic.com");
        if (scenario === "direct receipt") input.onUsage!(receipt);
        else if (scenario !== "missing receipt") input.onUsage!(receipt, { codeExecutionRequests: 1 });
        return { ...completed(), summary: PRIVATE,
          ...(scenario === "mock" ? { mock: true } : {}),
          ...(scenario === "approval" ? { requiresApproval: true } : {}),
          ...(scenario === "deferred action" ? { toolCalls: [{ tool: "web_search", params: { query: "late" } }] } : {}),
        };
      });
      const result = await cycle();
      expect(result).toMatchObject({ status: "error", retryable: false }); expect(reports()).toEqual([]);
      expect(h.execute).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled(); assertPrivate(result);
    },
  );

  it.each(["not_applicable", "unavailable", "throws"])("does not claim delivery after %s and never repeats inference", async status => {
    h.decide.mockImplementation(withoutReads);
    h.persist.mockImplementation(async () => {
      if (status === "throws") throw new Error(PRIVATE);
      return { status };
    });
    const result = await cycle();
    expect(result).toMatchObject({ status: "error", retryable: false }); expect(h.decide).toHaveBeenCalledOnce();
    expect(h.persist).toHaveBeenCalledOnce(); expect(h.execute).not.toHaveBeenCalled(); assertPrivate(result);
  });

  it.each(["global stop", "autonomy", "ownership", "qualification"])("rechecks %s before final delivery", async change => {
    const read = tool();
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      await input.programmaticReads!.beforeRequest(new AbortController().signal);
      if (change === "global stop") h.stopped = true;
      if (change === "autonomy") h.state.autonomyLevel = 1;
      if (change === "ownership") h.resolve.mockRejectedValueOnce(new Error(PRIVATE));
      if (change === "qualification") read.programmaticRead = undefined;
      return { ...completed(), summary: PRIVATE };
    });
    const result = await cycle(definition([read]));
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(reports()).toEqual([]); expect(h.arm).not.toHaveBeenCalled(); assertPrivate(result);
  });

  it("rechecks a stop after arming a report-only brief", async () => {
    h.decide.mockImplementation(withoutReads);
    h.arm.mockImplementation(async () => { h.stopped = true; });
    const result = await cycle({ ...definition(), pendingBriefKey: "pending_brief" });
    expect(result.status).toBe("error"); expect(h.arm).toHaveBeenCalledOnce(); expect(reports()).toEqual([]);
  });

  it("does not turn a late storage acknowledgement into success or rewrite the closed journal", async () => {
    vi.useFakeTimers();
    const entered = gate(); const release = gate<unknown>();
    h.decide.mockImplementation(withoutReads);
    h.persist.mockImplementation(async () => { entered.resolve(); return release.promise; });
    const pending = cycle(); await entered.promise;
    await vi.advanceTimersByTimeAsync(5001);
    const result = await pending;
    expect(result).toMatchObject({ status: "error", retryable: false }); expect(h.finish).toHaveBeenCalledOnce();
    const closed = JSON.stringify([result, h.finish.mock.calls]);
    release.resolve({ status: "stored", id: "00000000-0000-4000-8000-000000000813" });
    await Promise.resolve(); await Promise.resolve();
    expect(JSON.stringify([result, h.finish.mock.calls])).toBe(closed);
    expect(h.decide).toHaveBeenCalledOnce(); expect(h.persist).toHaveBeenCalledOnce(); assertPrivate(result);
  });

  it("never starts a late storage write after delivery authorization times out", async () => {
    vi.useFakeTimers();
    const entered = gate(); const release = gate<AgentDefinition>();
    const agent = definition();
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      await input.programmaticReads!.beforeRequest(new AbortController().signal);
      h.resolve.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
      return completed();
    });
    const pending = cycle(agent); await entered.promise;
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toMatchObject({ status: "error", retryable: false });
    release.resolve(agent); await Promise.resolve(); await Promise.resolve();
    expect(h.persist).not.toHaveBeenCalled(); expect(h.arm).not.toHaveBeenCalled(); expect(h.finish).toHaveBeenCalledOnce();
  });
});
