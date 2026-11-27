import { describe, expect, it, vi } from "vitest";
import { loadConnectedModelCatalog, normalizeConnectedModelLimits,
  type ConnectedModelLimit } from "../src/claude/model-catalog.js";

const limit = (patch: Partial<ConnectedModelLimit> = {}): ConnectedModelLimit => ({
  model: "host-qualified", maxOutputTokens: 16_384, ...patch,
});
const googleRow = (id: string, patch: Record<string, unknown> = {}) => ({
  name: `models/${id}`, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent"], ...patch,
});
const anthropicRow = { id: "anthropic-qualified", lifecycle: "active", max_tokens: 8192,
  capabilities: { thinking: { supported: true, types: { adaptive: { supported: true } } },
    effort: { supported: true, low: { supported: true }, high: { supported: true } } } };

describe("connected model host qualification", () => {
  it("preserves legacy Anthropic identity and defaults new routes to unqualified reasoning", () => {
    expect(normalizeConnectedModelLimits([limit()])).toEqual([
      { model: "host-qualified", provider: "anthropic", reasoning: "none", maxOutputTokens: 16_384 },
    ]);
    expect(normalizeConnectedModelLimits([limit({ provider: "openai", model: "reasoning-deep-high" })]))
      .toEqual([{ provider: "openai", model: "reasoning-deep-high", reasoning: "none", maxOutputTokens: 16_384 }]);
  });

  it("copies explicit capabilities and response identities without widening them", () => {
    const input = [limit({ provider: "google", reasoning: "adaptive", effortLevels: ["xhigh", "low"],
      responseModels: ["models/qualified-snapshot"] })];
    const normalized = normalizeConnectedModelLimits(input);
    expect(normalized[0]).toEqual({ ...input[0], effortLevels: ["low", "xhigh"] });
    input[0].effortLevels!.push("high"); input[0].responseModels!.push("unqualified");
    expect(normalized[0].effortLevels).toEqual(["low", "xhigh"]);
    expect(normalized[0].responseModels).toEqual(["models/qualified-snapshot"]);
    expect(normalizeConnectedModelLimits([limit({ provider: "google", reasoning: "budget" })])[0].reasoning).toBe("budget");
  });

  it.each(["openai", "xai"] as const)("rejects incompatible %s numeric reasoning budgets", provider => {
    expect(() => normalizeConnectedModelLimits([limit({ provider, reasoning: "budget" })])).toThrow();
  });

  it.each(["openai", "xai", "google"] as const)("does not translate Anthropic max effort to %s", provider => {
    expect(() => normalizeConnectedModelLimits([limit({ provider, reasoning: "adaptive", effortLevels: ["max"] })])).toThrow();
  });

  it("rejects ambiguous IDs across providers and equivalent Google resource names", () => {
    expect(() => normalizeConnectedModelLimits([limit({ provider: "openai" }), limit({ provider: "xai" })])).toThrow();
    expect(() => normalizeConnectedModelLimits([
      limit({ provider: "google", model: "qualified" }), limit({ provider: "google", model: "models/qualified" }),
    ])).toThrow();
    expect(() => normalizeConnectedModelLimits([limit({ provider: "google", model: "models/path/unsupported" })])).toThrow();
    expect(() => normalizeConnectedModelLimits([limit({ provider: "google", responseModels: ["qualified", "models/qualified"] })])).toThrow();
  });

  it.each([
    [], Array.from({ length: 33 }, (_, i) => limit({ model: `model-${i}` })),
    [limit({ maxOutputTokens: 1023 })], [limit({ maxOutputTokens: 65_537 })],
    [limit({ model: "model\n" })], [{ ...limit(), provider: null }], [{ ...limit(), provider: "unknown" }],
    [{ ...limit(), reasoning: null }], [{ ...limit(), effortLevels: ["high"] }],
    [{ ...limit(), reasoning: "adaptive" }], [{ ...limit(), reasoning: "adaptive", effortLevels: ["high", "high"] }],
    [{ ...limit(), responseModels: [] }], [{ ...limit(), responseModels: ["same", "same"] }],
    [{ ...limit(), responseModels: Array.from({ length: 33 }, (_, i) => `snapshot-${i}`) }],
    [{ ...limit(), injected: true }],
  ].map(input => ({ input })))("rejects malformed qualification %#", ({ input }) => {
    expect(() => normalizeConnectedModelLimits(input)).toThrow();
  });

  it("rejects accessors, proxies, sparse arrays, symbols and foreign prototypes without evaluating them", () => {
    const effect = vi.fn(() => { throw new Error("must never execute"); });
    const getterRow = Object.defineProperty(limit(), "provider", { get: effect });
    const getterArray = Object.defineProperty([limit()], "0", { get: effect });
    const proxy = new Proxy(limit(), { get: effect, getPrototypeOf: effect, ownKeys: effect });
    const arrayProxy = new Proxy([limit()], { get: effect, getPrototypeOf: effect, ownKeys: effect });
    const revoked = Proxy.revocable([limit()], {}); revoked.revoke();
    const hidden = Object.defineProperty(limit(), "hidden", { value: true });
    const sparse = Array(1);
    const extraArray = Object.assign([limit()], { extra: true });
    const symbolRow = { ...limit(), [Symbol("hidden")]: true };
    const foreignRow = Object.assign(Object.create({}), limit());
    const effortGetter = Object.defineProperty(["high"], "0", { get: effect });
    const responseGetter = Object.defineProperty(["snapshot"], "0", { get: effect });
    for (const input of [[getterRow], getterArray, [proxy], arrayProxy, revoked.proxy, [hidden], sparse,
      extraArray, [symbolRow], [foreignRow], [{ ...limit(), reasoning: "adaptive", effortLevels: effortGetter }],
      [{ ...limit(), responseModels: responseGetter }]]) {
      expect(() => normalizeConnectedModelLimits(input)).toThrow();
    }
    expect(effect).not.toHaveBeenCalled();
  });

  it("allows the existing 32-model ceiling and plain records without prototypes", () => {
    const input = Array.from({ length: 32 }, (_, i) => Object.assign(Object.create(null), limit({ model: `model-${i}` })));
    expect(normalizeConnectedModelLimits(input)).toHaveLength(32);
  });
});

