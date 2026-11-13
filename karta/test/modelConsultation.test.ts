import { afterEach, describe, expect, it, vi } from "vitest";
import { runModelConsultation, type ConsultationCall, type ConsultationDependencies, type ConsultationReceipt,
  type ConsultationRequest } from "../src/claude/consultation.js";
import { normalizeModelUsage } from "../src/claude/usage.js";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import type { AgentDecision } from "../src/engine/types.js";
import type { ConnectedResearchResult } from "../src/knowledge/connected-research.js";

const MODEL_NAMES = ["primary-qualified", "reviewer-one", "reviewer-two", "reviewer-three"];
function request(overrides: Partial<ConsultationRequest> = {}): ConsultationRequest {
  return { operationId: "consultation-1", userId: "user-1", question: "Compare les sources pour ce projet.",
    preferences: { model: MODEL_NAMES[0], reflection: "maximum", speed: "standard" }, ...overrides };
}
function researchResult(provider: "perplexity" | "firecrawl", id = "external-1"): ConnectedResearchResult {
  return { provider, retrievalId: id, retrievedAt: "2026-11-12T20:00:00.000Z", providerRequestId: id,
    verificationStatus: "unverified", independentlyVerified: false, costMicros: null, sourceTextTrust: "untrusted_data",
    sources: [{ sourceId: `${id}:1`, url: "https://example.com/article", title: "Reference", text: "Unverified content",
      contentKind: provider === "perplexity" ? "search_excerpt" : "page_markdown" }] };
}
type ModelCall = { name: string; input: ClaudeDecideInput; phase: "proposal" | "critique" | "synthesis" };
function harness() {
  const claims: Array<{ userId: string; operationId: string; requestHash: string }> = [];
  const reservations: ConsultationCall[] = [];
  const settlements: ConsultationReceipt[] = [];
  const modelCalls: ModelCall[] = [];
  const events: string[] = [];
  const claimed = new Set<string>();
  const state = {
    rejectClaim: false,
    deny: new Set<ConsultationCall["kind"]>(),
    reserve: undefined as undefined | ((call: ConsultationCall, signal: AbortSignal) => Promise<boolean>),
    settle: undefined as undefined | ((receipt: ConsultationReceipt) => Promise<void>),
    decide: undefined as undefined | ((call: ModelCall) => Promise<AgentDecision>),
    conclusion: undefined as undefined | ((call: ModelCall) => string),
    search: undefined as undefined | ((query: string, options: { signal?: AbortSignal; limit?: number }) => Promise<ConnectedResearchResult>),
    scrape: undefined as undefined | ((url: string, options: { signal?: AbortSignal }) => Promise<ConnectedResearchResult>),
  };
  const search = vi.fn(async (query: string, options: { signal?: AbortSignal; limit?: number }) => {
    events.push("search");
    return state.search ? state.search(query, options) : researchResult("perplexity", `search-${query}`);
  });
  const scrape = vi.fn(async (url: string, options: { signal?: AbortSignal }) => {
    events.push("scrape");
    return state.scrape ? state.scrape(url, options) : researchResult("firecrawl", "scrape-1");
  });
  const deps: ConsultationDependencies = {
    catalog: MODEL_NAMES.map(model => ({ model, maxOutputTokens: 16_384, reasoning: "budget" })),
    models: MODEL_NAMES.map(name => ({ model: name, provider: `provider-${name}`, client: {
      isMock: false,
      decide: async input => {
        const phase = input.systemPrompt.includes("Retourne uniquement") ? "synthesis"
          : "opinions" in input.context ? "critique" : "proposal";
        const call: ModelCall = { name, input, phase };
        modelCalls.push(call);
        events.push(`${phase}:${name}`);
        input.onUsage?.(normalizeModelUsage({ id: `response-${modelCalls.length}`, model: name,
          usage: { input_tokens: 20, output_tokens: 10 } }, name, "https://api.anthropic.com"));
        if (state.decide) return state.decide(call);
        const sources = input.context.sources as Array<{ id: string }> | undefined;
        const summary = phase === "synthesis" ? (state.conclusion?.(call) ?? JSON.stringify({
          answer: "Une conclusion utile, avec ses limites.", citedSourceIds: sources?.map(source => source.id) ?? [],
          disagreements: ["Le consensus ne prouve pas le résultat."], uncertainties: ["Les sources restent à vérifier."],
        })) : `${name}: avis non vérifié`;
        return { summary, toolCalls: [], requiresApproval: false, mock: false };
      },
    } })),
    research: { search, scrape },
    admission: {
      claim: async value => {
        claims.push(structuredClone(value)); events.push("claim");
        const key = `${value.userId}:${value.operationId}`;
        if (state.rejectClaim || claimed.has(key)) return false;
        claimed.add(key); return true;
      },
      reserve: async (value, signal) => {
        reservations.push(structuredClone(value)); events.push(`reserve:${value.kind}`);
        return state.reserve ? state.reserve(value, signal) : !state.deny.has(value.kind);
      },
      settle: async value => {
        settlements.push(structuredClone(value)); events.push(`settle:${value.call.kind}`);
        if (state.settle) await state.settle(value);
      },
    },
  };
  return { deps, state, claims, reservations, settlements, modelCalls, events, search, scrape };
}

