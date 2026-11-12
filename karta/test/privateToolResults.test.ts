import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simulateQuantumCircuit } from "../src/quantum/simulator.js";
import { persistPrivateToolResult, projectPrivateToolResult, PRIVATE_TOOL_RESULT_MAX_BYTES } from "../src/engine/private-tool-results.js";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc } }));
const owner = "00000000-0000-4000-8000-000000000401";
const agent = "00000000-0000-4000-8000-000000000402";
const runId = "00000000-0000-4000-8000-000000000403";
const resultId = "00000000-0000-4000-8000-000000000404";
const stamp = "2026-11-12T12:00:00.000Z";
const sentinel = "PRIVATE_METADATA_SENTINEL";
const invalid = "Résultat privé indisponible : format ou identité non vérifiable.";
const reply = (value: unknown) => ({ abortSignal: vi.fn().mockResolvedValue(value) });
const quantum = () => ({ ...simulateQuantumCircuit({ qubits: 2, gates: [{ gate: "H", target: 0 }, { gate: "CX", control: 0, target: 1 }], shots: 100, seed: 7 }), karta_execution_mode: "live" });
const knowledge = () => ({
  ok: true, status: "complete", message: "Tool message is not retained", private_query: "QUERY_NOT_RETAINED",
  evidence: { schema_version: 1, retrieval_id: resultId, scope: "selected_public_sources", content_kind: "metadata_only",
    verification_status: "unverified", source_text_trust: "untrusted_data", page_read_by_karta: false, full_text_retrieved: false,
    requested_language: "fr", selected_sources: ["crossref", "wikidata"], sources: [
      { source: "crossref", status: "ok", result_count: 1, duplicate_results_removed: 0, retrieved_at: stamp },
      { source: "wikidata", status: "ok", result_count: 1, duplicate_results_removed: 0, retrieved_at: stamp },
    ] },
  results: [
    { source: "crossref", native_id: "10.1234/example", canonical_id: "doi:10.1234/example", url: "https://doi.org/10.1234/example",
      title: sentinel, text: "Notice bibliographique", language: "fr", provider_published_date: "2026-11-12", retrieved_at: stamp,
      metadata_license: null, content_license: null, provider_ranks: [1] },
    { source: "wikidata", native_id: "Q42", canonical_id: "wikidata:Q42", url: "https://www.wikidata.org/wiki/Q42",
      title: "Notice publique", text: "Description de la notice", language: "fr", provider_published_date: null, retrieved_at: stamp,
      metadata_license: "CC0-1.0", content_license: null, provider_ranks: [1] },
  ],
});
const input = () => ({ userId: owner, agentType: `custom:${agent}`, runId, operationId: `${runId}:0`, toolName: "knowledge_search", result: knowledge() });

