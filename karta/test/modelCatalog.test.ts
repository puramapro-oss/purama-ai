import { describe, expect, it, vi } from "vitest";
import { loadAnthropicModelCatalog } from "../src/claude/model-catalog.js";

const yes = { supported: true }, no = { supported: false };
const allowed = [{ model: "model-large", maxOutputTokens: 16_384 }];
const model = (patch = {}) => ({ id: "model-large", lifecycle: "active", max_tokens: 128_000,
  capabilities: { thinking: { supported: true, types: { adaptive: yes, enabled: no, disabled: no } },
    effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: no, max: no } }, ...patch });
const response = (data: unknown) => Response.json({ data, has_more: false });
describe("current account model discovery", () => {
  it("uses the official origin once and intersects host ceilings with provider capabilities", async () => {
    const transport = vi.fn(async () => response([model(), model({ id: "unapproved" })]));
    const result = await loadAnthropicModelCatalog({ apiKey: "test-key", allowed, fetch: transport });
    expect(result).toEqual([{ model: "model-large", reasoning: "adaptive", maxOutputTokens: 16_384,
      effortLevels: ["low", "medium", "high"] }]);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ "x-api-key": "test-key", "anthropic-version": "2023-06-01" });
  });
  it.each(["retired", "deprecated"])("does not offer a %s model as newly available", async lifecycle => {
    expect(await loadAnthropicModelCatalog({ apiKey: "test-key", allowed, fetch: async () => response([model({ lifecycle })]) })).toEqual([]);
  });
  it("does not invent thinking support from a name or incomplete metadata", async () => {
    expect(await loadAnthropicModelCatalog({ apiKey: "test-key", allowed, fetch: async () => response([model({ capabilities: null })]) })).toEqual([]);
  });
  it("handles manual reasoning without adaptive effort", async () => {
    const capabilities = { thinking: { supported: true, types: { adaptive: no, enabled: yes, disabled: yes } } };
    expect(await loadAnthropicModelCatalog({ apiKey: "test-key", allowed, fetch: async () => response([model({ max_tokens: 8192, capabilities })]) }))
      .toEqual([{ model: "model-large", reasoning: "budget", maxOutputTokens: 8192 }]);
  });
  it.each([401, 429, 500])("keeps provider error %s and credentials out of errors without retry", async status => {
    const transport = vi.fn(async () => new Response("private-provider-body", { status }));
    await expect(loadAnthropicModelCatalog({ apiKey: "test-key", allowed, fetch: transport })).rejects.toThrow("Catalogue du fournisseur indisponible");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("fails closed on pagination rather than presenting a complete catalogue", async () => {
    await expect(loadAnthropicModelCatalog({ apiKey: "test-key", allowed,
      fetch: async () => Response.json({ data: [model()], has_more: true }) })).rejects.toThrow();
  });
  it("rejects duplicate IDs, invalid UTF-8 and oversized bodies", async () => {
    for (const body of [response([model(), model()]), new Response(new Uint8Array([255])),
      new Response("x".repeat(1_048_577))]) {
      await expect(loadAnthropicModelCatalog({ apiKey: "test-key", allowed, fetch: async () => body })).rejects.toThrow();
    }
  });
  it("prevents network activity for an already cancelled request or malformed key", async () => {
    const transport = vi.fn();
    const abort = new AbortController(); abort.abort();
    await expect(loadAnthropicModelCatalog({ apiKey: "test-key", allowed, fetch: transport }, abort.signal)).rejects.toThrow();
    await expect(loadAnthropicModelCatalog({ apiKey: "bad\nkey", allowed, fetch: transport })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("bounds body consumption and rejects a late response", async () => {
    const transport = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
    await expect(loadAnthropicModelCatalog({ apiKey: "test-key", allowed, timeoutMs: 100, fetch: transport })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