afterEach(() => vi.useRealTimers());

describe("multi-model consultation composition", () => {
  it("uses only the exact primary for synthesis and reserves/reconciles every individual operation", async () => {
    const h = harness();
    const result = await runModelConsultation(request({ reviewerModels: [MODEL_NAMES[1], MODEL_NAMES[2]],
      research: { queries: ["public query"], urls: ["https://example.com/article"] } }), h.deps);
    expect(result.status).toBe("complete");
    expect(result.verificationStatus).toBe("unverified");
    expect(result.sources).toHaveLength(2);
    expect(result.citedSourceIds).toEqual(["S1", "S2"]);
    expect(h.modelCalls.filter(call => call.phase === "synthesis").map(call => call.name)).toEqual([MODEL_NAMES[0]]);
    expect(h.modelCalls).toHaveLength(6); // three proposals, two critiques, one synthesis.
    expect(h.reservations).toHaveLength(8);
    expect(h.settlements).toHaveLength(8);
    expect(h.settlements.every(receipt => receipt.status === "completed")).toBe(true);
    expect(new Set(h.reservations.map(call => call.callId)).size).toBe(8);
    expect(h.reservations.every(call => call.userId === "user-1" && call.operationId === "consultation-1" && /^[a-f0-9]{64}$/.test(call.inputHash))).toBe(true);
    expect(h.modelCalls.every(call => call.input.tools.length === 0 && call.input.preferences?.model === call.name)).toBe(true);
    expect(h.claims[0]).toMatchObject({ userId: "user-1", operationId: "consultation-1" });
    expect(h.claims[0].requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    { reflection: "standard", speed: "standard", peers: 1, proposals: 2, critiques: 0 },
    { reflection: "deep", speed: "fast", peers: 2, proposals: 3, critiques: 2 },
    { reflection: "maximum", speed: "standard", peers: 3, proposals: 4, critiques: 3 },
    { reflection: "maximum", speed: "ultra_fast", peers: 0, proposals: 0, critiques: 0 },
  ] as const)("bounds work for $reflection / $speed", async value => {
    const h = harness();
    const result = await runModelConsultation(request({ preferences: { model: MODEL_NAMES[0], reflection: value.reflection, speed: value.speed },
      reviewerModels: MODEL_NAMES.slice(1, value.peers + 1) }), h.deps);
    expect(result.status).toBe("complete");
    expect(h.modelCalls.filter(call => call.phase === "proposal")).toHaveLength(value.proposals);
    expect(h.modelCalls.filter(call => call.phase === "critique")).toHaveLength(value.critiques);
    expect(h.modelCalls.filter(call => call.phase === "synthesis")).toHaveLength(1);
  });

  it("keeps separate immutable usage counters for each model call", async () => {
    const h = harness();
    const result = await runModelConsultation(request({ reviewerModels: [MODEL_NAMES[1]] }), h.deps);
    const modelReceipts = result.receipts.filter(receipt => receipt.call.model);
    expect(modelReceipts).toHaveLength(4);
    expect(modelReceipts.every(receipt => receipt.usage.length === 1)).toBe(true);
    expect(new Set(modelReceipts.map(receipt => receipt.usage[0].responseId)).size).toBe(4);
    expect(modelReceipts.every(receipt => receipt.usage[0].requestedModel === receipt.call.model)).toBe(true);
    expect(modelReceipts.every(receipt => receipt.usage[0].inputTokens === 20 && receipt.usage[0].outputTokens === 10)).toBe(true);
  });

  it("deduplicates exact requested queries and URLs before spending", async () => {
    const h = harness();
    await runModelConsultation(request({ research: { queries: ["same", "same"], urls: ["https://example.com/a", "https://example.com/a"] } }), h.deps);
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.scrape).toHaveBeenCalledTimes(1);
  });

  it("sends only explicit public query/URL to research providers, not the full question", async () => {
    const h = harness();
    await runModelConsultation(request({ question: "PRIVATE project context", research: { queries: ["public query"], urls: ["https://example.com/a"] } }), h.deps);
    expect(h.search.mock.calls[0][0]).toBe("public query");
    expect(h.scrape.mock.calls[0][0]).toBe("https://example.com/a");
    expect(JSON.stringify(h.search.mock.calls)).not.toContain("PRIVATE");
  });

  it("does not add omitted reviewers or research requests", async () => {
    const h = harness();
    delete h.deps.research;
    const result = await runModelConsultation(request(), h.deps);
    expect(result.status).toBe("complete");
    expect(h.modelCalls.map(call => call.name)).toEqual([MODEL_NAMES[0]]);
    expect(h.search).not.toHaveBeenCalled();
    expect(h.scrape).not.toHaveBeenCalled();
  });

  it("never runs more simultaneous models than the selected plan permits", async () => {
    const h = harness();
    let active = 0;
    let maximum = 0;
    h.state.decide = async call => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise(done => setImmediate(done));
      active -= 1;
      return { summary: call.phase === "synthesis"
        ? JSON.stringify({ answer: "Synthèse", citedSourceIds: [], disagreements: [], uncertainties: [] })
        : "Avis", toolCalls: [], requiresApproval: false, mock: false };
    };
    const result = await runModelConsultation(request({ reviewerModels: MODEL_NAMES.slice(1) }), h.deps);
    expect(result.status).toBe("complete");
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });

  it("does not forward undeclared source metadata to the models or final result", async () => {
    const h = harness();
    h.state.search = async () => {
      const value = researchResult("perplexity");
      Object.assign(value.sources[0], { privateProviderMetadata: "PRIVATE-UNDECLARED-METADATA" });
      return value;
    };
    const result = await runModelConsultation(request({ research: { queries: ["public"], urls: [] } }), h.deps);
    expect(result.status).toBe("complete");
    expect(JSON.stringify(result)).not.toContain("PRIVATE-UNDECLARED-METADATA");
    expect(JSON.stringify(h.modelCalls[0].input.context)).not.toContain("PRIVATE-UNDECLARED-METADATA");
  });

  it("keeps individual source IDs and bounds text supplied to all consulted models", async () => {
    const h = harness();
    h.state.search = async query => {
      const value = researchResult("perplexity", query);
      value.sources = Array.from({ length: 6 }, (_, index) => ({ ...value.sources[0], sourceId: `${query}:${index}`, text: "x".repeat(3000) }));
      return value;
    };
    const result = await runModelConsultation(request({ research: { queries: ["one", "two", "three"], urls: [] } }), h.deps);
    expect(result.status).toBe("complete");
    expect(result.sources).toHaveLength(18);
    expect(new Set(result.sources.map(source => source.id)).size).toBe(18);
    const sources = h.modelCalls[0].input.context.sources as Array<{ text: string; textTruncated: boolean }>;
    expect(sources.reduce((size, source) => size + source.text.length, 0)).toBeLessThanOrEqual(32_000);
    expect(sources.every(source => source.text.length <= 2000)).toBe(true);
    expect(sources.some(source => source.textTruncated)).toBe(true);
  });
});

