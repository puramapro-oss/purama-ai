import { describe, expect, it, vi } from "vitest";
import { createConsultationHost } from "../src/claude/consultation-host.js";
import type { ConsultationOperation } from "../src/claude/consultation-store.js";
import type { ConsultationInput } from "../src/api/consultation-contract.js";
import type { ModelExecutionCapability } from "../src/claude/execution-profile.js";
import type { ClaudeClient } from "../src/claude/types.js";
import type { ConsultationResult } from "../src/claude/consultation.js";

const user = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const input: ConsultationInput = { operationId: id, question: "Une question publique", preferences: { model: "main", reflection: "deep" } };
const catalog: ModelExecutionCapability[] = ["main", "peer"].map(model => ({
  model, maxOutputTokens: 16_384, reasoning: "adaptive", effortLevels: ["low", "medium", "high"],
}));
const policy = { version: "qualification-test-v1", expiresAt: "2030-01-01T00:00:00Z",
  models: ["main", "peer"].map(model => ({ model, maxInputTokens: 131_072, maxOutputTokens: 16_384, maxCostMicros: 300_000 })) };
function fixture() {
  let operation: ConsultationOperation | null = null;
  const admission = { claim: vi.fn(async () => true), reserve: vi.fn(async () => true), settle: vi.fn(async () => undefined) };
  const store = {
    availability: vi.fn(async () => true),
    resume: vi.fn(async () => null as ConsultationOperation | null),
    status: vi.fn(async () => operation),
    cancel: vi.fn(async () => {
      if (operation) operation = { ...operation, cancelRequested: true, state: "cancelled" };
      return operation;
    }),
    begin: vi.fn(async () => {
      operation = { operationId: id, state: "pending", resourceState: "reserved", cancelRequested: false,
        result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      return { created: true as const, operation, admission, finalize: vi.fn(async (result: ConsultationResult) => {
        operation = { ...operation!, state: operation!.cancelRequested ? "cancelled" : "complete",
          resourceState: "reconciliation_required", result };
        return operation;
      }) };
    }),
  };
  const decide = vi.fn<ClaudeClient["decide"]>(async request => ({
    summary: request.systemPrompt.includes("citedSourceIds")
      ? JSON.stringify({ answer: "Conclusion bornée", citedSourceIds: [], disagreements: ["Divergence conservée"], uncertainties: ["Non vérifié"] })
      : "Avis indépendant",
    toolCalls: [], requiresApproval: false, mock: false,
  }));
  const loadCatalog = vi.fn(async () => catalog);
  const stopped = vi.fn(async () => false);
  const createClient = vi.fn(() => ({ isMock: false, decide }));
  const options = { policyJson: JSON.stringify(policy), apiKey: "test-only", simulation: false,
    store, loadCatalog, stopped, createClient };
  return { store, admission, decide, loadCatalog, stopped, createClient, options, host: createConsultationHost(options) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
function nativeCatalogue(maxOutputTokens = 16_384) {
  return Response.json({ data: [
    { id: "main", lifecycle: "active", max_tokens: maxOutputTokens, capabilities: { thinking: null } },
    { id: "peer", lifecycle: "active", max_tokens: maxOutputTokens, capabilities: { thinking: null } },
  ], has_more: false });
}

describe("catalogue request reuse and cancellation isolation", () => {
  it("shares one native GET across a burst while checking every user's grant independently", async () => {
    const f = fixture(); const release = deferred<void>();
    const other = "33333333-3333-4333-8333-333333333333";
    const availability = vi.fn(async (owner: string) => owner === user);
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await release.promise;
      return nativeCatalogue();
    });
    try {
      const host = createConsultationHost({ ...f.options, loadCatalog: undefined, store: { ...f.store, availability } });
      const owners = Array.from({ length: 32 }, (_, i) => i % 2 ? other : user);
      const results = owners.map(owner => host.catalog(owner, new AbortController().signal));
      await vi.waitFor(() => expect(transport).toHaveBeenCalled());
      release.resolve();
      const catalogs = await Promise.all(results);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(availability).toHaveBeenCalledTimes(owners.length);
      expect(availability.mock.calls.map(([owner]) => owner).sort()).toEqual([...owners].sort());
      expect(catalogs.map(result => result.reason)).toEqual(owners.map(owner => owner === user ? "ready" : "budget_unavailable"));
      expect(catalogs.every(result => result.models.length === 2 && result.models.every(model => model.maxOutputTokens === 16_384))).toBe(true);
      expect(f.decide).not.toHaveBeenCalled();
      expect(f.store.begin).not.toHaveBeenCalled();
    } finally { release.resolve(); transport.mockRestore(); }
  });

  it("cancels one requester without cancelling the other requester's shared native GET", async () => {
    const f = fixture(); const release = deferred<void>();
    const first = new AbortController(); const second = new AbortController();
    const transportSignals: AbortSignal[] = [];
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      transportSignals.push(init!.signal!);
      await release.promise;
      return nativeCatalogue();
    });
    try {
      const host = createConsultationHost({ ...f.options, loadCatalog: undefined });
      const abandoned = host.catalog(user, first.signal);
      const surviving = host.catalog(user, second.signal);
      await vi.waitFor(() => expect(transport).toHaveBeenCalled());
      first.abort();
      const abandonedResult = await abandoned;
      const activeSignals = transportSignals.filter(signal => !signal.aborted).length;
      release.resolve();
      const survivingResult = await surviving;
      expect(abandonedResult.available).toBe(false);
      expect(survivingResult.reason).toBe("ready");
      expect(activeSignals).toBe(1);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(f.store.availability).toHaveBeenCalledExactlyOnceWith(user, second.signal);
    } finally { first.abort(); second.abort(); release.resolve(); transport.mockRestore(); }
  });

  it("aborts an abandoned load, admits a fresh load and excludes its late predecessor from the cache", async () => {
    const f = fixture(); const old = deferred<void>(); const fresh = deferred<void>();
    const first = new AbortController(); const second = new AbortController();
    let phase: "old" | "fresh" = "old";
    const oldSignals: AbortSignal[] = [];
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const current = phase;
      if (current === "old") { oldSignals.push(init!.signal!); await old.promise; }
      else await fresh.promise;
      return nativeCatalogue(current === "old" ? 1024 : 8192);
    });
    try {
      const host = createConsultationHost({ ...f.options, loadCatalog: undefined });
      const requests = [host.catalog(user, first.signal), host.catalog(user, second.signal)];
      await vi.waitFor(() => expect(transport).toHaveBeenCalled());
      first.abort(); second.abort();
      expect((await Promise.all(requests)).every(result => !result.available)).toBe(true);
      expect(oldSignals.every(signal => signal.aborted)).toBe(true);
      phase = "fresh";
      const next = host.catalog(user, new AbortController().signal);
      await vi.waitFor(() => expect(transport.mock.calls.length).toBeGreaterThan(oldSignals.length));
      fresh.resolve();
      expect((await next).models[0].maxOutputTokens).toBe(8192);
      old.resolve();
      await Promise.resolve(); await Promise.resolve();
      expect((await host.catalog(user, new AbortController().signal)).models[0].maxOutputTokens).toBe(8192);
      expect(transport).toHaveBeenCalledTimes(2);
    } finally { first.abort(); second.abort(); old.resolve(); fresh.resolve(); transport.mockRestore(); }
  });

  it("does not cache a failed shared load and can recover without retaining a failed promise", async () => {
    const f = fixture(); const failed = deferred<ModelExecutionCapability[]>();
    let recovery = false;
    const loadCatalog = vi.fn(async () => recovery ? catalog : failed.promise);
    const host = createConsultationHost({ ...f.options, loadCatalog });
    const requests = Array.from({ length: 4 }, () => host.catalog(user, new AbortController().signal));
    await vi.waitFor(() => expect(loadCatalog).toHaveBeenCalled());
    failed.reject(new Error("temporary provider failure"));
    expect((await Promise.all(requests)).every(result => result.reason === "account_unavailable")).toBe(true);
    recovery = true;
    expect((await host.catalog(user, new AbortController().signal)).reason).toBe("ready");
    expect(loadCatalog).toHaveBeenCalledTimes(2);
    expect(f.store.availability).toHaveBeenCalledTimes(1);
  });

  it("shares and caches an empty result until expiry, then discovers the available models", async () => {
    const f = fixture(); const release = deferred<ModelExecutionCapability[]>();
    let clock = Date.parse("2026-11-23T00:00:00Z"); let refresh = false;
    const loadCatalog = vi.fn(async () => refresh ? catalog : release.promise);
    const host = createConsultationHost({ ...f.options, loadCatalog, now: () => clock });
    const requests = Array.from({ length: 4 }, () => host.catalog(user, new AbortController().signal));
    await vi.waitFor(() => expect(loadCatalog).toHaveBeenCalled());
    release.resolve([]);
    expect((await Promise.all(requests)).every(result => result.reason === "model_unavailable")).toBe(true);
    clock += 59_999;
    expect((await host.catalog(user, new AbortController().signal)).reason).toBe("model_unavailable");
    const callsBeforeExpiry = loadCatalog.mock.calls.length;
    refresh = true; clock += 1;
    expect((await host.catalog(user, new AbortController().signal)).reason).toBe("ready");
    expect(callsBeforeExpiry).toBe(1);
    expect(loadCatalog).toHaveBeenCalledTimes(2);
    expect(f.store.availability).toHaveBeenCalledTimes(1);
  });

  it("rejects a catalogue arriving after the policy expires before checking a spending grant", async () => {
    const f = fixture(); const release = deferred<ModelExecutionCapability[]>();
    let clock = Date.parse(policy.expiresAt) - 1;
    const loadCatalog = vi.fn(async () => release.promise);
    const host = createConsultationHost({ ...f.options, loadCatalog, now: () => clock });
    const request = host.catalog(user, new AbortController().signal);
    await vi.waitFor(() => expect(loadCatalog).toHaveBeenCalled());
    clock += 1; release.resolve(catalog);
    expect((await request).available).toBe(false);
    expect(f.store.availability).not.toHaveBeenCalled();
    expect(f.store.begin).not.toHaveBeenCalled();
    expect(f.decide).not.toHaveBeenCalled();
  });

  it.each(["expired", "cancelled"])("does not publish ready when the request becomes %s during the owner grant check", async condition => {
    const f = fixture(); const grant = deferred<boolean>(); const controller = new AbortController();
    let clock = Date.parse(policy.expiresAt) - 1;
    const availability = vi.fn(async () => grant.promise);
    const host = createConsultationHost({ ...f.options, now: () => clock, store: { ...f.store, availability } });
    const request = host.catalog(user, controller.signal);
    await vi.waitFor(() => expect(availability).toHaveBeenCalled());
    if (condition === "expired") clock += 1;
    else controller.abort();
    grant.resolve(true);
    const result = await request;
    expect(result.available).toBe(false);
    expect(result.reason).toBe(condition === "expired" ? "not_configured" : "service_unavailable");
    expect(result.models).toEqual([]);
    expect(f.decide).not.toHaveBeenCalled();
  });

  it("releases a timed-out load even when its transport ignores cancellation and excludes a late result", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = fixture(); const late = deferred<ModelExecutionCapability[]>();
    const signals: AbortSignal[] = []; let recovery = false;
    const loadCatalog = vi.fn(async (_limits: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return recovery ? catalog : late.promise;
    });
    try {
      const host = createConsultationHost({ ...f.options, loadCatalog });
      const requests = [host.catalog(user, new AbortController().signal), host.catalog(user, new AbortController().signal)];
      await vi.advanceTimersByTimeAsync(5001);
      expect((await Promise.all(requests)).every(result => result.reason === "account_unavailable")).toBe(true);
      expect(signals.every(signal => signal.aborted)).toBe(true);
      recovery = true;
      expect((await host.catalog(user, new AbortController().signal)).models[0].maxOutputTokens).toBe(16_384);
      late.resolve(catalog.map(model => ({ ...model, maxOutputTokens: 1024 })));
      await Promise.resolve(); await Promise.resolve();
      expect((await host.catalog(user, new AbortController().signal)).models[0].maxOutputTokens).toBe(16_384);
      expect(loadCatalog).toHaveBeenCalledTimes(2);
      expect(f.store.availability).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { late.resolve(catalog); vi.useRealTimers(); }
  });

  it("returns independent mutable public views without mutating the cached capabilities", async () => {
    const f = fixture();
    const first = await f.host.catalog(user, new AbortController().signal);
    const expected = structuredClone(first);
    first.models[0].model = "tampered";
    first.models[0].maxOutputTokens = 1024;
    first.models[0].profiles[0].research.maxSearches = 999;
    first.models[0].reflections.length = 0;
    expect(await f.host.catalog(user, new AbortController().signal)).toEqual(expected);
    expect(f.loadCatalog).toHaveBeenCalledTimes(1);
    expect(f.store.availability).toHaveBeenCalledTimes(2);
  });

  it("keeps provider credentials, policies and caches separate between host instances", async () => {
    const f = fixture(); const keys: string[] = [];
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const key = new Headers(init?.headers).get("x-api-key")!;
      keys.push(key);
      return nativeCatalogue(key === "test-first" ? 4096 : 8192);
    });
    try {
      const first = createConsultationHost({ ...f.options, loadCatalog: undefined, apiKey: "test-first" });
      const second = createConsultationHost({ ...f.options, loadCatalog: undefined, apiKey: "test-second" });
      for (let repeat = 0; repeat < 2; repeat++) {
        const [a, b] = await Promise.all([first.catalog(user, new AbortController().signal), second.catalog(user, new AbortController().signal)]);
        expect(a.models[0].maxOutputTokens).toBe(4096);
        expect(b.models[0].maxOutputTokens).toBe(8192);
      }
      expect(keys.sort()).toEqual(["test-first", "test-second"]);
      expect(f.store.availability).toHaveBeenCalledTimes(4);
      expect(f.decide).not.toHaveBeenCalled();
    } finally { transport.mockRestore(); }
  });
});
describe("real consultation host composition", () => {
  it.each([true, false])("loads the native catalogue from a full policy while keeping the owner grant separate: funded=%s", async funded => {
    const f = fixture();
    f.store.availability.mockResolvedValue(funded);
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/models?limit=1000");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBeUndefined();
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
        "anthropic-version": "2023-06-01", "x-api-key": "test-only",
      });
      return Response.json({ data: [
        { id: "main", lifecycle: "active", max_tokens: 32_768, capabilities: { thinking: null } },
        { id: "peer", lifecycle: "active", max_tokens: 8192, capabilities: { thinking: null } },
      ], has_more: false });
    });
    try {
      // Exercise the production loader instead of the injected catalogue used
      // by the other host fixtures. The policy also contains cost/input limits.
      const host = createConsultationHost({ ...f.options, loadCatalog: undefined });
      const signal = new AbortController().signal;
      const result = await host.catalog(user, signal);
      expect(result.available).toBe(funded);
      expect(result.reason).toBe(funded ? "ready" : "budget_unavailable");
      expect(result.models.map(({ model, maxOutputTokens }) => ({ model, maxOutputTokens }))).toEqual([
        { model: "main", maxOutputTokens: 16_384 },
        { model: "peer", maxOutputTokens: 8192 },
      ]);
      expect(transport).toHaveBeenCalledOnce();
      expect(f.loadCatalog).not.toHaveBeenCalled();
      expect(f.store.availability).toHaveBeenCalledExactlyOnceWith(user, signal);
      expect(f.store.begin).not.toHaveBeenCalled();
      expect(f.createClient).not.toHaveBeenCalled();
      expect(f.decide).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("maxCostMicros");
      expect(JSON.stringify(result)).not.toContain("maxInputTokens");
    } finally { transport.mockRestore(); }
  });
  it("publishes effective profiles and checks the existing owner resource grant", async () => {
    const f = fixture();
    const result = await f.host.catalog(user, new AbortController().signal);
    expect(result.available).toBe(true);
    expect(result.models[0].profiles).toHaveLength(12);
    expect(result.models[0].profiles.find(p => p.reflection === "maximum" && p.speed === "ultra_fast")?.research.maxReviewers).toBe(0);
    expect(f.store.availability).toHaveBeenCalledWith(user, expect.any(AbortSignal));
    expect(f.store.begin).not.toHaveBeenCalled();
    expect(f.decide).not.toHaveBeenCalled();
  });
  it("binds identity, exact models and per-call envelopes before inference", async () => {
    const f = fixture();
    const result = await f.host.consult(user, { ...input, reviewerModels: ["peer"] }, new AbortController().signal);
    expect(result.status).toBe("reconciliation_required");
    expect(result.result?.answer).toBe("Conclusion bornée");
    expect(result.result?.disagreements).toEqual(["Divergence conservée"]);
    expect(f.decide.mock.calls.map(([call]) => call.preferences?.model)).toEqual(["main", "peer", "peer", "main"]);
    const args = f.store.begin.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe(user);
    expect(args[1]).toMatchObject({ userId: user, operationId: id });
    expect(args[3]).toMatchObject({ policyVersion: policy.version, calls: expect.arrayContaining([
      expect.objectContaining({ model: "main", kind: "synthesis", maxCostMicros: 300_000, maxInputTokens: 131_072 }),
    ]) });
    expect(f.admission.reserve).toHaveBeenCalledTimes(4);
    expect(f.admission.settle).toHaveBeenCalledTimes(4);
    expect(result.result).not.toHaveProperty("receipts");
    expect(result.result?.plan).not.toHaveProperty("providerOptions");
  });
  it.each(["simulation", "missing_policy", "expired_policy", "paused", "no_grant"])("does not spend on %s", async condition => {
    const f = fixture();
    if (condition === "no_grant") f.store.availability.mockResolvedValue(false);
    if (condition === "paused") f.stopped.mockResolvedValue(true);
    const host = createConsultationHost({ ...f.options,
      ...(condition === "simulation" ? { simulation: true } : {}),
      ...(condition === "missing_policy" ? { policyJson: "{}" } : {}),
      ...(condition === "expired_policy" ? { policyJson: JSON.stringify({ ...policy, expiresAt: "2020-01-01T00:00:00Z" }) } : {}),
    });
    expect((await host.catalog(user, new AbortController().signal)).available).toBe(false);
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.store.begin).not.toHaveBeenCalled();
  });
  it("recovers a saved operation while the provider is disabled without a new inference", async () => {
    const f = fixture();
    f.store.resume.mockResolvedValue({ operationId: id, state: "cancelled", resourceState: "reconciled",
      cancelRequested: true, result: null, createdAt: "", updatedAt: "" });
    const host = createConsultationHost({ ...f.options, simulation: true, policyJson: "{}" });
    expect((await host.consult(user, input, new AbortController().signal)).status).toBe("cancelled");
    expect(f.loadCatalog).not.toHaveBeenCalled();
    expect(f.store.begin).not.toHaveBeenCalled();
  });
  it("rejects conflicting replay before catalogue access", async () => {
    const f = fixture();
    f.store.resume.mockRejectedValue(Object.assign(new Error("private"), { code: "conflict" }));
    await expect(f.host.consult(user, input, new AbortController().signal)).rejects.toMatchObject({ code: "IAO_CONFLICT" });
    expect(f.loadCatalog).not.toHaveBeenCalled();
    expect(f.decide).not.toHaveBeenCalled();
  });
  it("rejects client authority, unknown models, unsupported reviewer count and absent search account", async () => {
    for (const request of [
      { ...input, userId: user }, { ...input, budget: 1 },
      { ...input, preferences: { model: "not-approved" } },
      { ...input, preferences: { model: "main", speed: "ultra_fast" as const }, reviewerModels: ["peer"] },
      { ...input, research: { queries: ["public query"], urls: [] } },
    ]) {
      const f = fixture();
      await expect(f.host.consult(user, request, new AbortController().signal)).rejects.toMatchObject({ code: "IAO_INVALID" });
      expect(f.store.begin).not.toHaveBeenCalled();
      expect(f.decide).not.toHaveBeenCalled();
    }
  });
  it("never opens a durable operation for a mock inference client", async () => {
    const f = fixture();
    const host = createConsultationHost({ ...f.options, createClient: () => ({ isMock: true, decide: f.decide }) });
    await expect(host.consult(user, input, new AbortController().signal)).rejects.toMatchObject({ code: "IAO_UNAVAILABLE" });
    expect(f.store.begin).not.toHaveBeenCalled();
  });
  it("checks the global stop before every paid sub-call", async () => {
    const f = fixture();
    f.stopped.mockResolvedValueOnce(false).mockResolvedValue(true);
    await f.host.consult(user, input, new AbortController().signal);
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.admission.settle).toHaveBeenCalled();
  });
  it("does not reserve or infer when the policy expires during the per-call stop check", async () => {
    const f = fixture(); const stopCheck = deferred<boolean>();
    let clock = Date.parse(policy.expiresAt) - 1;
    const stopped = vi.fn(async () => false).mockResolvedValueOnce(false).mockImplementationOnce(() => stopCheck.promise);
    const host = createConsultationHost({ ...f.options, now: () => clock, stopped });
    const pending = host.consult(user, input, new AbortController().signal);
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(2));
    expect(f.store.begin).toHaveBeenCalledOnce();
    clock += 1;
    stopCheck.resolve(false);
    const result = await pending;
    expect({ reservations: f.admission.reserve.mock.calls.length, modelCalls: f.decide.mock.calls.length }).toEqual({
      reservations: 0, modelCalls: 0,
    });
    expect(result.result?.status).toBe("failed");
  });
  it("settles a late reservation as blocked without inference when its policy has expired", async () => {
    const f = fixture(); const reservation = deferred<boolean>();
    let clock = Date.parse(policy.expiresAt) - 1;
    f.admission.reserve.mockImplementationOnce(() => reservation.promise);
    const host = createConsultationHost({ ...f.options, now: () => clock });
    const pending = host.consult(user, input, new AbortController().signal);
    await vi.waitFor(() => expect(f.admission.reserve).toHaveBeenCalledOnce());
    clock += 1;
    reservation.resolve(true);
    const result = await pending;
    expect(f.decide).not.toHaveBeenCalled();
    expect(result.result?.status).toBe("failed");
    expect(f.admission.settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "blocked", usage: [] }));
  });
  it("keeps a complete empty catalogue empty during its cache period", async () => {
    const f = fixture(); f.loadCatalog.mockResolvedValue([]);
    expect((await f.host.catalog(user, new AbortController().signal)).reason).toBe("model_unavailable");
    expect((await f.host.catalog(user, new AbortController().signal)).reason).toBe("model_unavailable");
    expect(f.loadCatalog).toHaveBeenCalledTimes(1);
  });
  it("retains a large Unicode result and its links within persistence and wire bounds", async () => {
    const f = fixture(); let retrieval = 0;
    const host = createConsultationHost({ ...f.options,
      policyJson: JSON.stringify({ ...policy, models: policy.models.map(m => ({ ...m, maxInputTokens: 278_528 })), research: { searchMaxCostMicros: 1000 } }),
      searchConfigured: true,
      research: {
        search: async () => {
          const index = retrieval++;
          return { provider: "perplexity", retrievalId: `r${index}`, providerRequestId: null,
            retrievedAt: "2026-11-13T00:00:00Z", verificationStatus: "unverified", independentlyVerified: false,
            costMicros: null, sourceTextTrust: "untrusted_data",
            sources: Array.from({ length: 15 }, (_, i) => ({ sourceId: `r${index}-${i}`,
              url: `https://example.com/${index}-${i}/` + "a".repeat(8000), title: "Titre 🌍".repeat(200),
              text: `Passage ${index}-${i} : ` + "€🌍\"\n".repeat(6_000), contentKind: "search_excerpt" as const })) };
        },
        scrape: async () => { throw new Error("not requested"); },
      },
    });
    const answer = "🌍".repeat(12_000);
    f.decide.mockResolvedValue({ summary: JSON.stringify({ answer, citedSourceIds: ["S1", "S30"], disagreements: [], uncertainties: [] }),
      toolCalls: [], requiresApproval: false, mock: false });
    const result = await host.consult(user, { ...input, research: { queries: ["public one", "public two"], urls: [] } }, new AbortController().signal);
    expect(result.result?.status).toBe("complete");
    expect(result.result?.answer).toBe(answer);
    expect(result.result?.citedSourceIds).toEqual(["S1", "S30"]);
    expect(result.result?.sources).toHaveLength(30);
    expect(result.result?.sources.every(s => s.truncated)).toBe(true);
    expect(result.result?.sources[29].url).toBe("https://example.com/1-14/" + "a".repeat(8000));
    expect(Buffer.byteLength(JSON.stringify({ ok: true, operation: result }), "utf8")).toBeLessThan(524_288);
    const stored = await f.store.status();
    expect(Buffer.byteLength(JSON.stringify(stored), "utf8")).toBeLessThan(2_097_152);
    expect(stored?.result?.receipts).toHaveLength(3);
    expect(stored?.result?.sources.every(s => s.truncated)).toBe(true);
    const excerpts = stored!.result!.sources;
    const supplied = f.decide.mock.calls[0][0].context.sources as Array<{ id: string; text: string }>;
    const encodedBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8");
    expect(excerpts.reduce((total, source) => total + encodedBytes(source.text), 0)).toBeLessThanOrEqual(16_384);
    for (const [index, source] of excerpts.entries()) {
      expect(source.text).toMatch(new RegExp(`^Passage ${Math.floor(index / 15)}-${index % 15} :`));
      expect(supplied[index].id).toBe(source.id);
      expect(supplied[index].text).toContain(source.text);
      expect(encodedBytes(source.text)).toBeLessThanOrEqual(2048);
      expect(encodedBytes(source.title)).toBeLessThanOrEqual(128);
      expect(Buffer.from(source.text).toString()).toBe(source.text);
      expect(result.result!.sources[index].text).toBe(source.text);
    }
    expect(await host.status(user, id, new AbortController().signal)).toEqual(result);
    expect(f.decide).toHaveBeenCalledOnce();
  });
  it("reads historical excerpts without restoring unavailable text or splitting Unicode characters", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await f.host.consult(user, input, signal);
    const original = (await f.store.status())!;
    const legacySource = { id: "S1", sourceId: "old-1", url: "https://example.com/one", provider: "perplexity",
      retrievedAt: "2026-11-13T00:00:00Z", contentKind: "search_excerpt" as const, verificationStatus: "unverified" as const,
      title: "t".repeat(511) + "🌍", text: "x".repeat(1999) + "🌍" };
    f.store.status.mockResolvedValue({ ...original, result: { ...original.result!, citedSourceIds: ["S2"], sources: [
      legacySource, { ...legacySource, id: "S2", sourceId: "old-2", url: "https://example.com/two", title: "Archive", text: "", truncated: true },
    ] } });
    const recovered = (await f.host.status(user, id, signal))!.result!;
    expect(recovered.sources[0]).toMatchObject({ title: "t".repeat(511), text: "x".repeat(1999), truncated: true });
    expect(recovered.sources[1]).toMatchObject({ id: "S2", text: "", truncated: true, verificationStatus: "unverified" });
    expect(recovered.citedSourceIds).toEqual(["S2"]);
    expect(recovered.verificationStatus).toBe("unverified");
    expect(f.decide).toHaveBeenCalledOnce();
  });
});
