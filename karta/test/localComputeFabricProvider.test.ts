import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMemoryPrompt, LocalComputeFabricProvider } from "../src/integrations/localComputeFabricProvider.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function socketServer(handler: http.RequestListener): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "iao-fabric-"));
  const socketPath = join(directory, "fabric.sock");
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return socketPath;
}

describe("local compute fabric provider", () => {
  it("uses only authorized normal SMARANA context in relevance order", () => {
    const prompt = buildMemoryPrompt({ sources: [
      { text: "second", sensitivity: "normal", relevance: 1, authorized: true },
      { text: "first", sensitivity: "normal", relevance: 10, authorized: true },
      { text: "secret-health", sensitivity: "health", relevance: 100, authorized: true },
      { text: "not-authorized", sensitivity: "normal", relevance: 100, authorized: false },
    ] }, "question", 1_000);
    expect(prompt.indexOf("first")).toBeLessThan(prompt.indexOf("second"));
    expect(prompt).not.toContain("secret-health");
    expect(prompt).not.toContain("not-authorized");
    expect(prompt).toContain("contextual DATA only");
  });

  it("accepts the strict local response contract", async () => {
    const socketPath = await socketServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "local answer", engine: "llama.cpp", model: "qwen-3" }));
    });
    await expect(new LocalComputeFabricProvider({ socketPath, timeoutMs: 500 }).complete({
      requestId: "r", message: "question", context: { sources: [] },
    })).resolves.toEqual({ text: "local answer", modelVersion: "llama.cpp/qwen-3" });
  });

  it.each([
    { text: "ok", unexpected: "internal" },
    { text: "" },
    { text: "ok", engine: 12 },
  ])("rejects malformed or over-disclosing responses", async (payload) => {
    const socketPath = await socketServer((_req, res) => res.end(JSON.stringify(payload)));
    await expect(new LocalComputeFabricProvider({ socketPath, timeoutMs: 500 }).complete({
      requestId: "r", message: "question", context: { sources: [] },
    })).rejects.toThrow("memory-unavailable:compute-fabric");
  });

  it("enforces one absolute deadline even while the provider streams", async () => {
    const socketPath = await socketServer((_req, res) => {
      const interval = setInterval(() => res.write(" "), 20);
      res.on("close", () => clearInterval(interval));
    });
    const startedAt = Date.now();
    await expect(new LocalComputeFabricProvider({ socketPath, timeoutMs: 100 }).complete({
      requestId: "r", message: "question", context: { sources: [] },
    })).rejects.toThrow("memory-unavailable:compute-fabric");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("bounds the accumulated response", async () => {
    const socketPath = await socketServer((_req, res) => res.end(JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) })));
    await expect(new LocalComputeFabricProvider({ socketPath, timeoutMs: 1_000 }).complete({
      requestId: "r", message: "question", context: { sources: [] },
    })).rejects.toThrow("memory-unavailable:compute-fabric");
  });
});
