import { describe, expect, it, vi } from "vitest";
import { requestNativeProviderJson } from "../src/claude/native-provider-http.js";

const options = () => ({ url: "https://api.openai.com/v1/models", provider: "openai" as const,
  apiKey: "private-key", method: "GET" as const, signal: new AbortController().signal });
describe("native provider transport boundary", () => {
  it.each([
    "https://attacker.example/v1/models", "http://api.openai.com/v1/models",
    "https://private-key@api.openai.com/v1/models", "https://api.openai.com/v1/models?api_key=oops",
    "https://api.openai.com/v1/models#fragment", "https://api.openai.com/v1/other",
  ])("never sends credentials to an unqualified route: %s", async url => {
    const transport = vi.fn<typeof fetch>();
    await expect(requestNativeProviderJson({ ...options(), url, fetch: transport })).rejects.toThrow("indisponible");
    expect(transport).not.toHaveBeenCalled();
  });
  it("cancels non-success bodies without copying provider secrets or messages", async () => {
    const cancel = vi.fn();
    const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), { status: 401 }));
    await expect(requestNativeProviderJson({ ...options(), fetch: transport })).rejects.toThrow(/^Réponse du fournisseur indisponible$/);
    expect(cancel).toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects redirected responses even if a transport ignored redirect:error", async () => {
    const response = Response.json({ data: [] });
    Object.defineProperty(response, "redirected", { value: true });
    await expect(requestNativeProviderJson({ ...options(), fetch: vi.fn(async () => response) })).rejects.toThrow("indisponible");
  });
  it("rejects oversized, malformed and non-object JSON without exposing content", async () => {
    for (const response of [new Response('{"data":"private secret"}'), new Response("not-json-private-key"), Response.json([]),
      new Response(new Uint8Array([0xc3, 0x28]))]) {
      await expect(requestNativeProviderJson({ ...options(), maxBytes: 16, fetch: vi.fn(async () => response) }))
        .rejects.toThrow(/^Réponse du fournisseur indisponible$/);
    }
  });
  it("cancels late fetch results when the caller was cancelled before headers", async () => {
    const controller = new AbortController(), cancelled = vi.fn();
    const transport = vi.fn<typeof fetch>(async () => {
      controller.abort("private abort");
      return new Response(new ReadableStream({ cancel: cancelled }));
    });
    await expect(requestNativeProviderJson({ ...options(), signal: controller.signal, fetch: transport })).rejects.toThrow("indisponible");
    expect(cancelled).toHaveBeenCalled();
  });
});