describe("host permissions, exact model qualification and accounting", () => {
  it("does not invoke providers when reservations are denied", async () => {
    const h = harness();
    h.state.reserve = async () => false;
    const result = await runModelConsultation(request({ reviewerModels: [MODEL_NAMES[1]], research: { queries: ["public"], urls: ["https://example.com/a"] } }), h.deps);
    expect(result.answer).toBeNull();
    expect(h.modelCalls).toEqual([]);
    expect(h.search).not.toHaveBeenCalled();
    expect(h.scrape).not.toHaveBeenCalled();
    expect(h.settlements.length).toBeGreaterThan(0);
    expect(h.settlements.every(receipt => receipt.status === "blocked" && receipt.usage.length === 0)).toBe(true);
  });

  it("a duplicated operation cannot trigger a second reserve or provider call", async () => {
    const h = harness();
    await runModelConsultation(request(), h.deps);
    const reserveCount = h.reservations.length;
    const second = await runModelConsultation(request({ question: "Changed payload, same identity" }), h.deps);
    expect(second).toMatchObject({ status: "blocked", reason: "already_claimed", answer: null });
    expect(h.reservations).toHaveLength(reserveCount);
    expect(h.modelCalls).toHaveLength(1);
    expect(h.claims[0].requestHash).not.toBe(h.claims[1].requestHash);
  });

  it.each([
    { reviewerModels: ["missing-model"] },
    { reviewerModels: [MODEL_NAMES[1], MODEL_NAMES[1]] },
    { reviewerModels: [MODEL_NAMES[0]] },
    { reviewerModels: [MODEL_NAMES[1]], preferences: { model: MODEL_NAMES[0], speed: "ultra_fast" } },
  ] as Array<Partial<ConsultationRequest>>)("rejects unavailable, duplicate or out-of-profile peers without substitution", async overrides => {
    const h = harness();
    await expect(runModelConsultation(request(overrides), h.deps)).rejects.toThrow();
    expect(h.claims).toEqual([]);
    expect(h.modelCalls).toEqual([]);
  });

  it("rejects a simulated client or absent admission before provider work", async () => {
    const h = harness();
    h.deps.models[0].client = { ...h.deps.models[0].client, isMock: true };
    await expect(runModelConsultation(request(), h.deps)).rejects.toThrow();
    expect(h.claims).toEqual([]);
    const other = harness();
    delete (other.deps as Partial<ConsultationDependencies>).admission;
    await expect(runModelConsultation(request(), other.deps)).rejects.toThrow();
    expect(other.modelCalls).toEqual([]);
  });

  it("stops further calls when settlement fails and never claims a complete result", async () => {
    const h = harness();
    h.state.settle = async () => { throw new Error("private ledger error"); };
    const result = await runModelConsultation(request({ research: { queries: ["one", "two"], urls: [] } }), h.deps);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("accounting_unavailable");
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.modelCalls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private ledger error");
  });

  it("a stalled settlement cannot certify a complete consultation or launch subsequent calls", async () => {
    vi.useFakeTimers();
    const h = harness();
    let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    h.state.settle = async () => { entered(); await new Promise<void>(() => undefined); };
    const running = runModelConsultation(request({ research: { queries: ["one", "two"], urls: [] } }), h.deps);
    await started;
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await running;
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("accounting_unavailable");
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.modelCalls).toEqual([]);
  });

  it("a late reservation after cancellation settles without sending an inference", async () => {
    vi.useFakeTimers();
    const h = harness();
    const controller = new AbortController();
    let entered!: () => void;
    let release!: (reserved: boolean) => void;
    const started = new Promise<void>(done => { entered = done; });
    h.state.reserve = async () => { entered(); return new Promise(done => { release = done; }); };
    const running = runModelConsultation(request(), h.deps, controller.signal);
    await started;
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await running;
    const snapshot = JSON.stringify(result);
    expect(result.reason).toBe("accounting_unavailable");
    expect(h.modelCalls).toEqual([]);
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.modelCalls).toEqual([]);
    expect(h.settlements).toHaveLength(1);
    expect(h.settlements[0].status).toBe("blocked");
    expect(JSON.stringify(result)).toBe(snapshot);
    const replay = await runModelConsultation(request(), h.deps);
    expect(replay.reason).toBe("already_claimed");
    expect(h.reservations).toHaveLength(1);
  });

  it("records a missing retrieval as partial and still synthesizes with explicit missing calls", async () => {
    const h = harness();
    h.state.deny.add("search");
    const result = await runModelConsultation(request({ research: { queries: ["public"], urls: [] } }), h.deps);
    expect(result.status).toBe("partial");
    expect(result.reason).toBe("some_calls_unavailable");
    expect(h.modelCalls[0].input.context.unavailableCalls).toContain("search");
    expect(result.sources).toEqual([]);
  });
});

