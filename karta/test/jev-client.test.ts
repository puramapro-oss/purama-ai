import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JEV_MAX_RESPONSE_BYTES,
  JevTransportError,
  requestJev,
} from "../src/jev/client.js";
import { JEV_MODEL, validateJevRequest } from "../src/jev/schema.js";

const API_KEY = "test-only-jev-token-private";
const PRIVATE_STATE = "PRIVATE_STATE_do_not_include_in_errors";
const PRIVATE_PROVIDER = "PRIVATE_PROVIDER_do_not_include_in_errors";
const encoder = new TextEncoder();

function makeRequest() {
  return validateJevRequest({
    state: PRIVATE_STATE,
    questions: { ready: { type: "noul", instructions: "La preuve est-elle suffisante ?" } },
  });
}

function makeReply() {
  return {
    model: JEV_MODEL,
    answers: { ready: { type: "noul", noul: 0.8 } },
    usage: { input_tokens: 12, output_tokens: 4 },
  };
}

function jsonResponse(value: unknown = makeReply()): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(response: Response = jsonResponse()) {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

function options(fetchImpl: typeof fetch, signal = new AbortController().signal) {
  return { apiKey: API_KEY, signal, fetchImpl };
}

async function expectTransportError(
  operation: Promise<unknown>,
  code: string,
  attempted: boolean,
): Promise<JevTransportError> {
  let rejected: unknown;
  try {
    await operation;
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(JevTransportError);
  const error = rejected as JevTransportError;
  expect(error.code).toBe(code);
  expect(error.attempted).toBe(attempted);
  return error;
}

function expectSanitized(error: JevTransportError): void {
  const exposed = [String(error), JSON.stringify(error), error.stack ?? "", String(error.cause)].join("\n");
  for (const secret of [API_KEY, PRIVATE_STATE, PRIVATE_PROVIDER]) {
    expect(exposed).not.toContain(secret);
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Jev HTTP client", () => {
  it("exports the fixed 512 KiB response limit", () => {
    expect(JEV_MAX_RESPONSE_BYTES).toBe(524_288);
  });

  it("posts the normalized pinned request to the fixed endpoint without mutating inputs", async () => {
    const request = freezeDeep(makeRequest());
    const before = structuredClone(request);
    const response = jsonResponse();
    const fetchImpl = mockFetch(response);
    const settings = Object.freeze(options(fetchImpl));
    const result = await requestJev(request, settings);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [input, init] = fetchImpl.mock.calls[0]!;
    const sent = new Request(input, init);
    expect(sent.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent.method).toBe("POST");
    expect(sent.redirect).toBe("error");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(init?.signal).toBe(settings.signal);
    expect(JSON.parse(await sent.text())).toEqual({ model: JEV_MODEL, ...before });
    expect(result).toEqual(makeReply());
    expect(request).toEqual(before);
    expect(response.body?.locked).toBe(false);
  });

  it("uses the supplied global fetch only when fetchImpl is omitted", async () => {
    const fetchImpl = mockFetch();
    vi.stubGlobal("fetch", fetchImpl);
    const result = await requestJev(makeRequest(), {
      apiKey: API_KEY,
      signal: new AbortController().signal,
    });
    expect(result).toEqual(makeReply());
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects invalid request data before any dispatch", async () => {
    const fetchImpl = mockFetch();
    for (const request of [
      { ...makeRequest(), state: "  " },
      { ...makeRequest(), state: "x".repeat(33_000) },
      { ...makeRequest(), model: "jev-latest" },
      { ...makeRequest(), questions: {} },
    ]) {
      const error = await expectTransportError(requestJev(request, options(fetchImpl)), "invalid_request", false);
      expectSanitized(error);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects blank, non-string and control-containing keys before dispatch", async () => {
    const fetchImpl = mockFetch();
    for (const apiKey of ["", "   ", undefined, null, 123, `${API_KEY}\n`, `${API_KEY}\r`, `${API_KEY}\0`, `${API_KEY}\u007f`, `${API_KEY}\u0085`]) {
      const error = await expectTransportError(requestJev(makeRequest(), {
        ...options(fetchImpl), apiKey: apiKey as string,
      }), "invalid_request", false);
      expectSanitized(error);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not dispatch when the caller has already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error(`${API_KEY}: ${PRIVATE_STATE}`));
    const fetchImpl = mockFetch();
    const error = await expectTransportError(requestJev(makeRequest(), options(fetchImpl, controller.signal)), "cancelled", false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expectSanitized(error);
  });

  it("maps HTTP errors without reading private bodies, retrying, or leaving readers locked", async () => {
    const cases = [
      [401, "authentication"], [403, "authentication"], [402, "credits"],
      [429, "rate_limit"], [400, "invalid_request"], [422, "invalid_request"],
      [500, "provider_unavailable"], [529, "provider_unavailable"], [302, "provider_unavailable"],
    ] as const;
    for (const [status, code] of cases) {
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(encoder.encode(`${API_KEY}: ${PRIVATE_PROVIDER}`));
        controller.close();
      });
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
      const response = new Response(body, { status });
      const fetchImpl = mockFetch(response);
      const error = await expectTransportError(requestJev(makeRequest(), options(fetchImpl)), code, true);
      expectSanitized(error);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    }
  });

  it("sanitizes network errors and never logs credentials or provider details", async () => {
    const logSpies = ["log", "error", "warn", "info", "debug"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined));
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(`${API_KEY} ${PRIVATE_STATE} ${PRIVATE_PROVIDER}`));
    const error = await expectTransportError(requestJev(makeRequest(), options(fetchImpl)), "provider_unavailable", true);
    expectSanitized(error);
    expect(fetchImpl).toHaveBeenCalledOnce();
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("honors cancellation while fetch is pending without retrying", async () => {
    const controller = new AbortController();
    let announceDispatch!: () => void;
    const dispatched = new Promise<void>((resolve) => { announceDispatch = resolve; });
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const signal = new Request(input, init).signal;
      announceDispatch();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(PRIVATE_PROVIDER)), { once: true });
      });
    });
    const operation = requestJev(makeRequest(), options(fetchImpl, controller.signal));
    await dispatched;
    controller.abort(new Error(PRIVATE_STATE));
    const error = await expectTransportError(operation, "cancelled", true);
    expectSanitized(error);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects a response arriving after cancellation and cancels its unread body", async () => {
    const controller = new AbortController();
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }));
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort(PRIVATE_PROVIDER);
      return response;
    });
    const error = await expectTransportError(requestJev(makeRequest(), options(fetchImpl, controller.signal)), "cancelled", true);
    expectSanitized(error);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("cancels a blocked body read and releases its lock without waiting for provider cleanup", async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let announceRead!: () => void;
    const reading = new Promise<void>((resolve) => { announceRead = resolve; });
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(new ReadableStream<Uint8Array>({
      pull: () => { announceRead(); },
      cancel,
    }, { highWaterMark: 0 }));
    const fetchImpl = mockFetch(response);
    const operation = requestJev(makeRequest(), options(fetchImpl, controller.signal));
    await reading;
    controller.abort(new Error(PRIVATE_PROVIDER));
    const error = await expectTransportError(operation, "cancelled", true);
    expectSanitized(error);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    const registered = addListener.mock.calls.find(([event]) => event === "abort");
    expect(registered).toBeDefined();
    expect(removeListener.mock.calls.some(([event, listener]) => event === "abort" && listener === registered?.[1])).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("decodes valid multibyte UTF-8 split between individual streamed bytes", async () => {
    const bytes = encoder.encode(JSON.stringify({ ...makeReply(), provider_note: "é🧠東京" }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const response = new Response(body);
    const fetchImpl = mockFetch(response);
    expect(await requestJev(makeRequest(), options(fetchImpl))).toEqual(makeReply());
    expect(response.body?.locked).toBe(false);
  });

  it("accepts a complete response at the exact byte cap and removes provider metadata", async () => {
    const padded = { ...makeReply(), provider_padding: "" };
    const fixedBytes = encoder.encode(JSON.stringify(padded)).byteLength;
    padded.provider_padding = "x".repeat(JEV_MAX_RESPONSE_BYTES - fixedBytes);
    const body = JSON.stringify(padded);
    expect(encoder.encode(body).byteLength).toBe(JEV_MAX_RESPONSE_BYTES);
    const response = new Response(body);
    expect(await requestJev(makeRequest(), options(mockFetch(response)))).toEqual(makeReply());
    expect(response.body?.locked).toBe(false);
  });

  it("stops a chunked response over the byte cap even when Content-Length understates it", async () => {
    const chunks = [
      new Uint8Array(JEV_MAX_RESPONSE_BYTES / 2).fill(0x20),
      new Uint8Array(JEV_MAX_RESPONSE_BYTES / 2).fill(0x20),
      Uint8Array.of(0x20),
    ];
    let next = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[next++];
        if (chunk) controller.enqueue(chunk);
      },
      cancel,
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: { "content-length": "1" } });
    const fetchImpl = mockFetch(response);
    const error = await expectTransportError(requestJev(makeRequest(), options(fetchImpl)), "invalid_response", true);
    expectSanitized(error);
    expect(next).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects malformed or primitive JSON without exposing response text", async () => {
    for (const body of ["", `{\"private\":\"${PRIVATE_PROVIDER}\"`, "null", "[]", JSON.stringify(PRIVATE_PROVIDER)]) {
      const response = new Response(body);
      const fetchImpl = mockFetch(response);
      const error = await expectTransportError(requestJev(makeRequest(), options(fetchImpl)), "invalid_response", true);
      expectSanitized(error);
      expect(response.body?.locked).toBe(false);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it("uses fatal UTF-8 decoding even when replacement characters would produce valid JSON", async () => {
    const prefix = encoder.encode(`${JSON.stringify(makeReply()).slice(0, -1)},"provider_note":"`);
    const suffix = encoder.encode('"}');
    const body = new Uint8Array(prefix.byteLength + 2 + suffix.byteLength);
    body.set(prefix);
    body.set([0xc3, 0x28], prefix.byteLength);
    body.set(suffix, prefix.byteLength + 2);
    expect(() => JSON.parse(new TextDecoder().decode(body))).not.toThrow();
    const response = new Response(body);
    const error = await expectTransportError(requestJev(makeRequest(), options(mockFetch(response))), "invalid_response", true);
    expectSanitized(error);
    expect(response.body?.locked).toBe(false);
  });

  it("validates the pinned model, answer identities, values and usage after JSON parsing", async () => {
    const reply = makeReply();
    const invalidReplies = [
      { ...reply, model: "jev-latest" },
      { ...reply, answers: { other: reply.answers.ready } },
      { ...reply, answers: { ready: { type: "noul", noul: 1.2 } } },
      { ...reply, usage: { input_tokens: -1, output_tokens: 4 } },
    ];
    for (const invalid of invalidReplies) {
      const fetchImpl = mockFetch(jsonResponse(invalid));
      const error = await expectTransportError(requestJev(makeRequest(), options(fetchImpl)), "invalid_response", true);
      expectSanitized(error);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it("rejects a successful HTTP status without any response body", async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    const error = await expectTransportError(requestJev(makeRequest(), options(fetchImpl)), "invalid_response", true);
    expectSanitized(error);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sanitizes streaming failures and releases the reader lock", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error(`${API_KEY}: ${PRIVATE_PROVIDER}`)); },
    }, { highWaterMark: 0 });
    const response = new Response(body);
    const fetchImpl = mockFetch(response);
    const error = await expectTransportError(requestJev(makeRequest(), options(fetchImpl)), "invalid_response", true);
    expectSanitized(error);
    expect(response.body?.locked).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
