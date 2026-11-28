import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { request } from "node:http";
import type { AgentCycleJobData, EnqueueAgentCycleOptions } from "../src/queue/queues.js";

const h = vi.hoisted(() => ({ enqueue: vi.fn(), custom: vi.fn() }));
vi.mock("../src/engine/killswitch.js", () => ({
  setGlobalKillSwitch: vi.fn(), isGlobalKillSwitchActive: async () => false,
}));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: h.enqueue }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: { legal: {} } }));
vi.mock("../src/agents/customAgent.js", () => ({ loadCustomAgent: h.custom }));
vi.mock("../src/engine/approval.js", () => ({ resolvePendingAction: vi.fn() }));

import { startApiServer } from "../src/api/server.js";
import { createCycleDelivery, CycleDeliveryConflictError, getQueuedExecutionKey } from "../src/queue/delivery-identity.js";

const owner = "00000000-0000-4000-8000-000000000071";
const agent = "00000000-0000-4000-8000-000000000072";
let server: ReturnType<typeof startApiServer>;
let port: number;
beforeAll(async () => {
  server = startApiServer();
  await new Promise<void>(resolve => server.once("listening", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
beforeEach(() => {
  vi.resetAllMocks();
  h.custom.mockResolvedValue({ id: agent, user_id: owner, karta_enabled: true, is_active: true });
  h.enqueue.mockImplementation(async (data: AgentCycleJobData, options?: EnqueueAgentCycleOptions) =>
    createCycleDelivery(data, options?.dedupeKey).jobId);
});

function post(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: {
      authorization: "Bearer test-only-admin", "idempotency-key": "request-identity-one",
    } }, res => {
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(raw) as Record<string, unknown> }));
    });
    req.on("error", reject); req.end();
  });
}

it.each([`/trigger/legal/${owner}`, `/trigger-custom/${agent}`, `/trigger-custom/${agent}/owner/${owner}`])("returns the server execution key for %s without claiming completion", async path => {
  const response = await post(path);
  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({ ok: true, queued: true });
  const jobId = response.body.jobId;
  expect(jobId).toBeTypeOf("string");
  expect(response.body.executionKey).toBe(getQueuedExecutionKey(jobId as string));
  expect(response.body.executionKey).toMatch(/^queue:v2:karta-v2-dedupe-[0-9a-f]{64}$/);
  expect(response.body).not.toHaveProperty("status", "success");
  expect(h.enqueue).toHaveBeenCalledOnce();
});

it("keeps the same delivery identity through the owner-bound and administrative routes", async () => {
  const legacy = await post(`/trigger-custom/${agent}`);
  const scoped = await post(`/trigger-custom/${agent}/owner/${owner}`);
  expect(legacy.status).toBe(202);
  expect(scoped.status).toBe(202);
  expect(scoped.body).toEqual(legacy.body);
  expect(h.enqueue).toHaveBeenCalledTimes(2);
  for (const [data] of h.enqueue.mock.calls) expect(data.userId).toBe(owner);
});

it.each([
  `/trigger-custom/${agent}/owner/----`,
  `/trigger-custom/----/owner/${owner}`,
  `/trigger-custom/${agent}/owner/${owner}?unexpected=1`,
])("refuses an invalid owner-bound route before loading a record: %s", async path => {
  const response = await post(path);
  expect(response.status).toBe(400);
  expect(h.custom).not.toHaveBeenCalled();
  expect(h.enqueue).not.toHaveBeenCalled();
});

it("refuses an owner-bound admission when the loaded record has no owner", async () => {
  h.custom.mockResolvedValue({ id: agent, karta_enabled: true, is_active: true });
  const response = await post(`/trigger-custom/${agent}/owner/${owner}`);
  expect(response.status).toBe(403);
  expect(response.body).toEqual({ error: "Accès refusé" });
  expect(h.enqueue).not.toHaveBeenCalled();
});

it("does not manufacture a journal identity for an old or unconfirmed queue response", async () => {
  h.enqueue.mockResolvedValue("legacy-job-17");
  const response = await post(`/trigger/legal/${owner}`);
  expect(response.status).toBe(202);
  expect(response.body).not.toHaveProperty("executionKey");
});

it("reports a conflicting delivery as 409 without acknowledging a queued mission", async () => {
  h.enqueue.mockRejectedValue(new CycleDeliveryConflictError());
  const response = await post(`/trigger/legal/${owner}`);
  expect(response.status).toBe(409);
  expect(response.body.error).toBeTypeOf("string");
  expect(response.body).not.toHaveProperty("queued");
  expect(response.body).not.toHaveProperty("executionKey");
});