describe("untrusted model output and cancellation", () => {
  it("never retries a failed inference and retains its usage as uncertain", async () => {
    const h = harness();
    h.state.decide = async () => { throw new Error("private provider error"); };
    const result = await runModelConsultation(request(), h.deps);
    expect(result.status).toBe("failed");
    expect(h.modelCalls).toHaveLength(1);
    expect(h.settlements).toHaveLength(1);
    expect(h.settlements[0]).toMatchObject({ status: "uncertain" });
    expect(h.settlements[0].usage).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private provider error");
  });

  it.each(["S999", "fabricated-source"])("rejects invented citation %s", async citedSourceId => {
    const h = harness();
    h.state.conclusion = () => JSON.stringify({ answer: "Unverified answer", citedSourceIds: [citedSourceId], disagreements: [], uncertainties: [] });
    const result = await runModelConsultation(request({ research: { queries: ["public"], urls: [] } }), h.deps);
    expect(result.status).toBe("failed");
    expect(result.answer).toBeNull();
    expect(result.citedSourceIds).toEqual([]);
    expect(h.settlements.at(-1)?.status).toBe("uncertain");
  });

  it("refuses tool calls from a consulted model and never exposes executable tools", async () => {
    const h = harness();
    h.state.decide = async () => ({ summary: "Execute this", toolCalls: [{ tool: "send_money", params: { amount: 100 } }], requiresApproval: false, mock: false });
    const result = await runModelConsultation(request(), h.deps);
    expect(result.answer).toBeNull();
    expect(result.status).toBe("failed");
    expect(h.modelCalls).toHaveLength(1);
    expect(h.modelCalls[0].input.tools).toEqual([]);
  });

  it("rejects malformed source data and reports retrieval as partial instead of treating it as verified", async () => {
    const h = harness();
    h.state.search = async () => ({ ...researchResult("perplexity"), verificationStatus: "verified" } as never);
    const result = await runModelConsultation(request({ research: { queries: ["public"], urls: [] } }), h.deps);
    expect(result.status).toBe("partial");
    expect(result.sources).toEqual([]);
    expect(result.receipts[0].status).toBe("uncertain");
  });

  it("cancels before claiming and never contacts providers", async () => {
    const h = harness();
    const result = await runModelConsultation(request(), h.deps, AbortSignal.abort("private cancellation"));
    expect(result.reason).toBe("interrupted");
    expect(h.claims).toEqual([]);
    expect(h.modelCalls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private cancellation");
  });

  it("cancellation during reservation prevents the paid call", async () => {
    const h = harness();
    const controller = new AbortController();
    h.state.reserve = async () => { controller.abort(); return true; };
    const result = await runModelConsultation(request(), h.deps, controller.signal);
    expect(result.answer).toBeNull();
    expect(h.modelCalls).toEqual([]);
    expect(h.settlements).toHaveLength(1);
  });

  it("late uncooperative retrieval cannot launch inference or mutate an already returned result", async () => {
    const h = harness();
    const controller = new AbortController();
    let resolve!: (result: ConnectedResearchResult) => void;
    let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    h.state.search = () => { entered(); return new Promise(done => { resolve = done; }); };
    const running = runModelConsultation(request({ research: { queries: ["public"], urls: [] } }), h.deps, controller.signal);
    await started;
    controller.abort();
    const result = await running;
    const snapshot = JSON.stringify(result);
    resolve(researchResult("perplexity"));
    await new Promise(done => setImmediate(done));
    expect(h.modelCalls).toEqual([]);
    expect(result.answer).toBeNull();
    expect(JSON.stringify(result)).toBe(snapshot);
  });

  it("a late model response after cancellation cannot launch another panel or change returned receipts", async () => {
    const h = harness();
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const pending: Array<(decision: AgentDecision) => void> = [];
    h.state.decide = async () => { entered(); return new Promise(done => pending.push(done)); };
    const running = runModelConsultation(request({ reviewerModels: MODEL_NAMES.slice(1) }), h.deps, controller.signal);
    await started;
    controller.abort();
    const result = await running;
    const snapshot = JSON.stringify(result);
    const count = h.modelCalls.length;
    for (const resolve of pending) resolve({ summary: "Late answer", toolCalls: [], requiresApproval: false, mock: false });
    await new Promise(done => setImmediate(done));
    expect(h.modelCalls).toHaveLength(count);
    expect(h.modelCalls.every(call => call.phase === "proposal")).toBe(true);
    expect(count).toBeLessThanOrEqual(2);
    expect(result.answer).toBeNull();
    expect(JSON.stringify(result)).toBe(snapshot);
  });

  it("refuses accessors in request data without running them", async () => {
    const h = harness();
    const raw = request();
    const getter = vi.fn(() => "private side effect");
    Object.defineProperty(raw, "question", { get: getter, enumerable: true });
    await expect(runModelConsultation(raw, h.deps)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(h.claims).toEqual([]);
    expect(h.modelCalls).toEqual([]);
  });

  it("snapshots request data before asynchronous host admission", async () => {
    const h = harness();
    const original = request();
    let resume!: (allowed: boolean) => void;
    h.deps.admission.claim = async () => new Promise(done => { resume = done; });
    const resultPromise = runModelConsultation(original, h.deps);
    await Promise.resolve();
    original.question = "MUTATED private text";
    original.preferences.model = MODEL_NAMES[1];
    resume(true);
    const result = await resultPromise;
    expect(result.status).toBe("complete");
    expect(h.modelCalls[0].name).toBe(MODEL_NAMES[0]);
    expect(h.modelCalls[0].input.context.question).not.toContain("MUTATED");
  });
});
