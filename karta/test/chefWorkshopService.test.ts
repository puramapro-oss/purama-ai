import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const h = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), stopped: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { from: h.from, rpc: h.rpc } }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: h.stopped }));
import { buildWorkshopBrief, getWorkshopMission, handleWorkshopRequest } from "../src/chef/workshop-service.js";
import { parseWorkshopProjects, workshopProjectHash } from "../src/chef/workshop-config.js";
import { hashChefBrief } from "../src/chef/brief.js";

const owner = "00000000-0000-4000-8000-000000000101";
const other = "00000000-0000-4000-8000-000000000102";
const missionId = "abcdef01-0000-4000-8000-000000000103";
const otherMissionId = "abcdef02-0000-4000-8000-000000000104";
const requestId = "abcdef03-0000-4000-8000-000000000105";
const taskId = "abcdef04-0000-4000-8000-000000000106";
const otherTaskId = "abcdef05-0000-4000-8000-000000000107";
const stamp = "2026-11-12T06:00:00.000Z";
const prompt = "Créer le site de mon atelier avec une galerie et un formulaire.";
const start = { action: "start", projectId: "atelier", requestId, prompt };
function projectFixture() {
  return {
    id: "atelier", name: "Mon atelier", userIds: [owner], repo: "owner/site",
    workdir: "/workshop/atelier", allowedPaths: ["src", "tests", "package.json"],
    maxParallel: 2, tokenBudget: 3000, estimatedTokensPerTask: 1000,
    implementationProfiles: ["acceptance"], reviewProfiles: ["review"],
    verificationProfiles: [
      { name: "acceptance", kind: "test", command: "node", args: ["/trusted/acceptance.mjs"], requirementKeys: ["PRODUCT", "QUALITY"] },
      { name: "review", kind: "review", command: "node", args: ["/trusted/review.mjs"], requirementKeys: ["PRODUCT", "QUALITY"] },
    ],
  };
}
type Row = Record<string, unknown>;
type Operation = { method: string; args: unknown[] };
type Query = { table: string; operations: Operation[] };
type Result = { data: unknown; error: null | { code: string; message?: string } };
const rows: Record<string, Row[]> = {};
const errors: Record<string, Result["error"]> = {};
const queries: Query[] = [];
function query(table: string) {
  const log = { table, operations: [] as Operation[] }; queries.push(log);
  let values = [...(rows[table] ?? [])];
  const record = (method: string, ...args: unknown[]) => { log.operations.push({ method, args }); return builder; };
  const result = (): Result => ({ data: values, error: errors[table] ?? null });
  const builder = {
    select: (columns: string) => record("select", columns),
    eq: (key: string, value: unknown) => { values = values.filter(row => row[key] === value); return record("eq", key, value); },
    in: (key: string, allowed: unknown[]) => { values = values.filter(row => allowed.includes(row[key])); return record("in", key, allowed); },
    order: (key: string, options?: { ascending?: boolean }) => {
      values.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (options?.ascending === false ? -1 : 1));
      return record("order", key, options);
    },
    limit: (count: number) => { values = values.slice(0, count); return record("limit", count); },
    maybeSingle: async (): Promise<Result> => ({ ...result(), data: values[0] ?? null }),
    single: async (): Promise<Result> => values.length === 1 ? { ...result(), data: values[0] }
      : { data: null, error: { code: "PGRST116" } },
    then: (resolve: (result: Result) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
  };
  return builder;
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("CHEF_WORKSHOP_PROJECTS_JSON", JSON.stringify([projectFixture()]));
  for (const key of Object.keys(rows)) delete rows[key];
  for (const key of Object.keys(errors)) delete errors[key];
  queries.length = 0;
  rows.chef_workshop_runs = [
    { mission_id: missionId, user_id: owner, project_id: "atelier", cancel_requested_at: null, finished_at: null, created_at: stamp },
    { mission_id: otherMissionId, user_id: other, project_id: "other", cancel_requested_at: null, finished_at: null, created_at: stamp },
  ];
  rows.chef_missions = [
    { id: missionId, user_id: owner, goal: prompt, state: "active", created_at: stamp, updated_at: stamp, finished_at: null,
      tokens_used: "42", cost_used_micros: "7", repo: "PRIVATE_REPO", driver: "PRIVATE_DRIVER" },
    { id: otherMissionId, user_id: other, goal: "OTHER_PRIVATE_PROMPT", state: "verified_done", created_at: stamp, updated_at: stamp,
      finished_at: stamp, tokens_used: "900", cost_used_micros: "50" },
  ];
  rows.chef_tasks = [
    { id: taskId, mission_id: missionId, task_key: "implementation", title: "Construction", state: "running",
      assigned_provider: "codex", provider: "auto", attempt: 1, output_sha: "a".repeat(40), instructions: "PRIVATE_INSTRUCTIONS", created_at: stamp },
    { id: otherTaskId, mission_id: otherMissionId, task_key: "private", title: "OTHER_PRIVATE_TASK", state: "verified_done",
      assigned_provider: null, provider: "codex", attempt: 1, output_sha: "b".repeat(40), created_at: stamp },
  ];
  rows.chef_evidence = [
    { task_id: taskId, payload: "PRIVATE_EVIDENCE" }, { task_id: taskId, payload: "PRIVATE_EVIDENCE" },
    { task_id: otherTaskId, payload: "OTHER_PRIVATE_EVIDENCE" },
  ];
  rows.chef_workshop_runtimes = [{
    project_id: "atelier", online: true, config_hash: workshopProjectHash(parseWorkshopProjects()[0]),
    heartbeat_at: new Date().toISOString(), process: "PRIVATE_PROCESS",
  }];
  h.from.mockImplementation(query);
  h.stopped.mockResolvedValue(false);
  h.rpc.mockImplementation(async (name: string) => ({
    data: name === "chef_workshop_submit" ? missionId : name === "chef_workshop_cancel", error: null,
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe("workshop owner boundaries and public status", () => {
  it("checks the owner-scoped admission before reading mission children", async () => {
    await expect(getWorkshopMission(owner, otherMissionId)).rejects.toMatchObject({ status: 404, code: "WORKSHOP_NOT_FOUND" });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ table: "chef_workshop_runs", operations: expect.arrayContaining([
      { method: "eq", args: ["user_id", owner] }, { method: "eq", args: ["mission_id", otherMissionId] },
    ]) });
  });
  it("projects actual status and evidence counts without paths, prompts or stale success SHAs", async () => {
    const mission = await getWorkshopMission(owner, missionId);
    expect(mission).toMatchObject({
      id: missionId, projectId: "atelier", state: "active", totalTasks: 1, verifiedTasks: 0,
      usage: { tokens: 42, costMicros: 7 }, tasks: [{ id: taskId, provider: "codex", outputSha: null, evidenceCount: 2 }],
    });
    expect(JSON.stringify(mission)).not.toContain("PRIVATE");
    expect(queries.find(q => q.table === "chef_missions")?.operations).toContainEqual({ method: "eq", args: ["user_id", owner] });
    expect(queries.find(q => q.table === "chef_tasks")?.operations).toContainEqual({ method: "eq", args: ["mission_id", missionId] });
    expect(queries.find(q => q.table === "chef_evidence")?.operations).toContainEqual({ method: "in", args: ["task_id", [taskId]] });
  });
  it("exposes a verified SHA and preserves an unassigned provider as null", async () => {
    rows.chef_tasks[0].state = "verified_done"; rows.chef_tasks[0].assigned_provider = null;
    const mission = await getWorkshopMission(owner, missionId);
    expect(mission).toMatchObject({ verifiedTasks: 1, tasks: [{ outputSha: "a".repeat(40), provider: null }] });
  });
  it("keeps a cancellation pending until its durable finalization", async () => {
    rows.chef_workshop_runs[0].cancel_requested_at = stamp;
    rows.chef_missions[0].state = "cancelled"; rows.chef_missions[0].finished_at = stamp;
    expect(await getWorkshopMission(owner, missionId)).toMatchObject({ state: "cancelling", finishedAt: null });
    rows.chef_workshop_runs[0].finished_at = stamp;
    expect(await getWorkshopMission(owner, missionId)).toMatchObject({ state: "cancelled", finishedAt: stamp });
  });
  it("keeps status and cancellation available despite invalid project config or global stop", async () => {
    vi.stubEnv("CHEF_WORKSHOP_PROJECTS_JSON", "invalid-config");
    h.stopped.mockResolvedValue(true);
    expect(await handleWorkshopRequest(owner, { action: "status", missionId })).toMatchObject({ ok: true, mission: { id: missionId } });
    rows.chef_workshop_runs[0].cancel_requested_at = stamp;
    const cancelled = await handleWorkshopRequest(owner, { action: "cancel", missionId: missionId.toUpperCase() });
    expect(cancelled).toMatchObject({ ok: true, mission: { state: "cancelling" } });
    expect(h.rpc.mock.calls).toEqual([
      ["chef_workshop_cancel", { p_user_id: owner, p_mission_id: missionId }],
      ["chef_workshop_finish_cancel", { p_mission_id: missionId }],
    ]);
    expect(h.stopped).not.toHaveBeenCalled();
  });
  it("does not finalize or inspect a cancellation denied to this owner", async () => {
    h.rpc.mockResolvedValue({ data: false, error: null });
    await expect(handleWorkshopRequest(owner, { action: "cancel", missionId: otherMissionId }))
      .rejects.toMatchObject({ status: 404, code: "WORKSHOP_NOT_FOUND" });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("chef_workshop_cancel", { p_user_id: owner, p_mission_id: otherMissionId });
    expect(h.from).not.toHaveBeenCalled();
  });
  it("fails closed on database errors without forwarding their messages", async () => {
    errors.chef_workshop_runs = { code: "UNKNOWN", message: "PRIVATE database token" };
    await expect(getWorkshopMission(owner, missionId)).rejects.toMatchObject({
      status: 503, code: "WORKSHOP_UNAVAILABLE", message: "Le service de création est temporairement indisponible.",
    });
    expect(queries).toHaveLength(1);
  });
});

describe("workshop validated mission admission", () => {
  it.each([
    {}, { action: "__proto__" }, { action: "constructor" }, { action: "toString" }, { action: "unknown" },
    { action: "list", userId: other }, { action: "status", missionId, owner },
    { action: "cancel", missionId: "not-a-uuid" },
    { ...start, worktree: "/tmp/forged" }, { ...start, command: "rm -rf anything" },
    { ...start, allowedPaths: ["/"] }, { ...start, provider: "claude" }, { ...start, userId: other },
    { ...start, requestId: undefined }, { ...start, requestId: "../forged" }, { ...start, projectId: "../project" },
    { ...start, prompt: "short" }, { ...start, prompt: " ".repeat(25) }, { ...start, prompt: "x".repeat(6001) },
    { ...start, prompt: "An otherwise useful request\u0000with invalid input" },
  ])("rejects invalid or client-controlled execution arguments before any DB request (%#)", async body => {
    await expect(handleWorkshopRequest(owner, body)).rejects.toMatchObject({ status: 400, code: "WORKSHOP_INVALID" });
    expect(h.from).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
  it("rejects a malformed account identity before any database request", async () => {
    await expect(handleWorkshopRequest("../../owner", { action: "list" })).rejects.toMatchObject({ status: 400 });
    expect(h.from).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
  it("does not admit a project belonging to another account", async () => {
    vi.stubEnv("CHEF_WORKSHOP_PROJECTS_JSON", JSON.stringify([{ ...projectFixture(), userIds: [other] }]));
    await expect(handleWorkshopRequest(owner, start)).rejects.toMatchObject({ status: 404, code: "WORKSHOP_NOT_FOUND" });
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it.each(["{", JSON.stringify([{ ...projectFixture(), allowedPaths: ["../escape"] }])])("does not admit work with invalid server configuration (%#)", async raw => {
      vi.stubEnv("CHEF_WORKSHOP_PROJECTS_JSON", raw);
      await expect(handleWorkshopRequest(owner, start)).rejects.toMatchObject({ status: 503, code: "WORKSHOP_UNAVAILABLE" });
      expect(h.rpc).not.toHaveBeenCalled();
    });
  it("blocks new work while the global stop is active", async () => {
    h.stopped.mockResolvedValue(true);
    await expect(handleWorkshopRequest(owner, start)).rejects.toMatchObject({ status: 503 });
    expect(h.stopped).toHaveBeenCalledExactlyOnceWith(true); expect(h.rpc).not.toHaveBeenCalled();
  });
  it("binds canonical idempotency, configured execution scope and verification budget to the admission RPC", async () => {
    const result = await handleWorkshopRequest(owner.toUpperCase(), { ...start, requestId: requestId.toUpperCase(), prompt: "  " + prompt + "\n" });
    expect(result).toMatchObject({ ok: true, mission: { id: missionId, state: "active" } });
    const project = parseWorkshopProjects()[0];
    const brief = buildWorkshopBrief(project, requestId, prompt);
    const hash = createHash("sha256").update(JSON.stringify({ projectId: "atelier", prompt })).digest("hex");
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("chef_workshop_submit", {
      p_user_id: owner, p_project_id: "atelier", p_request_id: requestId,
      p_request_hash: hash, p_config_hash: workshopProjectHash(project), p_brief: brief,
      p_brief_hash: hashChefBrief(brief), p_max_parallel: 2, p_token_budget: 3000, p_cost_budget_micros: null,
    });
    expect(brief.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "implementation", accessMode: "write", worktree: "/workshop/atelier",
        allowedPaths: expect.arrayContaining(["src", "tests", "package.json"]) }),
      expect.objectContaining({ key: "functional-review", accessMode: "read", dependsOn: ["implementation"] }),
      expect.objectContaining({ key: "security-review", accessMode: "read", dependsOn: ["implementation"] }),
    ]));
  });
  it("keeps the same request identity and content hash across an uncertain retry", async () => {
    await handleWorkshopRequest(owner, start); await handleWorkshopRequest(owner, start);
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(h.rpc.mock.calls[0]).toEqual(h.rpc.mock.calls[1]);
  });
  it.each([
    ["PW400", 400, "WORKSHOP_INVALID"], ["PW409", 409, "WORKSHOP_CONFLICT"], ["PW423", 409, "WORKSHOP_BUSY"],
    ["PW429", 429, "WORKSHOP_RATE_LIMIT"], ["PW503", 503, "WORKSHOP_UNAVAILABLE"], ["UNKNOWN", 503, "WORKSHOP_UNAVAILABLE"],
  ])("projects database rejection %s without acknowledging a mission", async (code, status, publicCode) => {
    h.rpc.mockResolvedValue({ data: null, error: { code, message: "PRIVATE server config" } });
    await expect(handleWorkshopRequest(owner, start)).rejects.toMatchObject({ status, code: publicCode });
    expect(h.from).not.toHaveBeenCalled();
  });
  it("does not accept an invalid mission identifier returned by storage", async () => {
    h.rpc.mockResolvedValue({ data: "forged-mission", error: null });
    await expect(handleWorkshopRequest(owner, start)).rejects.toMatchObject({ status: 503 });
    expect(h.from).not.toHaveBeenCalled();
  });
});

describe("workshop bounded catalogue and history", () => {
  it("lists only account projects and missions in a bounded number of database queries", async () => {
    vi.stubEnv("CHEF_WORKSHOP_PROJECTS_JSON", JSON.stringify([projectFixture(), {
      ...projectFixture(), id: "other", userIds: [other], workdir: "/workshop/other",
    }]));
    const result = await handleWorkshopRequest(owner, { action: "list" });
    expect(result).toMatchObject({
      ok: true, projects: [{ id: "atelier", ready: true, maxParallel: 2 }],
      missions: [{ id: missionId, totalTasks: 1, verifiedTasks: 0, usage: { tokens: 42, costMicros: 7 } }],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).not.toContain("OTHER");
    expect(queries).toHaveLength(4);
    expect(queries.map(q => q.table)).not.toContain("chef_evidence");
    expect(queries.find(q => q.table === "chef_workshop_runs")?.operations).toContainEqual({ method: "limit", args: [30] });
    expect(queries.find(q => q.table === "chef_tasks")?.operations).toContainEqual({ method: "in", args: ["mission_id", [missionId]] });
  });
  it.each(["stale", "offline", "wrong-config", "kill-switch"])("does not claim a ready executor when %s", async cause => {
    if (cause === "stale") rows.chef_workshop_runtimes[0].heartbeat_at = "2000-01-01T00:00:00.000Z";
    if (cause === "offline") rows.chef_workshop_runtimes[0].online = false;
    if (cause === "wrong-config") rows.chef_workshop_runtimes[0].config_hash = "0".repeat(64);
    if (cause === "kill-switch") h.stopped.mockResolvedValue(true);
    expect(await handleWorkshopRequest(owner, { action: "list" })).toMatchObject({ projects: [{ ready: false }] });
  });
  it("lists an empty account without fetching unrelated mission details", async () => {
    vi.stubEnv("CHEF_WORKSHOP_PROJECTS_JSON", "[]");
    rows.chef_workshop_runs = [];
    expect(await handleWorkshopRequest(owner, { action: "list" })).toEqual({ ok: true, projects: [], missions: [] });
    expect(queries).toHaveLength(2);
  });
});
