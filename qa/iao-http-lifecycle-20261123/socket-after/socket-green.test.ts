import { once } from "node:events";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { it, expect, vi } from "vitest";
import { startApiServer } from "/workspace/scratch/ccfbf7e5800b/purama-ai/karta/src/api/server.js";
import { IaoFacade } from "/workspace/scratch/ccfbf7e5800b/purama-ai/karta/src/iao/iaoFacade.js";
import { KartaRuntimeIaoPort } from "/workspace/scratch/ccfbf7e5800b/purama-ai/karta/src/iao/kartaRuntimePort.js";

vi.mock("/workspace/scratch/ccfbf7e5800b/purama-ai/karta/src/db/supabase.js", () => ({ supabase: {} }));
vi.mock("/workspace/scratch/ccfbf7e5800b/purama-ai/karta/src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));
vi.mock("/workspace/scratch/ccfbf7e5800b/purama-ai/karta/src/agents/index.js", () => ({ AGENT_REGISTRY: {} }));
vi.mock("/workspace/scratch/ccfbf7e5800b/purama-ai/karta/src/agents/customAgent.js", () => ({ loadCustomAgent: vi.fn() }));
vi.mock("/workspace/scratch/ccfbf7e5800b/purama-ai/karta/src/engine/approval.js", () => ({ resolvePendingAction: vi.fn() }));
vi.mock("/workspace/scratch/ccfbf7e5800b/purama-ai/karta/src/engine/killswitch.js", () => ({ setGlobalKillSwitch: vi.fn() }));

it("delivers verified IAO response after 16 seconds on the actual HTTP socket", async () => {
 const requestId = "11111111-1111-4111-8111-111111111111";
 const operationId = "33333333-3333-4333-8333-333333333333";
 let release!: (value: { text: string; modelVersion: string }) => void;
 let started!: () => void;
 let completionSignal: AbortSignal | undefined;
 let completionCalls = 0;
 let completionReturned = false;
 let socket: import("node:net").Socket | undefined;
 const admitted = new Promise<void>(resolve => { started = resolve; });
 const pending = new Promise<{ text: string; modelVersion: string }>(resolve => { release = resolve; });
 const port = new KartaRuntimeIaoPort({
  buildContext: async () => ({ operationId, context: { sources: [] } }),
  control: async () => { throw new Error("unused memory control"); },
 }, { complete: async input => {
  completionCalls++; completionSignal = input.signal; started();
  const result = await pending; completionReturned = true; return result;
 } });
 const facade = new IaoFacade(port);
 const now = Date.now();
 const identity = { tenantId: "tenant", actorId: "actor", session: {
  tenantId: "tenant", userId: "actor", sessionId: "22222222-2222-4222-8222-222222222222",
  appSlug: "purama-ai" as const, issuedAt: now - 1000, expiresAt: now + 60000,
 }};
 const server = startApiServer(async () => ({ ready: true, phase: "ready" }), {
  consultationHost: null, iaoRuntime: { facade, authenticator: { authenticate: async () => identity } },
 });
 let client: ReturnType<typeof request> | undefined;
 try {
  await once(server, "listening");
  server.on("request", req => { socket = req.socket; });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  const start = performance.now();
  const timeoutEvents: number[] = [];
  server.on("timeout", () => { timeoutEvents.push(performance.now() - start); });
  const outcome = new Promise<{ status: number; body: Record<string, unknown>; elapsedMs: number }>((resolve, reject) => {
   client = request({ host: "127.0.0.1", port: address.port, path: "/iao/requests", method: "POST", agent: false }, res => {
    let raw = "";
    res.setEncoding("utf8").on("data", chunk => { raw += chunk; });
    res.once("end", () => {
     try { resolve({ status: res.statusCode!, body: JSON.parse(raw), elapsedMs: performance.now() - start }); }
     catch (error) { reject(error); }
    });
    res.once("error", reject);
   });
   client.once("error", reject);
   client.end(JSON.stringify({ type: "conversation", requestId, conversationId: "socket-test", prompt: "synthetic local test" }));
  });
  await admitted;
  const admissionMs = performance.now() - start;
  const admittedSocketTimeoutMs = socket?.timeout;
  const observed = outcome.then(response => ({ response }), error => ({ error: String(error) }));
  await new Promise<void>(resolve => setTimeout(resolve, 16000));
  const beforeRelease = { status: facade.get("tenant", "actor", requestId).status,
   aborted: completionSignal?.aborted, completionCalls, completionReturned, socketDestroyed: socket?.destroyed,
   elapsedMs: performance.now() - start };
  release({ text: "synthetic completion after 16 seconds", modelVersion: "fixture-no-model" });
  const result = await observed;
  await server.drainRequests();
  const files = ["api/server.ts", "api/iaoRoutes.ts", "iao/iaoFacade.ts", "iao/kartaRuntimePort.ts"];
  const report = {
   observedAt: new Date().toISOString(), node: process.version,
   httpSettings: { timeout: server.timeout, requestTimeout: server.requestTimeout, headersTimeout: server.headersTimeout },
   admissionMs, admittedSocketTimeoutMs, timeoutEvents, beforeRelease, result, completionReturned,
   sourcesSha256: Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(`/workspace/scratch/ccfbf7e5800b/purama-ai/karta/src/${file}`)).digest("hex")])),
  };
  writeFileSync("/tmp/iao-http-native-green-20261123/result.json", JSON.stringify(report, null, 2) + "\n");
  console.log("NATIVE_SOCKET_GREEN_EVIDENCE " + JSON.stringify(report));
  expect([server.timeout, server.requestTimeout, server.headersTimeout]).toEqual([15000,15000,10000]);
  expect(admittedSocketTimeoutMs).toBe(241000);
  expect(timeoutEvents).toEqual([]);
  expect(beforeRelease).toMatchObject({ status: "draft", aborted: false, completionCalls: 1, completionReturned: false, socketDestroyed: false });
  expect(result).toMatchObject({ response: { status: 202, body: { status: "verified", preview: "synthetic completion after 16 seconds", proof: { source: "karta", requestId, proofId: operationId } } } });
  expect("response" in result && result.response.elapsedMs).toBeGreaterThanOrEqual(16000);
  expect(completionReturned).toBe(true);
 } finally {
  release({ text: "cleanup", modelVersion: "fixture-no-model" });
  client?.destroy(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await server.drainRequests();
 }
});
