import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { request, type IncomingHttpHeaders } from "node:http";
import type { RuntimeReadiness } from "../src/runtime/lifecycle.js";

const h = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), stopped: vi.fn(), readiness: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { from: h.from, rpc: h.rpc } }));
vi.mock("../src/engine/killswitch.js", () => ({ setGlobalKillSwitch: vi.fn(), isGlobalKillSwitchActive: h.stopped }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: { legal: {} } }));
vi.mock("../src/agents/customAgent.js", () => ({ loadCustomAgent: vi.fn() }));
vi.mock("../src/engine/approval.js", () => ({ resolvePendingAction: vi.fn() }));
import { startApiServer } from "../src/api/server.js";

const owner = "00000000-0000-4000-8000-000000000201";
const other = "00000000-0000-4000-8000-000000000202";
const missionId = "abcdef01-0000-4000-8000-000000000203";
const requestId = "abcdef02-0000-4000-8000-000000000204";
const taskId = "abcdef03-0000-4000-8000-000000000205";
const path = "/workshop/" + owner;
const stamp = "2026-11-12T06:00:00.000Z";
const start = { action: "start", projectId: "atelier", requestId, prompt: "Créer le site de mon atelier avec un formulaire." };
type Row = Record<string, unknown>;
type Result = { data: unknown; error: null | { code: string; message?: string } };
const rows: Record<string, Row[]> = {};
function query(table: string) {
  let values = [...(rows[table] ?? [])];
  const result = (): Result => ({ data: values, error: null });
  const builder = {
    select: () => builder,
    eq: (key: string, value: unknown) => { values = values.filter(row => row[key] === value); return builder; },
    in: (key: string, allowed: unknown[]) => { values = values.filter(row => allowed.includes(row[key])); return builder; },
    order: () => builder,
    limit: (count: number) => { values = values.slice(0, count); return builder; },
    maybeSingle: async (): Promise<Result> => ({ data: values[0] ?? null, error: null }),
    single: async (): Promise<Result> => values.length === 1 ? { data: values[0], error: null }
      : { data: null, error: { code: "PGRST116" } },
    then: (resolve: (result: Result) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
  };
  return builder;
}
let server: ReturnType<typeof startApiServer>;
let port: number;
beforeAll(async () => {
  server = startApiServer(() => h.readiness() as Promise<RuntimeReadiness>);
  await new Promise<void>(resolve => server.once("listening", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
beforeEach(() => {
  vi.resetAllMocks();
  h.readiness.mockResolvedValue({ ready: true, phase: "ready" });
  h.stopped.mockResolvedValue(false);
  h.from.mockImplementation(query);
  h.rpc.mockImplementation(async (name: string) => ({
    data: name === "chef_workshop_submit" ? missionId : name === "chef_workshop_cancel", error: null,
  }));
  vi.stubEnv("CHEF_WORKSHOP_PROJECTS_JSON", JSON.stringify([{
    id: "atelier", name: "Mon atelier", userIds: [owner], repo: "owner/site",
    workdir: "/workshop/atelier", allowedPaths: ["src"], maxParallel: 2,
    tokenBudget: 3000, estimatedTokensPerTask: 1000,
    implementationProfiles: ["acceptance"], reviewProfiles: ["review"],
    verificationProfiles: [
      { name: "acceptance", kind: "test", command: "node", args: ["/trusted/acceptance.mjs"], requirementKeys: ["PRODUCT", "QUALITY"] },
      { name: "review", kind: "review", command: "node", args: ["/trusted/review.mjs"], requirementKeys: ["PRODUCT", "QUALITY"] },
    ],
  }]));
  for (const key of Object.keys(rows)) delete rows[key];
  rows.chef_workshop_runs = [{ mission_id: missionId, user_id: owner, project_id: "atelier",
    cancel_requested_at: null, finished_at: null, created_at: stamp }];
  rows.chef_missions = [{ id: missionId, user_id: owner, goal: start.prompt, state: "active",
    created_at: stamp, updated_at: stamp, finished_at: null, tokens_used: 0, cost_used_micros: 0 }];
  rows.chef_tasks = [{ id: taskId, mission_id: missionId, task_key: "implementation", title: "Construction",
    state: "ready", assigned_provider: null, provider: "codex", attempt: 0, output_sha: null }];
  rows.chef_evidence = [];
  rows.chef_workshop_runtimes = [];
});
afterEach(() => vi.unstubAllEnvs());
function post(body: unknown, target = path, token = "test-only-admin"): Promise<{
  status: number; body: Record<string, unknown>; raw: string; headers: IncomingHttpHeaders;
}> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: target, method: "POST", headers: {
      authorization: "Bearer " + token, "content-type": "application/json", "content-length": Buffer.byteLength(raw),
    } }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) as Record<string, unknown>, raw: text, headers: res.headers }));
    });
    req.on("error", reject); req.end(raw);
  });
}

