import { describe, expect, it, vi } from "vitest";
import { normalizeModelUsage, normalizeProgrammaticUsage, programmaticUsageEnvelope } from "../src/claude/usage.js";

const receipt = (id = "msg_one") => normalizeModelUsage({ id, model: "qualified-model", usage: {
  input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0,
} }, "qualified-model", "https://api.anthropic.com");

describe("per-response programmatic usage without synthetic billing", () => {
  it("keeps ordered individual response IDs, counters and server execution counts", () => {
    const a = receipt(), b = receipt("msg_two");
    const result = programmaticUsageEnvelope([{ receipt: a, codeExecutionRequests: 1 }, { receipt: b, codeExecutionRequests: 0 }]);
    expect(result).toEqual({ version: 2, apiFormat: "anthropic_messages", routeKind: "anthropic", responses: [
      { receipt: a, codeExecutionRequests: 1 }, { receipt: b, codeExecutionRequests: 0 },
    ] });
    expect(result).not.toHaveProperty("inputTokens");
    expect(result.responses[0].receipt.cacheCreationInputTokens).toBeNull();
  });
  it("snapshots and freezes the entire chain before the journal can await", () => {
    const entry = { receipt: { ...receipt() }, codeExecutionRequests: 1 };
    const entries = [entry];
    const result = programmaticUsageEnvelope(entries);
    entry.receipt.inputTokens = 999; entry.codeExecutionRequests = 999; entries.push(entry);
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]).toMatchObject({ codeExecutionRequests: 1, receipt: { inputTokens: 100 } });
    expect(Object.isFrozen(result.responses[0].receipt)).toBe(true);
    expect(Object.isFrozen(result.responses)).toBe(true);
  });
  it.each([undefined, null, -1, 0.25, "1", Number.MAX_SAFE_INTEGER + 1])("preserves unknown code counters as null: %j", value => {
    expect(normalizeProgrammaticUsage({ usage: { server_tool_use: { code_execution_requests: value } } })).toEqual({ codeExecutionRequests: null });
  });
  it.each([0, 1, 8])("preserves a reported server-code count of %s", value => {
    expect(normalizeProgrammaticUsage({ usage: { server_tool_use: { code_execution_requests: value } } })).toEqual({ codeExecutionRequests: value });
  });
  it("never reads provider content or accessor counters", () => {
    const get = vi.fn(() => { throw new Error("private"); });
    const response = Object.defineProperty({ content: "PRIVATE" }, "usage", { get });
    expect(normalizeProgrammaticUsage(response)).toEqual({ codeExecutionRequests: null });
    expect(get).not.toHaveBeenCalled();
  });
  it("rejects empty, excessive or non-native chains", () => {
    expect(() => programmaticUsageEnvelope([])).toThrow();
    expect(() => programmaticUsageEnvelope(Array.from({ length: 9 }, () => ({ receipt: receipt(), codeExecutionRequests: 0 })))).toThrow();
    expect(() => programmaticUsageEnvelope([{ receipt: { ...receipt(), routeKind: "compatible" }, codeExecutionRequests: 0 }])).toThrow();
  });
  it("drops unrelated private fields without incorporating them in the receipt", () => {
    const item = { receipt: { ...receipt(), prompt: "PRIVATE" }, codeExecutionRequests: null, stdout: "PRIVATE" };
    expect(JSON.stringify(programmaticUsageEnvelope([item]))).not.toContain("PRIVATE");
  });
  it("rejects sparse, accessor and method-overridden chains without invoking input code", () => {
    const entry = { receipt: receipt(), codeExecutionRequests: 1 };
    const getter = vi.fn(() => entry);
    const map = vi.fn(() => Array.from({ length: 9 }, () => entry));
    const accessor = Object.defineProperty([entry], "0", { enumerable: true, get: getter });
    const overridden = Object.assign([entry], { map });
    for (const values of [new Array(1), accessor, overridden]) {
      expect(() => programmaticUsageEnvelope(values)).toThrow("Journal de consommation programmatique invalide");
    }
    expect(getter).not.toHaveBeenCalled(); expect(map).not.toHaveBeenCalled();
  });
  it("rejects proxy chains, entries and receipts without invoking their traps", () => {
    const trap = vi.fn(() => { throw new Error("PRIVATE_PROXY_TRAP"); });
    const entry = { receipt: receipt(), codeExecutionRequests: 1 };
    const handler = { getOwnPropertyDescriptor: trap, getPrototypeOf: trap, ownKeys: trap, get: trap };
    for (const values of [new Proxy([entry], handler), [new Proxy(entry, handler)],
      [{ ...entry, receipt: new Proxy(entry.receipt, handler) }]]) {
      expect(() => programmaticUsageEnvelope(values)).toThrow("Journal de consommation programmatique invalide");
    }
    expect(trap).not.toHaveBeenCalled();
  });
});
