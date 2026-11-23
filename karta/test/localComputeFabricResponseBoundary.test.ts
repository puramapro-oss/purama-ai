import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IaoCompletionPort } from "../src/iao/kartaRuntimePort.js";
import { LocalComputeFabricProvider } from "../src/integrations/localComputeFabricProvider.js";

const cleanups: Array<() => Promise<void>> = [];
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FAILURE = "memory-unavailable:compute-fabric";

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

function input(signal?: AbortSignal): Parameters<IaoCompletionPort["complete"]>[0] {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: `iao:${"a".repeat(64)}`,
    payloadDigest: "b".repeat(64),
    message: "Bonjour",
    context: { sources: [] },
    signal,
  };
}

function receipt(text = "local answer") {
  return {
    text, engine: "fixture", model: "local", protocol_version: 2,
    idempotency_key: input().idempotencyKey, payload_digest: input().payloadDigest,
    execution: {
      locality: "local_only", paid_fallback_used: false,
      accepted_max_tokens: 1024, accepted_concurrency: 1,
    },
  };
}

async function socketServer(handler: http.RequestListener): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "iao-r-"));
  const socketPath = join(directory, "fabric.sock");
  const server = http.createServer((request, response) => {
    request.resume();
    handler(request, response);
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

describe("local compute response acceptance boundary", () => {
  it.each([
    ["isolated continuation", [0x80]],
    ["truncated sequence", [0xc3]],
    ["overlong sequence", [0xc0, 0xaf]],
  ] as const)("rejects %s UTF-8 inside an otherwise attested JSON response", async (_name, invalidBytes) => {
    const encoded = JSON.stringify(receipt("before|after"));
    const separator = encoded.indexOf("|");
    const malformed = Buffer.concat([
      Buffer.from(encoded.slice(0, separator)), Buffer.from(invalidBytes), Buffer.from(encoded.slice(separator + 1)),
    ]);
    const socketPath = await socketServer((_request, response) => response.end(malformed));
    await expect(new LocalComputeFabricProvider({ socketPath, timeoutMs: 5_000 }).complete(input()))
      .rejects.toThrow(FAILURE);
  });

  it("accepts valid Unicode even when the transport splits a multibyte sequence", async () => {
    const text = "Bonjour 🌍 — très bien";
    const bytes = Buffer.from(JSON.stringify(receipt(text)));
    const split = bytes.indexOf(Buffer.from("🌍")) + 2;
    const socketPath = await socketServer((_request, response) => {
      response.write(bytes.subarray(0, split));
      setImmediate(() => response.end(bytes.subarray(split)));
    });
    await expect(new LocalComputeFabricProvider({ socketPath, timeoutMs: 5_000 }).complete(input()))
      .resolves.toEqual({ text, modelVersion: "fixture/local" });
  });

  it.each([0, 1])("preserves the exact transport byte cap at maximum + %i byte(s)", async (extra) => {
    const overhead = Buffer.byteLength(JSON.stringify(receipt("")));
    const text = "x".repeat(MAX_RESPONSE_BYTES - overhead + extra);
    const encoded = Buffer.from(JSON.stringify(receipt(text)));
    expect(encoded.length).toBe(MAX_RESPONSE_BYTES + extra);
    const socketPath = await socketServer((_request, response) => response.end(encoded));
    const completed = new LocalComputeFabricProvider({ socketPath, timeoutMs: 5_000 }).complete(input());
    if (extra) await expect(completed).rejects.toThrow(FAILURE);
    else expect((await completed).text.length).toBe(text.length);
  });

  it.each([4_999, 5_000])("checks the response against one monotonic deadline at %i milliseconds", async (receivedAt) => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const socketPath = await socketServer((_request, response) => {
      clock.mockReturnValue(receivedAt);
      response.end(JSON.stringify(receipt()));
    });
    const completed = new LocalComputeFabricProvider({ socketPath, timeoutMs: 5_000 }).complete(input());
    if (receivedAt === 5_000) await expect(completed).rejects.toThrow(FAILURE);
    else await expect(completed).resolves.toEqual({ text: "local answer", modelVersion: "fixture/local" });
  });

  it("cannot accept JSON validation which finishes after the absolute deadline", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const encoded = JSON.stringify(receipt());
    const parse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const result: unknown = parse(text, reviver);
      if (text === encoded) clock.mockReturnValue(5_000);
      return result;
    });
    const socketPath = await socketServer((_request, response) => response.end(encoded));
    await expect(new LocalComputeFabricProvider({ socketPath, timeoutMs: 5_000 }).complete(input()))
      .rejects.toThrow(FAILURE);
  });

  it("keeps the same deadline across the parsed-response promise handoff", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const encoded = JSON.stringify(receipt());
    const parse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const result: unknown = parse(text, reviver);
      if (text === encoded) queueMicrotask(() => clock.mockReturnValue(5_000));
      return result;
    });
    const socketPath = await socketServer((_request, response) => response.end(encoded));
    await expect(new LocalComputeFabricProvider({ socketPath, timeoutMs: 5_000 }).complete(input()))
      .rejects.toThrow(FAILURE);
  });

  it("honors cancellation across the parsed-response promise handoff without exposing its reason", async () => {
    const controller = new AbortController();
    const encoded = JSON.stringify(receipt());
    const parse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const result: unknown = parse(text, reviver);
      if (text === encoded) queueMicrotask(() => controller.abort(new Error("private-cancellation-reason")));
      return result;
    });
    const socketPath = await socketServer((_request, response) => response.end(encoded));
    await expect(new LocalComputeFabricProvider({ socketPath, timeoutMs: 5_000 }).complete(input(controller.signal)))
      .rejects.toThrow("memory-unavailable:cancelled");
  });
});