describe("native connected account model discovery", () => {
  it("intersects four account catalogues with one allowlist, retaining policy order and Anthropic discovery", async () => {
    const allowed: ConnectedModelLimit[] = [
      limit({ provider: "xai", model: "qualified-alias", reasoning: "adaptive", effortLevels: ["low", "high"] }),
      limit({ model: "anthropic-qualified" }),
      limit({ provider: "google", model: "models/google-qualified", reasoning: "budget" }),
      limit({ provider: "openai", model: "openai-qualified", maxOutputTokens: 4096 }),
    ];
    const transport = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.hostname === "api.anthropic.com") return Response.json({ data: [anthropicRow], has_more: false });
      if (url.hostname === "api.openai.com") return Response.json({ data: [{ id: "openai-qualified" }, { id: "not-allowed" }] });
      if (url.hostname === "api.x.ai") return Response.json({ models: [{ id: "qualified-snapshot", aliases: ["qualified-alias"],
        input_modalities: ["text", "image"], output_modalities: ["text"],
        capabilities: { reasoning_effort: ["medium", "high", "xhigh"] } }] });
      return Response.json({ models: [googleRow("google-qualified"), googleRow("not-allowed")] });
    });
    expect(await loadConnectedModelCatalog({ allowed,
      apiKeys: { anthropic: "anthropic-key", openai: "openai-key", xai: "xai-key", google: "google-key" },
      fetch: transport })).toEqual([
      { model: "qualified-alias", reasoning: "adaptive", maxOutputTokens: 16_384, effortLevels: ["high"] },
      { model: "anthropic-qualified", reasoning: "adaptive", maxOutputTokens: 8192, effortLevels: ["low", "high"] },
      { model: "models/google-qualified", reasoning: "budget", maxOutputTokens: 8192 },
      { model: "openai-qualified", reasoning: "none", maxOutputTokens: 4096 },
    ]);
    expect(transport).toHaveBeenCalledTimes(4);
    for (const [input, init] of transport.mock.calls) {
      const url = new URL(String(input));
      expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error");
      expect(url.searchParams.has("key")).toBe(false);
      if (url.hostname === "api.x.ai") expect(url.pathname).toBe("/v1/language-models");
      if (url.hostname === "generativelanguage.googleapis.com") {
        expect(url.searchParams.get("pageSize")).toBe("1000");
        expect(init?.headers).toMatchObject({ "x-goog-api-key": "google-key" });
      } else if (url.hostname === "api.openai.com") expect(init?.headers).toMatchObject({ Authorization: "Bearer openai-key" });
    }
  });

  it("uses explicit host efforts when the account list supplies no reasoning matrix", async () => {
    const allowed = [limit({ provider: "openai", model: "opaque-a", reasoning: "adaptive", effortLevels: ["high"] }),
      limit({ provider: "xai", model: "opaque-b", reasoning: "adaptive", effortLevels: ["low", "xhigh"] })];
    const result = await loadConnectedModelCatalog({ allowed, apiKeys: { openai: "key-a", xai: "key-b" },
      fetch: async input => new URL(String(input)).hostname === "api.openai.com"
        ? Response.json({ data: [{ id: "opaque-a" }] }) : Response.json({ models: [{ id: "opaque-b" }] }) });
    expect(result).toEqual(allowed.map(({ provider: _provider, ...profile }) => profile));
  });

  it("never widens host efforts or exposes explicitly incompatible xAI modalities", async () => {
    const allowed = [limit({ provider: "xai", model: "reasoning", reasoning: "adaptive", effortLevels: ["high"] }),
      limit({ provider: "xai", model: "image-only" }), limit({ provider: "xai", model: "unqualified-reasoning" })];
    const result = await loadConnectedModelCatalog({ allowed, apiKeys: { xai: "key" }, fetch: async () => Response.json({ models: [
      { id: "reasoning", capabilities: { reasoning_effort: ["low"] } },
      { id: "image-only", output_modalities: ["image"] },
      { id: "unqualified-reasoning", capabilities: { reasoning_effort: ["high"] } },
    ] }) });
    expect(result).toEqual([{ model: "unqualified-reasoning", reasoning: "none", maxOutputTokens: 16_384 }]);
  });

  it("reads all Gemini pages, encodes opaque cursors, and filters generateContent and token limits", async () => {
    const allowed = ["second", "first", "embedding", "small", "missing"].map(model => limit({ provider: "google", model }));
    const cursor = "opaque /+?&cursor";
    const transport = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      return url.searchParams.has("pageToken")
        ? Response.json({ models: [googleRow("second", { outputTokenLimit: 32_768 }),
          googleRow("small", { outputTokenLimit: 256 }), googleRow("missing", { outputTokenLimit: null })] })
        : Response.json({ models: [googleRow("first"), googleRow("embedding", { supportedGenerationMethods: ["embedContent"] })],
          nextPageToken: cursor });
    });
    expect(await loadConnectedModelCatalog({ allowed, apiKeys: { google: "key" }, fetch: transport })).toEqual([
      { model: "second", reasoning: "none", maxOutputTokens: 16_384 },
      { model: "first", reasoning: "none", maxOutputTokens: 8192 },
    ]);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(new URL(String(transport.mock.calls[1][0])).searchParams.get("pageToken")).toBe(cursor);
  });

  it("honors an explicit Gemini thinking exclusion without deriving host efforts from thinking:true", async () => {
    const allowed = [limit({ provider: "google", model: "blocked-budget", reasoning: "budget" }),
      limit({ provider: "google", model: "blocked-adaptive", reasoning: "adaptive", effortLevels: ["high"] }),
      limit({ provider: "google", model: "host-standard" }),
      limit({ provider: "google", model: "qualified", reasoning: "adaptive", effortLevels: ["xhigh"] })];
    expect(await loadConnectedModelCatalog({ allowed, apiKeys: { google: "key" }, fetch: async () => Response.json({ models: [
      googleRow("blocked-budget", { thinking: false }), googleRow("blocked-adaptive", { thinking: false }),
      googleRow("host-standard", { thinking: true }), googleRow("qualified", { thinking: true }),
    ] }) })).toEqual([
      { model: "host-standard", reasoning: "none", maxOutputTokens: 8192 },
      { model: "qualified", reasoning: "adaptive", maxOutputTokens: 8192, effortLevels: ["xhigh"] },
    ]);
  });

  it.each(["duplicate", "cycle", "ceiling", "invalid-token"])("discards partial Gemini results after pagination %s", async mode => {
    let pages = 0;
    const transport = vi.fn<typeof fetch>(async () => {
      pages++;
      return Response.json({ models: [googleRow(mode === "duplicate" ? "first" : pages === 1 ? "first" : `page-${pages}`)],
        nextPageToken: mode === "invalid-token" ? 42 : mode === "cycle" ? "same" : `page-${pages + 1}` });
    });
    expect(await loadConnectedModelCatalog({ allowed: [limit({ provider: "google", model: "first" })],
      apiKeys: { google: "key" }, fetch: transport })).toEqual([]);
    expect(pages).toBeLessThanOrEqual(5);
    if (mode === "ceiling") expect(pages).toBe(5);
  });

  it("omits failed and unconfigured routes while keeping a successful account", async () => {
    const allowed = [limit({ model: "anthropic-qualified" }), limit({ provider: "openai", model: "available" }),
      limit({ provider: "xai", model: "failed" }), limit({ provider: "google", model: "missing-key" })];
    const transport = vi.fn<typeof fetch>(async input => new URL(String(input)).hostname === "api.openai.com"
      ? Response.json({ data: [{ id: "available" }] }) : new Response("private upstream diagnostic", { status: 401 }));
    expect(await loadConnectedModelCatalog({ allowed, apiKeys: { anthropic: "key-a", openai: "key-o", xai: "key-x" },
      fetch: transport })).toEqual([{ model: "available", maxOutputTokens: 16_384, reasoning: "none" }]);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each([
    { data: [{ id: "available" }, { id: "available" }] },
    { data: [{ id: "available" }], has_more: true },
    { data: [{ id: "available" }], nextPageToken: "unexpected" },
    { data: [{ id: "available", shutdown_date: "2000-01-01" }] },
    { data: [{ id: "available", shutdown_date: "invalid-date" }] },
    { data: [{ id: "available" }, { id: 42 }] },
  ])("rejects ambiguous, partial, or retired OpenAI catalogue %#", async body => {
    expect(await loadConnectedModelCatalog({ allowed: [limit({ provider: "openai", model: "available" })],
      apiKeys: { openai: "key" }, fetch: async () => Response.json(body) })).toEqual([]);
  });

  it("rejects duplicate xAI aliases rather than associating a host model with two snapshots", async () => {
    expect(await loadConnectedModelCatalog({ allowed: [limit({ provider: "xai", model: "alias" })], apiKeys: { xai: "key" },
      fetch: async () => Response.json({ models: [{ id: "snapshot-1", aliases: ["alias"] },
        { id: "snapshot-2", aliases: ["alias"] }] }) })).toEqual([]);
  });

  it("bounds a stalled route independently of a healthy account", async () => {
    const signals: AbortSignal[] = [];
    const result = await loadConnectedModelCatalog({ timeoutMs: 100,
      allowed: [limit({ provider: "xai", model: "stalled" }), limit({ provider: "openai", model: "available" })],
      apiKeys: { xai: "key-x", openai: "key-o" }, fetch: async (input, init) => {
        if (new URL(String(input)).hostname === "api.openai.com") return Response.json({ data: [{ id: "available" }] });
        signals.push(init!.signal!);
        return new Promise<Response>(() => {});
      } });
    expect(result).toEqual([{ model: "available", maxOutputTokens: 16_384, reasoning: "none" }]);
    expect(signals).toHaveLength(1); expect(signals[0].aborted).toBe(true);
  });

  it("propagates caller cancellation and aborts every in-flight route", async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    let started!: () => void;
    const bothStarted = new Promise<void>(resolve => { started = resolve; });
    const pending = loadConnectedModelCatalog({
      allowed: [limit({ provider: "openai", model: "a" }), limit({ provider: "google", model: "b" })],
      apiKeys: { openai: "key-o", google: "key-g" }, fetch: async (_input, init) => {
        signals.push(init!.signal!); if (signals.length === 2) started();
        return new Promise<Response>(() => {});
      } }, controller.signal);
    await bothStarted; controller.abort();
    await expect(pending).rejects.toThrow();
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it("prevents network calls for cancellation, invalid policy, or malformed/missing credentials", async () => {
    const transport = vi.fn<typeof fetch>();
    const options = { allowed: [limit({ provider: "openai" })], apiKeys: { openai: "key" }, fetch: transport };
    const controller = new AbortController(); controller.abort();
    await expect(loadConnectedModelCatalog(options, controller.signal)).rejects.toThrow();
    await expect(loadConnectedModelCatalog({ ...options, allowed: [limit({ provider: "openai", reasoning: "budget" })] })).rejects.toThrow();
    await expect(loadConnectedModelCatalog({ ...options, timeoutMs: 99 })).rejects.toThrow();
    expect(await loadConnectedModelCatalog({ ...options, apiKeys: { openai: "bad\nkey" } })).toEqual([]);
    expect(await loadConnectedModelCatalog({ ...options, apiKeys: {} })).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });
});
