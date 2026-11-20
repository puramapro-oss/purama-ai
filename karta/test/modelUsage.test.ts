import { describe, expect, it, vi } from "vitest";
import { normalizeModelUsage } from "../src/claude/usage.js";

const nativeURL = "https://api.anthropic.com";
const counterKeys = [
  "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens",
  "cacheCreation5mInputTokens", "cacheCreation1hInputTokens",
] as const;

function responseWithCounters(value: unknown) {
  return {
    model: "provider/model-v1:latest",
    id: "msg_observed_123",
    usage: {
      input_tokens: value,
      output_tokens: value,
      cache_read_input_tokens: value,
      cache_creation_input_tokens: value,
      cache_creation: {
        ephemeral_5m_input_tokens: value,
        ephemeral_1h_input_tokens: value,
      },
    },
  };
}

describe("provider model usage receipts", () => {
  it("preserves each reported counter and the actual model independently", () => {
    const receipt = normalizeModelUsage({
      model: "provider/actual-model:30b",
      id: "msg_observed_123",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 90,
        cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 50 },
      },
    }, "provider/requested-model:latest", nativeURL);

    expect(receipt).toStrictEqual({
      version: 1,
      apiFormat: "anthropic_messages",
      routeKind: "anthropic",
      requestedModel: "provider/requested-model:latest",
      responseModel: "provider/actual-model:30b",
      responseId: "msg_observed_123",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 90,
      cacheCreation5mInputTokens: 40,
      cacheCreation1hInputTokens: 50,
    });
  });

  it.each([undefined, null, false, 12, "response", [], [responseWithCounters(7)]])(
    "keeps unknown response data unknown: %j", value => {
      const receipt = normalizeModelUsage(value, "requested", nativeURL);
      for (const key of counterKeys) expect(receipt[key]).toBeNull();
      expect(receipt.responseModel).toBeNull();
      expect(receipt.responseId).toBeNull();
      expect(receipt.requestedModel).toBe("requested");
    },
  );

  it("does not fill missing cache counters from reported input or output", () => {
    const receipt = normalizeModelUsage({ usage: { input_tokens: 13, output_tokens: 8 } }, "requested", nativeURL);
    expect(receipt.inputTokens).toBe(13);
    expect(receipt.outputTokens).toBe(8);
    for (const key of counterKeys.slice(2)) expect(receipt[key]).toBeNull();
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER])("preserves explicitly reported integer %i", value => {
    const receipt = normalizeModelUsage(responseWithCounters(value), "requested", nativeURL);
    for (const key of counterKeys) expect(receipt[key]).toBe(value);
  });

  it.each([
    undefined, null, true, false, "0", "12", -1, 0.5, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 1, [], {}, new Number(4),
  ])("does not coerce invalid counters: %j", value => {
    const receipt = normalizeModelUsage(responseWithCounters(value), "requested", nativeURL);
    for (const key of counterKeys) expect(receipt[key]).toBeNull();
  });

  it("does not invent or repair cache totals from inconsistent TTL buckets", () => {
    const response = {
      usage: {
        cache_creation_input_tokens: 7,
        cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 },
      },
    };
    const receipt = normalizeModelUsage(response, "requested", nativeURL);
    expect(receipt.cacheCreationInputTokens).toBe(7);
    expect(receipt.cacheCreation5mInputTokens).toBe(20);
    expect(receipt.cacheCreation1hInputTokens).toBe(30);
    expect(receipt.inputTokens).toBeNull();

    const withoutTotal = normalizeModelUsage({ usage: {
      cache_creation: response.usage.cache_creation,
    } }, "requested", nativeURL);
    expect(withoutTotal.cacheCreationInputTokens).toBeNull();
  });

  it.each(["a", "a".repeat(200), "Qwen/provider_model-v1.2:30b"])(
    "keeps valid identifiers without shortening them: %s", value => {
      const receipt = normalizeModelUsage({ model: value, id: value }, value, nativeURL);
      expect(receipt.requestedModel).toBe(value);
      expect(receipt.responseModel).toBe(value);
      expect(receipt.responseId).toBe(value);
    },
  );

  it.each([
    "", "a".repeat(201), " model", "model ", "model name", "model\n", "model\r",
    "model\t", "model\u0000", "model\u007f", "modèle", "model@account", "/model", ":model", "_model",
  ])("rejects invalid identifiers without trimming or truncating: %j", value => {
    const receipt = normalizeModelUsage({ model: value, id: value }, value, nativeURL);
    expect(receipt.requestedModel).toBeNull();
    expect(receipt.responseModel).toBeNull();
    expect(receipt.responseId).toBeNull();
  });

  it.each([nativeURL, `${nativeURL}/`])("recognizes only an exact native base URL: %s", baseURL => {
    expect(normalizeModelUsage({}, "requested", baseURL).routeKind).toBe("anthropic");
  });

  it.each([
    "http://api.anthropic.com", "https://API.ANTHROPIC.COM", "https://api.anthropic.com:443",
    "https://api.anthropic.com/v1", "https://api.anthropic.com//", "https://api.anthropic.com?fixture=value",
    "https://api.anthropic.com/#fragment", "https://api.anthropic.com.example.invalid",
    "https://fixture@api.anthropic.com", "http://127.0.0.1:11434", "https://router.example.invalid", "",
  ])("keeps a non-exact base URL classified as compatible: %s", baseURL => {
    const receipt = normalizeModelUsage({}, "requested", baseURL);
    expect(receipt.routeKind).toBe("compatible");
    expect(Object.keys(receipt)).not.toContain("baseURL");
  });

  it("excludes content, headers, URLs and other response metadata", () => {
    const unexpected = "must-not-be-recorded";
    const receipt = normalizeModelUsage({
      ...responseWithCounters(2),
      content: [{ type: "text", text: unexpected }],
      headers: { authorization: unexpected },
      request: { userId: unexpected, context: unexpected },
      cost: 0,
      usage: { ...responseWithCounters(2).usage, untrusted_payload: unexpected },
    }, "requested", `https://router.example.invalid/${unexpected}?key=${unexpected}`);

    expect(Object.keys(receipt).sort()).toEqual([
      "version", "apiFormat", "routeKind", "requestedModel", "responseModel", "responseId", ...counterKeys,
    ].sort());
    expect(JSON.stringify(receipt)).not.toContain(unexpected);
    expect(Object.values(receipt).every(value => value === null
      || typeof value === "string" || typeof value === "number")).toBe(true);
  });

  it("returns a frozen copy without mutating or retaining the source", () => {
    const response = responseWithCounters(4);
    const original = structuredClone(response);
    const receipt = normalizeModelUsage(response, "requested", nativeURL);
    expect(response).toStrictEqual(original);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Reflect.set(receipt, "inputTokens", 99)).toBe(false);
    response.usage.input_tokens = 500;
    response.usage.cache_creation.ephemeral_5m_input_tokens = 600;
    response.model = "changed";
    expect(receipt.inputTokens).toBe(4);
    expect(receipt.cacheCreation5mInputTokens).toBe(4);
    expect(receipt.responseModel).toBe(original.model);
  });

  it("ignores inherited counters and accessors without invoking them", () => {
    const getter = vi.fn(() => { throw new Error("must not be invoked"); });
    const usage = Object.create({ input_tokens: 999 }) as Record<string, unknown>;
    Object.defineProperty(usage, "output_tokens", { get: getter, enumerable: true });
    Object.defineProperty(usage, "cache_creation", { get: getter, enumerable: true });
    const response = { usage };
    Object.defineProperty(response, "model", { get: getter, enumerable: true });
    Object.defineProperty(response, "content", { get: getter, enumerable: true });
    const receipt = normalizeModelUsage(response, "requested", nativeURL);
    for (const key of counterKeys) expect(receipt[key]).toBeNull();
    expect(receipt.responseModel).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not let an unreadable object turn telemetry into a decision failure", () => {
    const proxy = Proxy.revocable({}, {});
    proxy.revoke();
    const receipt = normalizeModelUsage(proxy.proxy, "requested", nativeURL);
    for (const key of counterKeys) expect(receipt[key]).toBeNull();
    expect(receipt.responseModel).toBeNull();
    expect(receipt.responseId).toBeNull();
  });
});
