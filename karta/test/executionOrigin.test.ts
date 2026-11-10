import { describe, expect, it, vi } from "vitest";
import type { AgentTrigger } from "../src/engine/types.js";
import { ExecutionOriginError, MAX_DELEGATION_REASON_LENGTH, snapshotAgentExecutionTrigger, restoreAgentExecutionTrigger } from "../src/engine/execution-origin.js";

// Derived from PR21's pure origin cases. Approval admission and action equality
// remain covered by the existing single approval-continuation implementation.
const agent = "legal";
const marker = "PRIVATE_ORIGIN_TEST";
const delegated = (): AgentTrigger => ({ type: "delegation", source: "partner", payload: {
  reason: marker, kartaDelegation: { depth: 1, lineage: ["partner", "legal"] },
} });

describe("minimal server-owned execution origin", () => {
  it.each(["manual", "cron", "webhook"] as const)("keeps a %s source and excludes arbitrary payload", type => {
    const source = "Legal Agent — Veille Juridique";
    expect(snapshotAgentExecutionTrigger({ type, source, payload: { slot: marker, authorized: true } }, agent))
      .toEqual({ type, source });
  });

  it("copies only bounded delegation fields and detaches both copies from their input", () => {
    const input = delegated(); input.payload!.secret = "NEVER_PERSIST";
    const copy = snapshotAgentExecutionTrigger(input, agent)!;
    const restored = restoreAgentExecutionTrigger(copy, agent)!;
    expect(copy).toEqual(delegated()); expect(restored).toEqual(delegated());
    (input.payload!.kartaDelegation as { lineage: string[] }).lineage[0] = "email";
    copy.payload!.reason = "MUTATED";
    (copy.payload!.kartaDelegation as { lineage: string[] }).lineage[0] = "compta";
    expect(restored).toEqual(delegated());
  });

  it.each([null, undefined])("keeps historical unknown origin unknown (%s)", value => {
    expect(restoreAgentExecutionTrigger(value, agent)).toBeUndefined();
    if (value === undefined) expect(snapshotAgentExecutionTrigger(value, agent)).toBeUndefined();
  });

  it("retains a legacy delegated reason without inventing a lineage", () => {
    const input: AgentTrigger = { type: "delegation", source: "partner", payload: { reason: marker } };
    expect(restoreAgentExecutionTrigger(snapshotAgentExecutionTrigger(input, agent), agent)).toEqual(input);
  });

  it.each(["", "   ", "x".repeat(MAX_DELEGATION_REASON_LENGTH + 1), "contains\0null"])("rejects invalid delegated reason %j", reason => {
    expect(() => snapshotAgentExecutionTrigger({ type: "delegation", source: "partner", payload: { reason } }, agent))
      .toThrow(ExecutionOriginError);
  });

  it.each(["", "x".repeat(201), "partner\nBearer", " partner"])("rejects invalid delegated source %j", source => {
    expect(() => snapshotAgentExecutionTrigger({ type: "delegation", source, payload: { reason: marker } }, agent))
      .toThrow(ExecutionOriginError);
  });

  it("does not execute accessors during validation or expose their private failures", () => {
    const getter = vi.fn(() => { throw new Error(marker); });
    const payload = Object.defineProperty({}, "reason", { enumerable: true, get: getter });
    let caught: unknown;
    try { snapshotAgentExecutionTrigger({ type: "delegation", source: "partner", payload }, agent); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ExecutionOriginError);
    expect(String(caught)).not.toContain(marker); expect(getter).not.toHaveBeenCalled();
  });

  it.each(["wrapper", "payload", "unknown_type", "wrong_source", "wrong_target", "cycle", "depth", "extra", "secret", "oversized_source", "prototype", "sparse_lineage", "extra_lineage"])("refuses malformed persisted origin: %s", kind => {
    let value: unknown = delegated();
    if (kind === "wrapper") value = { type: "delegation", source: "approval-resume", payload: { previousRunId: "old", reason: marker } };
    if (kind === "payload") value = { type: "manual", source: "api", payload: { authorized: true } };
    if (kind === "unknown_type") value = { type: "unknown", source: "api" };
    if (kind === "wrong_source") value = { ...delegated(), source: "compta" };
    if (kind === "wrong_target") (value as AgentTrigger).payload!.kartaDelegation = { depth: 1, lineage: ["partner", "compta"] };
    if (kind === "cycle") (value as AgentTrigger).payload!.kartaDelegation = { depth: 2, lineage: ["legal", "partner", "legal"] };
    if (kind === "depth") (value as AgentTrigger).payload!.kartaDelegation = { depth: 0, lineage: ["legal"] };
    if (kind === "extra") value = { ...delegated(), authorized: true };
    if (kind === "secret") (value as AgentTrigger).payload!.refresh_token = marker;
    if (kind === "oversized_source") value = { type: "manual", source: "x".repeat(201) };
    if (kind === "prototype") value = new Date();
    if (kind === "sparse_lineage") (value as AgentTrigger).payload!.kartaDelegation = { depth: 1, lineage: new Array(2) };
    if (kind === "extra_lineage") (value as AgentTrigger).payload!.kartaDelegation = { depth: 1, lineage: Object.assign(["partner", "legal"], { permission: true }) };
    expect(() => restoreAgentExecutionTrigger(value, agent)).toThrow(ExecutionOriginError);
  });
});
