import { describe, expect, it, vi } from "vitest";
import { canonicalApprovalParams } from "../src/engine/approval-params.js";

describe("strict approval parameter comparison", () => {
  it("ignores object key order while preserving nested values and array order", () => {
    const params = { b: { y: 2, x: 1 }, a: [3, 1] };
    expect(canonicalApprovalParams(params)).toBe('{"a":[3,1],"b":{"x":1,"y":2}}');
    expect(canonicalApprovalParams(params)).toBe(canonicalApprovalParams({ a: [3, 1], b: { x: 1, y: 2 } }));
    expect(canonicalApprovalParams(params)).not.toBe(canonicalApprovalParams({ a: [1, 3], b: { x: 1, y: 2 } }));
  });

  it("allows plain null-prototype records without changing special property names", () => {
    const params = Object.create(null) as Record<string, unknown>;
    params.__proto__ = { value: 7 };
    Object.defineProperty(params, "constructor", { value: "data", enumerable: true });
    expect(canonicalApprovalParams(params)).toBe('{"__proto__":{"value":7},"constructor":"data"}');
  });

  it("accepts repeated references but rejects actual cycles", () => {
    const shared = { value: 7 };
    expect(canonicalApprovalParams({ one: shared, two: shared })).toBe('{"one":{"value":7},"two":{"value":7}}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalApprovalParams(cyclic)).toThrow();
  });

  it.each([
    { name: "ASCII", value: "x".repeat(65_529) },
    { name: "UTF-8", value: "é".repeat(32_764) + "x" },
    { name: "surrogate pairs", value: "😀".repeat(16_382) + "x" },
    { name: "escaped quotes", value: '"'.repeat(32_764) + "x" },
    { name: "escaped newlines", value: "\n".repeat(32_764) + "x" },
  ])("counts the complete 64 KiB boundary for $name", ({ value }) => {
    const params = { "": value };
    expect(Buffer.byteLength(JSON.stringify(params), "utf8")).toBe(65_536);
    expect(canonicalApprovalParams(params)).toBe(JSON.stringify(params));
    expect(() => canonicalApprovalParams({ "": value + "x" })).toThrow();
  });

  it("charges object keys, separators and delimiters within the byte budget", () => {
    const keyed = { ["k".repeat(65_530)]: 0 };
    const separated = { a: "", b: "x".repeat(65_521) };
    for (const params of [keyed, separated]) {
      expect(Buffer.byteLength(JSON.stringify(params))).toBe(65_536);
      expect(canonicalApprovalParams(params)).toBe(JSON.stringify(params));
    }
    expect(() => canonicalApprovalParams({ ["k".repeat(65_531)]: 0 })).toThrow();
    expect(() => canonicalApprovalParams({ a: "", b: "x".repeat(65_522) })).toThrow();
  });

  it("counts the root at depth zero and rejects a seventeenth level", () => {
    let params: Record<string, unknown> = {};
    for (let depth = 0; depth < 16; depth++) params = { nested: params };
    expect(canonicalApprovalParams(params)).toBe(JSON.stringify(params));
    expect(() => canonicalApprovalParams({ nested: params })).toThrow();
  });

  it("includes containers and scalar values in the 4096-node budget", () => {
    const array = { values: Array.from({ length: 4_094 }, () => null) };
    const object = Object.fromEntries(Array.from({ length: 4_095 }, (_, index) => [String(index), null]));
    expect(canonicalApprovalParams(array)).toBe(JSON.stringify(array));
    expect(JSON.parse(canonicalApprovalParams(object))).toEqual(object);
    expect(() => canonicalApprovalParams({ values: [...array.values, null] })).toThrow();
    expect(() => canonicalApprovalParams({ ...object, extra: null })).toThrow();
  });

  it.each([
    { name: "excessive property count", value: () => Object.fromEntries(Array.from({ length: 4_096 }, (_, index) => [String(index), null])) },
    { name: "excessive key text", value: () => ({ ["x".repeat(32_769) + "a"]: 0, ["x".repeat(32_769) + "b"]: 0 }) },
  ])("rejects $name before sorting", ({ value }) => {
    const params = value();
    const sort = vi.spyOn(Array.prototype, "sort");
    let error: unknown;
    let calls = 0;
    try {
      try { canonicalApprovalParams(params); } catch (caught) { error = caught; }
      calls = sort.mock.calls.length;
    } finally { sort.mockRestore(); }
    expect(error).toBeInstanceOf(Error);
    expect(calls).toBe(0);
  });

  it("rejects object and array accessors without invoking them", () => {
    const getter = vi.fn(() => "PRIVATE_GETTER_VALUE");
    const object = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    const array = Object.defineProperty([1], "0", { enumerable: true, get: getter });
    expect(() => canonicalApprovalParams(object)).toThrow();
    expect(() => canonicalApprovalParams({ array })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects toJSON instead of invoking a different serialization contract", () => {
    const toJSON = vi.fn(() => ({ approved: true }));
    expect(() => canonicalApprovalParams({ amount: 500, toJSON })).toThrow();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it.each([
    { name: "undefined", value: () => ({ value: undefined }) },
    { name: "NaN", value: () => ({ value: NaN }) },
    { name: "infinity", value: () => ({ value: Infinity }) },
    { name: "bigint", value: () => ({ value: 1n }) },
    { name: "symbol value", value: () => ({ value: Symbol("private") }) },
    { name: "function value", value: () => ({ value: () => 1 }) },
    { name: "date normalization", value: () => ({ value: new Date("2026-11-10T00:00:00Z") }) },
    { name: "class instance", value: () => ({ value: new class { amount = 1; }() }) },
    { name: "symbol key", value: () => ({ [Symbol("private")]: 1 }) },
    { name: "non-enumerable key", value: () => Object.defineProperty({}, "hidden", { value: 1 }) },
    { name: "sparse array", value: () => ({ value: Array(2) }) },
    { name: "extra array property", value: () => ({ value: Object.assign([1], { extra: 2 }) }) },
    { name: "non-object root", value: () => "text" },
    { name: "array root", value: () => [1] },
  ])("refuses $name without silently normalizing it", ({ value }) => {
    expect(() => canonicalApprovalParams(value())).toThrow();
  });
});
