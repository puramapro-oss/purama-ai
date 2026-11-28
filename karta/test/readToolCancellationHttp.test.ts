import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import type { ToolExecutionContext } from "../src/engine/types.js";
import { createKnowledgeSearchTool } from "../src/tools/knowledge-search.js";

vi.mock("../src/config.js", () => ({ config: { tavilyApiKey: "test-only-loopback" } }));
const { webSearchTool } = await import("../src/tools/websearch.js");

const ctx: ToolExecutionContext = { userId: "loopback-owner", agentType: "legal", mode: "live" };
type Reader = "web" | "knowledge";
type Stage = "success" | "headers" | "body";
const servers: Server[] = [];

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Local transport did not reach the expected state")), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

/** The provider is a real local HTTP server, reached through Node's signal-aware
 * request transport. No vendor request, credential or externally routable URL
 * is used. This fixture proves socket/body interruption, not vendor behavior.
 */
async function fixture(reader: Reader, stage: Stage) {
  const arrived = gate(); const reading = gate(); const closed = gate();
  let requests = 0;
  let sentSignal: AbortSignal | undefined;
  const server = createServer((incoming, outgoing) => {
    requests++;
    incoming.resume();
    outgoing.once("close", closed.resolve);
    arrived.resolve();
    if (stage === "headers") return;
    outgoing.writeHead(200, { "Content-Type": "application/json" });
    if (stage === "body") { outgoing.write("{"); return; }
    outgoing.end(reader === "web" ? '{"results":[]}' : '{"status":"ok","message":{"items":[]}}');
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const transport: typeof fetch = (input, init) => {
    const requested = new URL(String(input));
    const expectedHost = reader === "web" ? "api.tavily.com" : "api.crossref.org";
    if (requested.protocol !== "https:" || requested.hostname !== expectedHost) {
      return Promise.reject(new Error("Unexpected fixture target"));
    }
    sentSignal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request({
        hostname: "127.0.0.1", port, path: "/fixture", method: init?.method ?? "GET",
        signal: sentSignal, headers: { "Content-Type": "application/json" },
      }, response => {
        const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
        const getReader = body.getReader;
        Object.defineProperty(body, "getReader", { value: (...args: unknown[]) => {
          reading.resolve();
          return Reflect.apply(getReader, body, args);
        } });
        resolve(new Response(body, {
          status: response.statusCode ?? 500, headers: { "Content-Type": "application/json" },
        }));
      });
      outgoing.on("error", reject);
      outgoing.end(typeof init?.body === "string" ? init.body : undefined);
    });
  };
  const tool = createKnowledgeSearchTool({ fetch: transport, timeoutMs: 5000 });
  if (reader === "web") vi.stubGlobal("fetch", transport);
  return {
    arrived: arrived.promise, reading: reading.promise, closed: closed.promise,
    signal: () => sentSignal, requests: () => requests,
    execute: (signal: AbortSignal): Promise<{ results: unknown[]; ok?: boolean }> => reader === "web"
      ? webSearchTool.execute({ query: "public fixture" }, { ...ctx, signal })
      : tool.execute({ query: "public fixture", sources: ["crossref"] }, { ...ctx, signal }),
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe("public read cancellation over real loopback HTTP", () => {
  it.each(["web", "knowledge"] as const)("keeps an uncancelled %s response usable", async reader => {
    const local = await fixture(reader, "success");
    const result = await within(local.execute(new AbortController().signal));
    expect(result.results).toEqual([]);
    if ("ok" in result) expect(result.ok).toBe(true);
    expect(local.requests()).toBe(1);
    expect(local.signal()?.aborted).toBe(false);
    await within(local.closed);
  });

  it.each((["web", "knowledge"] as const).flatMap(reader =>
    (["headers", "body"] as const).map(stage => ({ reader, stage })),
  ))("closes the real $reader $stage transport when its parent is cancelled", async ({ reader, stage }) => {
    const local = await fixture(reader, stage);
    const parent = new AbortController();
    const pending = local.execute(parent.signal).then(value => ({ value }), error => ({ error }));
    try {
      await within(local.arrived);
      if (stage === "body") await within(local.reading);
      parent.abort(new Error("PRIVATE_LOOPBACK_ABORT_REASON"));
      const result = await within(pending);
      expect("error" in result).toBe(true);
      if ("error" in result) expect(String(result.error)).not.toContain("PRIVATE_LOOPBACK_ABORT_REASON");
      expect(local.signal()?.aborted).toBe(true);
      await within(local.closed);
      expect(local.requests()).toBe(1);
    } finally {
      // Also settle the negative characterization on the unpatched source.
      for (const server of servers) server.closeAllConnections();
      await pending;
    }
  });
});
