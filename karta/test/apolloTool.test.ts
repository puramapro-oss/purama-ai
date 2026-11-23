import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apolloSearchPeopleTool } from "../src/tools/apollo.js";
import type { ToolExecutionContext } from "../src/engine/types.js";

const h = vi.hoisted(() => ({ config: { apolloApiKey: "test-only-apollo-key" } }));
vi.mock("../src/config.js", () => ({ config: h.config }));

const send = vi.fn<typeof fetch>();
const endpoint = "https://api.apollo.io/api/v1/mixed_people/search";
const failure = "Recherche Apollo indisponible ou réponse invalide";
const invalidInput = "Paramètres de recherche Apollo invalides";
const marker = "SYNTHETIC_PRIVATE_APOLLO_DETAIL_6297";
const maximumBytes = 1024 * 1024;
const context = { userId: "owner", agentType: "partner", mode: "live" } as const satisfies ToolExecutionContext;
const person = (overrides: Record<string, unknown> = {}) => ({
  name: "Exemple", email: "example@example.test", organization_name: "Organisation", ...overrides,
});
const execute = (params: unknown = { keywords: "synthetic prospect" }) =>
  apolloSearchPeopleTool.execute(params as { keywords: string; limit?: number }, context);

beforeEach(() => {
  send.mockReset();
  h.config.apolloApiKey = "test-only-apollo-key";
  send.mockResolvedValue(Response.json({ people: [person()] }));
  vi.stubGlobal("fetch", send);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Apollo request and result contract", () => {
  it("preserves the existing endpoint and projects only the allowed business fields", async () => {
    send.mockResolvedValue(Response.json({ people: [person({ private_extra: marker })], provider_extra: marker }));
    const result = await execute();
    expect(result).toEqual({ people: [{ name: "Exemple", email: "example@example.test", organization: "Organisation" }] });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(send).toHaveBeenCalledExactlyOnceWith(endpoint, expect.objectContaining({
      method: "POST", redirect: "error", credentials: "omit", signal: expect.any(AbortSignal),
      headers: { "X-Api-Key": "test-only-apollo-key", "Content-Type": "application/json" },
      body: JSON.stringify({ q_keywords: "synthetic prospect", per_page: 10 }),
    }));
    expect(send.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("normalizes unavailable optional fields to null without inventing contact data", async () => {
    send.mockResolvedValue(Response.json({ people: [{ name: "Exemple" }, person({ email: null, organization_name: null })] }));
    await expect(execute()).resolves.toEqual({ people: [
      { name: "Exemple", email: null, organization: null },
      { name: "Exemple", email: null, organization: null },
    ] });
  });

  it("accepts an explicit empty people list", async () => {
    send.mockResolvedValue(Response.json({ people: [] }));
    await expect(execute()).resolves.toEqual({ people: [] });
  });

  it("enforces the requested result limit even when the provider ignores it", async () => {
    send.mockResolvedValue(Response.json({ people: [person(), person({ name: "Au-delà de la limite" })] }));
    await expect(execute({ keywords: "synthetic", limit: 1 })).resolves.toEqual({
      people: [{ name: "Exemple", email: "example@example.test", organization: "Organisation" }],
    });
    expect(JSON.parse(String(send.mock.calls[0]![1]?.body)).per_page).toBe(1);
  });

  it("does not contact the provider without its configured credential", async () => {
    h.config.apolloApiKey = "";
    await expect(execute()).rejects.toThrow("APOLLO_API_KEY non configurée côté KARTA");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { label: "null input", value: null },
    { label: "missing keywords", value: {} },
    { label: "blank keywords", value: { keywords: " \n\t " } },
    { label: "oversized keywords", value: { keywords: "x".repeat(501) } },
    { label: "non-string keywords", value: { keywords: 12 } },
    { label: "zero limit", value: { keywords: "synthetic", limit: 0 } },
    { label: "oversized limit", value: { keywords: "synthetic", limit: 101 } },
    { label: "fractional limit", value: { keywords: "synthetic", limit: 1.5 } },
    { label: "null limit", value: { keywords: "synthetic", limit: null } },
    { label: "unknown field", value: { keywords: "synthetic", [marker]: "ignored?" } },
  ])("rejects $label before a provider request", async ({ value }) => {
    await expect(execute(value)).rejects.toEqual(new Error(invalidInput));
    expect(send).not.toHaveBeenCalled();
  });

  it("does not invoke a parameter getter before refusing the input", async () => {
    const getter = vi.fn(() => "synthetic");
    const input = Object.defineProperty({}, "keywords", { enumerable: true, get: getter });
    await expect(execute(input)).rejects.toEqual(new Error(invalidInput));
    expect(getter).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing people", value: {} },
    { label: "non-array people", value: { people: {} } },
    { label: "null person", value: { people: [null] } },
    { label: "missing name", value: { people: [{ email: null }] } },
    { label: "blank name", value: { people: [person({ name: "  " })] } },
    { label: "invalid optional email", value: { people: [person({ email: { private: marker } })] } },
    { label: "invalid optional organization", value: { people: [person({ organization_name: [marker] })] } },
    { label: "oversized name", value: { people: [person({ name: "x".repeat(501) })] } },
    { label: "contradictory success", value: { success: false, people: [person()] } },
  ])("refuses $label without exposing provider data", async ({ value }) => {
    send.mockResolvedValue(Response.json(value));
    await expect(execute()).rejects.toEqual(new Error(failure));
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("Apollo shared provider transport boundaries", () => {
  it("does not read or echo an HTTP error body", async () => {
    const response = new Response(marker, { status: 503 });
    const read = vi.spyOn(response, "text");
    const readBody = vi.spyOn(response.body!, "getReader");
    send.mockResolvedValue(response);
    await expect(execute()).rejects.toEqual(new Error(failure));
    expect(read).not.toHaveBeenCalled();
    expect(readBody).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not propagate transport diagnostics", async () => {
    send.mockRejectedValue(new Error(marker));
    await expect(execute()).rejects.toEqual(new Error(failure));
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "invalid JSON", response: () => new Response(marker) },
    { label: "invalid UTF-8", response: () => new Response(new Uint8Array([0xff, 0xfe])) },
    { label: "redirect response", response: () => new Response(null, { status: 302, headers: { Location: "https://other.example.invalid/" } }) },
  ])("refuses $label without another request", async ({ response }) => {
    send.mockResolvedValue(response());
    await expect(execute()).rejects.toEqual(new Error(failure));
    expect(send).toHaveBeenCalledOnce();
  });

  it("accepts a valid body at exactly 1 MiB and releases the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const body = JSON.stringify({ people: [] });
    send.mockResolvedValue(new Response(body + " ".repeat(maximumBytes - Buffer.byteLength(body))));
    await expect(execute()).resolves.toEqual({ people: [] });
    expect(vi.getTimerCount()).toBe(0);
    expect(send.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("refuses an oversized body even when Content-Length claims a smaller size", async () => {
    const body = JSON.stringify({ people: [] });
    send.mockResolvedValue(new Response(body + " ".repeat(maximumBytes + 1 - Buffer.byteLength(body)), {
      headers: { "Content-Length": "1" },
    }));
    await expect(execute()).rejects.toEqual(new Error(failure));
    expect(send).toHaveBeenCalledOnce();
  });

  it("bounds a fetch that ignores cancellation and cleans up its late body", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    let resolve!: (response: Response) => void;
    send.mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    let observed: unknown;
    void execute().then(value => { observed = value; }, error => { observed = error; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(observed).toEqual(new Error(failure));
    expect(send.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one 30-second budget across headers and a stalled body", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    send.mockImplementation(() => new Promise<Response>(resolve => {
      setTimeout(() => resolve(new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"people":')); }, cancel,
      }))), 29_000);
    }));
    let observed: unknown;
    void execute().then(value => { observed = value; }, error => { observed = error; });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(observed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observed).toEqual(new Error(failure));
    expect(cancel).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
