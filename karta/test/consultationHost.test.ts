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
describe("real consultation host composition", () => {
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
              text: "€".repeat(30_000), contentKind: "search_excerpt" as const })) };
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
  });
});
