import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { request } from "node:http";
const h = vi.hoisted(() => ({ ready: vi.fn(), enqueue: vi.fn(), stop: vi.fn(), update: vi.fn() }));
vi.mock("../src/engine/killswitch.js", () => ({ setGlobalKillSwitch: h.stop }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: h.enqueue }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: { legal: {} } }));
vi.mock("../src/agents/customAgent.js", () => ({ loadCustomAgent: vi.fn() }));
vi.mock("../src/engine/approval.js", () => ({ resolvePendingAction: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { from: () => ({ update: h.update }) } }));
import { startApiServer } from "../src/api/server.js";
let server: ReturnType<typeof startApiServer>;
let port: number;
beforeAll(async () => { server = startApiServer(h.ready); await new Promise<void>(resolve => server.once("listening", resolve)); port = (server.address() as { port: number }).port; });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  vi.resetAllMocks(); h.ready.mockResolvedValue({ ready: false, phase: "ready" }); h.stop.mockResolvedValue(undefined);
  h.update.mockImplementation(() => ({ eq: () => ({ eq: async () => ({ error: null }) }) }));
});
function call(path: string, body?: unknown, authorized = true): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST",
      headers: authorized ? { authorization: "Bearer test-only-admin", "content-type": "application/json" } : {} }, res => {
      let raw = ""; res.on("data", chunk => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(raw) as Record<string, unknown> }));
    }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
it("separates process liveness from dependency readiness", async () => {
  expect((await call("/live")).status).toBe(200);
  expect((await call("/health")).status).toBe(503);
  h.ready.mockResolvedValue({ ready: true, phase: "ready", globalKillSwitch: false });
  expect(await call("/health")).toMatchObject({ status: 200, body: { ready: true, status: "ok" } });
});
it("returns a generic unavailable health response on a probe exception", async () => {
  h.ready.mockRejectedValue(new Error("PRIVATE_SECRET"));
  const result = await call("/health"); expect(result.status).toBe(503); expect(JSON.stringify(result)).not.toContain("PRIVATE_SECRET");
});
it("does not admit work while the dependency probe is unavailable", async () => {
  const result = await call("/trigger/legal/00000000-0000-4000-8000-000000000071", {});
  expect(result.status).toBe(503); expect(h.enqueue).not.toHaveBeenCalled();
});
it("preserves authenticated global emergency stop during a Redis outage", async () => {
  expect((await call("/kill-switch/global", { active: true })).status).toBe(200);
  expect(h.stop).toHaveBeenCalledWith(true); expect(h.ready).not.toHaveBeenCalled();
});
it("preserves authenticated per-agent emergency stop during an outage", async () => {
  expect((await call("/kill-switch/legal/00000000-0000-4000-8000-000000000071", { active: true })).status).toBe(200);
  expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ kill_switch: true }));
});
it.each(["/kill-switch/global", "/kill-switch/legal/00000000-0000-4000-8000-000000000071"])("refuses re-enabling execution without readiness at %s", async path => {
  expect((await call(path, { active: false })).status).toBe(503);
  expect(h.stop).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
});
it("does not relax authentication or boolean validation for emergency stops", async () => {
  expect((await call("/kill-switch/global", { active: true }, false)).status).toBe(401);
  expect((await call("/kill-switch/global", { active: "true" })).status).toBe(400);
  expect(h.stop).not.toHaveBeenCalled();
});
