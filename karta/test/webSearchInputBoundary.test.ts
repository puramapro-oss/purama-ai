import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../src/engine/types.js";

vi.mock("../src/config.js", () => ({ config: { tavilyApiKey: "test-only-input-boundary" } }));
const { webSearchTool } = await import("../src/tools/websearch.js");
const ctx: ToolExecutionContext = { userId: "input-user", agentType: "legal", mode: "live" };
const transport = vi.fn<typeof fetch>();
type Params = Parameters<typeof webSearchTool.execute>[0];

beforeEach(() => {
  transport.mockReset();
  transport.mockImplementation(async () => Response.json({ results: [] }));
  vi.stubGlobal("fetch", transport);
});
afterEach(() => vi.unstubAllGlobals());

describe("direct JavaScript input boundary of web_search", () => {
  it.each(["constructor", "toString"])("rejects an unrecognized own %s key even when undefined", async key => {
    const params = { query: "public query", [key]: undefined };
    await expect(webSearchTool.execute(params, ctx)).rejects.toThrow("Paramètres de recherche invalides.");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a required query inherited through a prototype before calling Tavily", async () => {
    const params = Object.create({ query: "x".repeat(2001) }) as Params;
    await expect(webSearchTool.execute(params, ctx)).rejects.toThrow("Paramètres de recherche invalides.");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects unvalidated optional filters inherited through a prototype", async () => {
    const params = Object.assign(Object.create({ time_range: "INVALID_RANGE" }), { query: "public query" }) as Params;
    await expect(webSearchTool.execute(params, ctx)).rejects.toThrow("Paramètres de recherche invalides.");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a sparse domain array instead of emitting null to the provider", async () => {
    await expect(webSearchTool.execute({ query: "public query", include_domains: new Array(1) }, ctx))
      .rejects.toThrow("Paramètres de recherche invalides.");
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not execute an accessor before taking a validated snapshot", async () => {
    const getter = vi.fn(() => "public query");
    const params = Object.defineProperty({}, "query", { enumerable: true, get: getter }) as Params;
    await expect(webSearchTool.execute(params, ctx)).rejects.toThrow("Paramètres de recherche invalides.");
    expect(getter).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects fields that are invisible to normal JSON enumeration", async () => {
    const params = Object.defineProperty({}, "query", { value: "public query", enumerable: false }) as Params;
    await expect(webSearchTool.execute(params, ctx)).rejects.toThrow("Paramètres de recherche invalides.");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects symbol keys instead of silently treating them as approved input", async () => {
    const params = { query: "public query", [Symbol("unrecognized")]: "private value" };
    await expect(webSearchTool.execute(params, ctx)).rejects.toThrow("Paramètres de recherche invalides.");
    expect(transport).not.toHaveBeenCalled();
  });

  it("accepts a null-prototype object with own supported fields", async () => {
    const params = Object.assign(Object.create(null), { query: "public query" }) as Params;
    await expect(webSearchTool.execute(params, ctx)).resolves.toEqual({ results: [] });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("accepts frozen plain input without mutating it", async () => {
    const params = Object.freeze({ query: "public query", language: "FR" });
    await expect(webSearchTool.execute(params, ctx)).resolves.toEqual({ results: [] });
    expect(params.language).toBe("FR");
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).language).toBe("fr");
  });
});