describe("CHEF workshop real HTTP route", () => {
  it("authenticates the administrative proxy before parsing JSON, readiness or database access", async () => {
    const result = await post("{broken", path, "wrong-token");
    expect(result.status).toBe(401);
    expect(h.readiness).not.toHaveBeenCalled(); expect(h.stopped).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
  it.each(["{", "null", "[]", '"a string"'])("rejects malformed or nonobject JSON (%#)", async body => {
    expect((await post(body)).status).toBe(400);
    expect(h.from).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
  it("bounds raw request bytes before dispatching", async () => {
    expect((await post(JSON.stringify({ ...start, pad: "x".repeat(66000) }))).status).toBe(413);
    expect(h.from).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
  it("rejects a noncanonical account UUID that still matches the route shape", async () => {
    expect((await post({ action: "list" }, "/workshop/" + "a".repeat(36))).status).toBe(400);
    expect(h.from).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { action: "list", userId: other }, { action: "status", missionId, userId: other },
    { action: "cancel", missionId, command: "forged" }, { ...start, worktree: "/another/account" },
    { ...start, userId: other }, { action: "__proto__" }, { action: "constructor" },
  ])("refuses extra fields or forged owner/command arguments through the real service (%#)", async body => {
    const result = await post(body);
    expect(result.status).toBe(400); expect(result.body.code).toBe("WORKSHOP_INVALID");
    expect(h.from).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
  it("rejects query parameters before any action can be forwarded", async () => {
    expect((await post(start, path + "?userId=" + other)).status).toBe(400);
    expect(h.from).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
  it("returns 503 for new work while queue readiness is degraded", async () => {
    h.readiness.mockResolvedValue({ ready: false, phase: "failed" });
    const result = await post(start);
    expect(result.status).toBe(503); expect(result.raw).not.toContain("PRIVATE");
    expect(h.from).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
  it("returns 503 when the readiness check itself fails, without exposing its exception", async () => {
    h.readiness.mockRejectedValue(new Error("PRIVATE Redis password"));
    const result = await post(start);
    expect(result.status).toBe(503); expect(result.raw).not.toContain("PRIVATE"); expect(h.rpc).not.toHaveBeenCalled();
  });
  it.each(["status", "cancel"])("keeps %s accessible during degraded readiness and invalid project config", async action => {
    h.readiness.mockResolvedValue({ ready: false, phase: "failed" });
    vi.stubEnv("CHEF_WORKSHOP_PROJECTS_JSON", "broken-config");
    if (action === "cancel") rows.chef_workshop_runs[0].cancel_requested_at = stamp;
    const result = await post({ action, missionId });
    expect(result.status).toBe(200); expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toMatchObject({ ok: true, mission: { id: missionId, state: action === "cancel" ? "cancelling" : "active" } });
    expect(h.readiness).not.toHaveBeenCalled();
    if (action === "cancel") expect(h.rpc.mock.calls).toEqual([
      ["chef_workshop_cancel", { p_user_id: owner, p_mission_id: missionId }],
      ["chef_workshop_finish_cancel", { p_mission_id: missionId }],
    ]);
    else expect(h.rpc).not.toHaveBeenCalled();
  });
  it("rejects a mission owned by another account even with a valid administrative proxy", async () => {
    const result = await post({ action: "status", missionId }, "/workshop/" + other);
    expect(result.status).toBe(404); expect(result.body.code).toBe("WORKSHOP_NOT_FOUND");
    expect(result.raw).not.toContain(start.prompt);
    expect(h.from).toHaveBeenCalledExactlyOnceWith("chef_workshop_runs");
  });
  it("uses configured ownership and returns actual admission without claiming that execution completed", async () => {
    const result = await post(start);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, mission: { id: missionId, state: "active", verifiedTasks: 0, totalTasks: 1 } });
    expect(h.rpc).toHaveBeenCalledOnce();
    expect(h.rpc.mock.calls[0][0]).toBe("chef_workshop_submit");
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_user_id: owner, p_project_id: "atelier", p_request_id: requestId });
    expect(result.headers["cache-control"]).toBe("no-store");
  });
  it("preserves a safe workshop conflict status and discards raw database diagnostics", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "PW409", message: "PRIVATE database diagnostics" } });
    const result = await post(start);
    expect(result.status).toBe(409); expect(result.body).toMatchObject({ ok: false, code: "WORKSHOP_CONFLICT" });
    expect(result.raw).not.toContain("PRIVATE"); expect(h.from).not.toHaveBeenCalled();
  });
});
