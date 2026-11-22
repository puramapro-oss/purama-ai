import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IaoContextPack } from "../src/iao/kartaRuntimePort.js";
import { buildMemoryPrompt, LocalComputeFabricProvider } from "../src/integrations/localComputeFabricProvider.js";

const denied = "memory-denied:compute-fabric-input";
const source = () => ({ text: "memory-marker", authorized: true, sensitivity: "normal", relevance: 1 });
const prompt = (context: unknown) => buildMemoryPrompt(context as IaoContextPack, "question");
afterEach(() => vi.restoreAllMocks());

describe("local compute fabric memory data boundary", () => {
  it.each(["false", "0", 1, [], {}, null, undefined].map((value) => [value]))("rejects a non-boolean authorization (%j)", (authorized) => {
    expect(() => prompt({ sources: [{ ...source(), authorized }] })).toThrow(denied);
  });

  it.each([
    { text: 7 }, { text: null }, { relevance: "1" }, { relevance: NaN },
    { relevance: Infinity }, { sensitivity: "public" }, { sensitivity: null },
  ])("rejects malformed source data (%j)", (override) => {
    expect(() => prompt({ sources: [{ ...source(), ...override }] })).toThrow(denied);
  });

  it.each([null, undefined, [], {}, { sources: null }, { sources: {} }, { sources: [null] }].map((value) => [value]))(
    "rejects malformed context structure (%j)", (context) => {
      expect(() => prompt(context)).toThrow(denied);
    },
  );

  it.each(["text", "authorized", "sensitivity", "relevance"])("requires an own %s field", (key) => {
    const value: Record<string, unknown> = source();
    delete value[key];
    expect(() => prompt({ sources: [value] })).toThrow(denied);
  });

  it("rejects inherited authorization and custom prototypes", () => {
    const inherited = Object.assign(Object.create({ authorized: true, sensitivity: "normal", relevance: 1 }), { text: "memory-marker" });
    expect(() => prompt({ sources: [inherited] })).toThrow(denied);
    expect(() => prompt(Object.create({ sources: [source()] }))).toThrow(denied);
  });

  it.each(["text", "authorized", "sensitivity", "relevance"])("rejects an active %s field without executing it", (key) => {
    const getter = vi.fn(() => { throw new Error("private-getter-content"); });
    const value = source();
    Object.defineProperty(value, key, { get: getter });
    expect(() => prompt({ sources: [value] })).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects context and array accessors without invoking them", () => {
    const getter = vi.fn(() => [source()]);
    expect(() => prompt(Object.defineProperty({}, "sources", { get: getter }))).toThrow(denied);
    const sources = [source()];
    Object.defineProperty(sources, "0", { get: getter });
    expect(() => prompt({ sources })).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not execute a custom array iterator", () => {
    const iterator = vi.fn(function* () { yield source(); });
    const sources: unknown[] = [];
    Object.defineProperty(sources, Symbol.iterator, { value: iterator });
    expect(() => prompt({ sources })).toThrow(denied);
    expect(iterator).not.toHaveBeenCalled();
  });

  it("rejects sparse arrays and array subclasses", () => {
    expect(() => prompt({ sources: new Array(1) })).toThrow(denied);
    class ActiveSources extends Array<ReturnType<typeof source>> {}
    expect(() => prompt({ sources: new ActiveSources(source()) })).toThrow(denied);
  });

  it.each(["context", "array", "source"])("rejects a %s proxy without calling traps", (level) => {
    const trap = vi.fn(() => { throw new Error("private-proxy-content"); });
    const handler = { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap };
    const context = level === "context" ? new Proxy({ sources: [source()] }, handler)
      : { sources: level === "array" ? new Proxy([source()], handler) : [new Proxy(source(), handler)] };
    expect(() => prompt(context)).toThrow(denied);
    expect(trap).not.toHaveBeenCalled();
  });

  it("rejects a revoked proxy with the generic error", () => {
    const { proxy, revoke } = Proxy.revocable(source(), {});
    revoke();
    expect(() => prompt({ sources: [proxy] })).toThrow(denied);
  });

  it("validates the whole pack before transport, including a late malformed source", async () => {
    const request = vi.spyOn(http, "request").mockImplementation(() => { throw new Error("transport-must-not-run"); });
    const provider = new LocalComputeFabricProvider({ socketPath: "/tmp/must-not-connect.sock", maxContextChars: 1_000 });
    await expect(provider.complete({
      requestId: "boundary", idempotencyKey: `iao:${"a".repeat(64)}`, payloadDigest: "b".repeat(64), message: "question",
      context: { sources: [{ ...source(), text: "x".repeat(1_000) }, { ...source(), authorized: "false" }] } as unknown as IaoContextPack,
    })).rejects.toThrow(denied);
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves authorized ordering, filtering, truncation and the input objects", () => {
    const sources = Object.freeze([
      Object.freeze({ ...source(), text: "second", relevance: 1 }),
      Object.freeze({ ...source(), text: "first", relevance: 10 }),
      Object.freeze({ ...source(), text: "private-health", sensitivity: "health", relevance: 100 }),
      Object.freeze({ ...source(), text: "private-personal", sensitivity: "personal", relevance: 100 }),
      Object.freeze({ ...source(), text: "private-finance", sensitivity: "finance", relevance: 100 }),
      Object.freeze({ ...source(), text: "not-authorized", authorized: false, relevance: 100 }),
    ]);
    const result = buildMemoryPrompt({ sources } as IaoContextPack, "question", 8);
    expect(result).toContain('["first","sec"]');
    expect(result).not.toContain("private-");
    expect(result).not.toContain("not-authorized");
    expect(sources[0].text).toBe("second");
  });

  it("accepts passive records with a null prototype and ignores unused metadata", () => {
    const value = Object.assign(Object.create(null), source(), { extra: "not-in-prompt" });
    const context = Object.assign(Object.create(null), { sources: [value] });
    expect(prompt(context)).toContain("memory-marker");
    expect(prompt(context)).not.toContain("not-in-prompt");
  });
});