beforeEach(() => { rpc.mockReset(); rpc.mockImplementation(() => reply({ data: resultId, error: null })); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("private result projection", () => {
  it("retains bounded provenance and citations without arbitrary tool fields or claims of verified content", () => {
    const projected = projectPrivateToolResult("knowledge_search", knowledge())!;
    expect(projected).toMatchObject({ schema_version: 1, tool_name: "knowledge_search", status: "complete", sources: [
      { source: "crossref", native_id: "10.1234/example", label: sentinel, url: "https://doi.org/10.1234/example" },
      { source: "wikidata", native_id: "Q42", url: "https://www.wikidata.org/wiki/Q42" },
    ], details: { verification_status: "unverified", page_read_by_karta: false, full_text_retrieved: false, metadata_truncated: false } });
    expect(projected.summary).toContain("Métadonnées non vérifiées");
    expect(JSON.stringify(projected)).not.toMatch(/QUERY_NOT_RETAINED|Tool message is not retained|private_query/);
  });

  it.each([true, false])("preserves partial status when the answering provider has records=%s", hasRecords => {
    const raw = knowledge(); raw.ok = false; raw.status = "partial";
    raw.results = hasRecords ? raw.results.slice(0, 1) : [];
    raw.evidence.sources[0] = { ...raw.evidence.sources[0], status: hasRecords ? "ok" : "empty", result_count: hasRecords ? 1 : 0 };
    raw.evidence.sources[1] = { ...raw.evidence.sources[1], status: "timeout", result_count: 0, retrieved_at: null as unknown as string };
    const projected = projectPrivateToolResult("knowledge_search", raw)!;
    expect(projected.status).toBe("partial"); expect(projected.summary).toContain("partielle");
    expect(projected.sources).toHaveLength(hasRecords ? 1 : 0);
  });

  it("abbreviates long astral Unicode metadata without exceeding browser limits", () => {
    const raw = knowledge(); raw.results[0].title = "🌍".repeat(500); raw.results[0].text = "🌍".repeat(700);
    const result = projectPrivateToolResult("knowledge_search", raw)!;
    expect(result.sources[0].label.length).toBeLessThanOrEqual(256);
    expect((result.details.records as { excerpt: string }[])[0].excerpt.length).toBeLessThanOrEqual(512);
    expect(result.details.metadata_truncated).toBe(true);
    expect(result.sources[0].label).toMatch(/…$/u);
  });

  it("projects the real local simulator with explicit no-QPU provenance and exact Bell probabilities", () => {
    const projected = projectPrivateToolResult("quantum_simulate", quantum())!;
    expect(projected).toMatchObject({ status: "complete", sources: [], details: {
      execution_kind: "local_simulator", physical_quantum_hardware: false, quantum_advantage_demonstrated: false,
      probabilities: [0.5, 0, 0, 0.5], counts: { "00": expect.any(Number), "11": expect.any(Number) },
    } });
    expect(projected.summary).toContain("Aucun QPU ni avantage quantique démontré");
  });

  it("keeps a maximum-sized valid circuit inside the JSONB storage budget", () => {
    const raw = { ...simulateQuantumCircuit({ qubits: 10, gates: Array.from({ length: 10 }, (_, target) => ({ gate: "H" as const, target })), shots: 8192, seed: 9 }), karta_execution_mode: "live" };
    const projected = projectPrivateToolResult("quantum_simulate", raw)!;
    expect((projected.details.probabilities as number[])).toHaveLength(1024);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(PRIVATE_TOOL_RESULT_MAX_BYTES - 4096);
    expect(projected.summary).toContain("16 états affichés");
  });

  it.each(["url", "false_success", "verification", "qpu", "probabilities", "counts", "huge", "cycle", "accessor", "proxy"])(
    "fails closed with a fixed error for %s", failure => {
      let raw: unknown = knowledge(); const accessor = vi.fn(() => sentinel);
      if (failure === "url") (raw as ReturnType<typeof knowledge>).results[0].url = "https://attacker.invalid/";
      if (failure === "false_success") (raw as ReturnType<typeof knowledge>).evidence.sources[0].status = "timeout";
      if (failure === "verification") (raw as ReturnType<typeof knowledge>).evidence.verification_status = "verified";
      if (failure === "qpu") raw = { ...quantum(), physical_quantum_hardware: true };
      if (failure === "probabilities") raw = { ...quantum(), probabilities: [0.2, 0, 0, 0.5] };
      if (failure === "counts") raw = { ...quantum(), counts: { "00": 1 } };
      if (failure === "huge") raw = { ...knowledge(), message: sentinel.repeat(10_000) };
      if (failure === "cycle") (raw as Record<string, unknown>).self = raw;
      if (failure === "accessor") Object.defineProperty(raw, "message", { enumerable: true, get: accessor });
      if (failure === "proxy") raw = new Proxy(raw as object, { ownKeys: accessor as never });
      expect(() => projectPrivateToolResult(["qpu", "probabilities", "counts"].includes(failure) ? "quantum_simulate" : "knowledge_search", raw)).toThrow(invalid);
      expect(accessor).not.toHaveBeenCalled();
    },
  );

  it("ignores unrelated tools and deliberate non-execution", () => {
    expect(projectPrivateToolResult("send_email", new Proxy({}, { ownKeys: () => { throw Error("must not inspect"); } }))).toBeNull();
    expect(projectPrivateToolResult("knowledge_search", { status: "not_executed" })).toBeNull();
    expect(projectPrivateToolResult("quantum_simulate", { karta_execution_mode: "simulation" })).toBeNull();
  });
});

describe("private result durable delivery", () => {
  it("writes only the projected snapshot with expected owner and agent assertions", async () => {
    const raw = input(); const saved = persistPrivateToolResult(raw);
    raw.result.results[0].title = "MUTATED_AFTER_CALL";
    expect(await saved).toEqual({ status: "stored", id: resultId });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("karta_store_tool_result", {
      p_user_id: owner, p_agent_type: `custom:${agent}`, p_run_id: runId,
      p_operation_id: `${runId}:0`, p_tool_name: "knowledge_search", p_payload: expect.objectContaining({ sources: expect.arrayContaining([expect.objectContaining({ label: sentinel })]) }),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("MUTATED_AFTER_CALL");
  });

  it("reconciles a lost acknowledgement with the identical operation and snapshot", async () => {
    rpc.mockImplementationOnce(() => ({ abortSignal: vi.fn().mockRejectedValue(new Error(sentinel)) }));
    expect(await persistPrivateToolResult(input())).toEqual({ status: "stored", id: resultId });
    expect(rpc).toHaveBeenCalledTimes(2); expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });

  it.each(["P0001", "42501", "42883"])("does not retry confirmed refusal %s or leak its private details", async code => {
    rpc.mockReturnValue(reply({ data: null, error: { code, message: sentinel, details: sentinel } }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await persistPrivateToolResult(input())).toEqual({ status: "unavailable" });
    expect(rpc).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled();
  });

  it("refuses a malformed success response after at most two attempts", async () => {
    rpc.mockReturnValue(reply({ data: { id: resultId, payload: sentinel }, error: null }));
    expect(await persistPrivateToolResult(input())).toEqual({ status: "unavailable" }); expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("bounds a transport that ignores cancellation and returns no content", async () => {
    vi.useFakeTimers(); let transportSignal: AbortSignal | undefined;
    rpc.mockReturnValue({ abortSignal: (signal: AbortSignal) => { transportSignal = signal; return new Promise(() => undefined); } });
    const result = persistPrivateToolResult(input());
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toEqual({ status: "unavailable" }); expect(transportSignal?.aborted).toBe(true);
  });

  it.each(["unrelated", "static", "simulation", "not_executed"])("does not write %s outputs", async kind => {
    const raw = input();
    if (kind === "unrelated") raw.toolName = "send_email";
    if (kind === "static") raw.agentType = "newsletter-genie";
    if (kind === "not_executed") raw.result.status = "not_executed";
    const result = kind === "simulation" ? await persistPrivateToolResult({ ...raw, toolName: "quantum_simulate", result: { karta_execution_mode: "simulation" } }) : await persistPrivateToolResult(raw);
    expect(result).toEqual({ status: "not_applicable" }); expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["owner", "agent", "run", "operation"])("fails before RPC for malformed %s identity", async field => {
    const raw = input();
    if (field === "owner") raw.userId = "invalid";
    if (field === "agent") raw.agentType = "custom:invalid";
    if (field === "run") raw.runId = "invalid";
    if (field === "operation") raw.operationId = "another-operation";
    expect(await persistPrivateToolResult(raw)).toEqual({ status: "unavailable" }); expect(rpc).not.toHaveBeenCalled();
  });
});
