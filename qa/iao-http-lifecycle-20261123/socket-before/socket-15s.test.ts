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

it("observes actual 15-second socket cutoff while admitted IAO continues and settles", async () => {
 const requestId = "11111111-1111-4111-8111-111111111111";
 const operationId = "33333333-3333-4333-8333-333333333333";
 let release!: (value: { text: string; modelVersion: string }) => void;
 let started!: () => void;
 let completionSignal: AbortSignal | undefined;
 let completionCalls = 0;
 let completionReturned = false;
 const admitted = new Promise<void>(resolve => { started = resolve; });
 const pending = new Promise<{ text: string; modelVersion: string }>(resolve => { release = resolve; });
 const port = new KartaRuntimeIaoPort({
  buildContext: async () => ({ operationId, context: { sources: [] } }),
  control: async () => { throw new Error("unused memory control"); },
 }, {
  complete: async input => {
   completionCalls++;
   completionSignal = input.signal;
   started();
   const value = await pending;
   completionReturned = true;
   return value;
  },
 });
 const facade = new IaoFacade(port);
 const now = Date.now();
 const identity = { tenantId: "tenant", actorId: "actor", session: {
  tenantId: "tenant", userId: "actor", sessionId: "22222222-2222-4222-8222-222222222222",
  appSlug: "purama-ai" as const, issuedAt: now - 1000, expiresAt: now + 60000,
 }};
 const server = startApiServer(async () => ({ ready: true, phase: "ready" }), {
  consultationHost: null,
  iaoRuntime: { facade, authenticator: { authenticate: async () => identity } },
 });
 let client: ReturnType<typeof request> | undefined;
 try {
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  const start = performance.now();
  let serverTimeoutMs: number | undefined;
  server.once("timeout", () => { serverTimeoutMs = performance.now() - start; });
  const outcome = new Promise<{ code: string; elapsedMs: number }>((resolve, reject) => {
   client = request({ host: "127.0.0.1", port: address.port, path: "/iao/requests", method: "POST", agent: false }, res => {
    res.resume();
    reject(new Error(`Unexpected HTTP response before releasing completion: ${res.statusCode}`));
   });
   client.once("error", (error: NodeJS.ErrnoException) => resolve({ code: error.code ?? "unknown", elapsedMs: performance.now() - start }));
   client.end(JSON.stringify({ type: "conversation", requestId, conversationId: "socket-test", prompt: "synthetic local test" }));
  });
  await admitted;
  const admissionMs = performance.now() - start;
  const disconnected = await outcome;
  const atDisconnect = {
   status: facade.get("tenant", "actor", requestId).status,
   aborted: completionSignal?.aborted,
   completionCalls, completionReturned,
  };
  let drainFinished = false;
  const drained = server.drainRequests().then(() => { drainFinished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const drainWaitsForTask = !drainFinished;
  release({ text: "synthetic completion after disconnected socket", modelVersion: "fixture-no-model" });
  await drained;
  const afterSettlement = facade.get("tenant", "actor", requestId);
  const files = ["api/server.ts", "api/iaoRoutes.ts", "iao/iaoFacade.ts", "iao/kartaRuntimePort.ts"];
  const report = {
   observedAt: new Date().toISOString(), node: process.version,
   httpSettings: { timeout: server.timeout, requestTimeout: server.requestTimeout, headersTimeout: server.headersTimeout },
   admissionMs, serverTimeoutMs, disconnected, atDisconnect, drainWaitsForTask,
   afterSettlement: { status: afterSettlement.status, preview: afterSettlement.preview, proof: afterSettlement.proof,
    completionReturned, aborted: completionSignal?.aborted },
   sourcesSha256: Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(`/workspace/scratch/ccfbf7e5800b/purama-ai/karta/src/${file}`)).digest("hex")])),
  };
  writeFileSync("/tmp/iao-http-native-15s-20261123/result.json", JSON.stringify(report, null, 2) + "\n");
  console.log("NATIVE_SOCKET_EVIDENCE " + JSON.stringify(report));
  expect(server.timeout).toBe(15000);
  expect(disconnected.code).toBe("ECONNRESET");
  expect(disconnected.elapsedMs).toBeGreaterThanOrEqual(14500);
  expect(disconnected.elapsedMs).toBeLessThan(20000);
  expect(atDisconnect).toEqual({ status: "draft", aborted: false, completionCalls: 1, completionReturned: false });
  expect(drainWaitsForTask).toBe(true);
  expect(afterSettlement).toMatchObject({ status: "verified", preview: "synthetic completion after disconnected socket", proof: { source: "karta", requestId, proofId: operationId } });
  expect(completionReturned).toBe(true);
 } finally {
  release({ text: "cleanup", modelVersion: "fixture-no-model" });
  client?.destroy();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await server.drainRequests();
 }
});
