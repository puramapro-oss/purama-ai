import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseWorkshopProjects, type WorkshopProject } from "../src/chef/workshop-config.js";
import {
  assertCleanWorkshop, checkWorkshopRuntime, preflightWorkshopProject, runWorkshopRuntime,
  type WorkshopRun, type WorkshopRuntimeDependencies, type WorkshopWorker,
} from "../src/chef/workshop-runtime.js";
import { ChefProcessStopUnconfirmedError } from "../src/chef/process.js";
import { runChefWorkerCycle, type ChefControlPlane, type ChefRuntimeTask } from "../src/chef/supervisor.js";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const missionId = "00000000-0000-4000-8000-000000000001";
function project(overrides: Partial<WorkshopProject> = {}): WorkshopProject {
  return parseWorkshopProjects(JSON.stringify([{
    id: "example", name: "Example", userIds: ["00000000-0000-4000-8000-000000000002"],
    repo: "org/example", workdir: "/trusted/example", allowedPaths: ["src"], maxParallel: 2,
    tokenBudget: 9000, estimatedTokensPerTask: 1000, codexCommand: "codex",
    verificationProfiles: [
      { name: "test", kind: "test", command: process.execPath, args: ["--version"], requirementKeys: ["PRODUCT", "QUALITY"] },
      { name: "review", kind: "review", command: process.execPath, args: ["--version"], requirementKeys: ["PRODUCT", "QUALITY"] },
    ],
    implementationProfiles: ["test"], reviewProfiles: ["review"], ...overrides,
  }]))[0];
}
function worker(): WorkshopWorker {
  const control: ChefControlPlane = {
    heartbeat: vi.fn(async () => undefined), claimNext: vi.fn(async () => null),
    renewLease: vi.fn(async () => true), transition: vi.fn(async () => true),
    addEvidence: vi.fn(async () => true), recordUsage: vi.fn(async () => true),
    tryFinishMission: vi.fn(async () => true), quarantineProcess: vi.fn(async () => true),
  };
  return { control, driver: { provider: "codex", run: vi.fn() },
    verifier: { verify: vi.fn(async () => ({ ok: true, evidence: [] })) } };
}
function harness() {
  const abort = new AbortController();
  const events: string[] = [];
  const run: WorkshopRun = { missionId, state: "active", repo: "org/example", cancelRequested: false };
  const deps: WorkshopRuntimeDependencies = {
    pollMs: 5, heartbeatMs: 20,
    preflight: vi.fn(async p => ({ cwd: p.workdir, repositoryId: p.workdir + "/.git",
      codexCommand: "/trusted/bin/codex", verificationProfiles: p.verificationProfiles })),
    clean: vi.fn(async () => undefined),
    createWorker: vi.fn(() => worker()),
    cycle: vi.fn<typeof runChefWorkerCycle>(async () => ({ state: "idle" })),
    store: {
      probe: vi.fn(async () => undefined), killSwitch: vi.fn(async () => false),
      heartbeat: vi.fn(async (_project, _instance, _hash, online) => { events.push(online ? "online" : "offline"); return true; }),
      activeRun: vi.fn(async () => run), finishCancel: vi.fn(async () => true),
    },
  };
  return { deps, abort, events, run };
}
function blockedCycle(events: string[], release?: Promise<void>): typeof runChefWorkerCycle {
  return vi.fn<typeof runChefWorkerCycle>(async (_control, _driver, _verifier, options) => {
    events.push("started");
    await new Promise<void>(done => {
      if (options.signal?.aborted) done();
      else options.signal?.addEventListener("abort", () => { events.push("abort"); done(); }, { once: true });
    });
    if (release) await release;
    events.push("stopped");
    return { state: "idle" };
  });
}
async function waitForStarted(events: string[]): Promise<void> {
  await vi.waitFor(() => expect(events).toContain("started"), { interval: 2, timeout: 1000 });
}

describe("workshop dispatcher", () => {
  it("rejects an empty catalogue before any readiness or database write", async () => {
    const h = harness();
    await expect(runWorkshopRuntime([], undefined, h.deps)).rejects.toMatchObject({ code: "WORKSHOP_CONFIG" });
    await expect(checkWorkshopRuntime([], undefined, h.deps)).rejects.toMatchObject({ code: "WORKSHOP_CONFIG" });
    expect(h.deps.store.heartbeat).not.toHaveBeenCalled();
  });

  it("checks readiness without lease, worker cycle or model call", async () => {
    const h = harness();
    await expect(checkWorkshopRuntime([project()], undefined, h.deps)).resolves.toEqual({ projectCount: 1 });
    expect(h.deps.store.probe).toHaveBeenCalledOnce();
    expect(h.deps.store.heartbeat).not.toHaveBeenCalled();
    expect(h.deps.cycle).not.toHaveBeenCalled();
  });

  it("does not advertise readiness if local preflight fails", async () => {
    const h = harness();
    h.deps.preflight = vi.fn(async () => { throw new Error("private path"); });
    await expect(runWorkshopRuntime([project()], undefined, h.deps)).rejects.toMatchObject({ code: "WORKSHOP_PREFLIGHT" });
    expect(h.deps.store.heartbeat).not.toHaveBeenCalled();
    expect(h.deps.cycle).not.toHaveBeenCalled();
  });

  it("rejects distinct project aliases sharing one physical repository", async () => {
    const h = harness();
    h.deps.preflight = vi.fn(async p => ({ cwd: p.workdir, repositoryId: "/same/.git",
      codexCommand: "/bin/codex", verificationProfiles: p.verificationProfiles }));
    await expect(runWorkshopRuntime([project(), project({ id: "second", workdir: "/trusted/second" })],
      undefined, h.deps)).rejects.toMatchObject({ code: "WORKSHOP_CONFIG" });
    expect(h.deps.store.heartbeat).not.toHaveBeenCalled();
  });

  it("never launches a cycle without an open mission", async () => {
    const h = harness();
    h.deps.store.activeRun = vi.fn(async () => null);
    const running = runWorkshopRuntime([project()], h.abort.signal, h.deps);
    await vi.waitFor(() => expect(h.deps.store.activeRun).toHaveBeenCalled(), { interval: 2 });
    h.abort.abort();
    await running;
    expect(h.deps.cycle).not.toHaveBeenCalled();
    expect(h.deps.clean).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toBe("offline");
  });

  it("does not claim work in a paused or human-required mission", async () => {
    const h = harness();
    h.run.state = "human_required";
    const running = runWorkshopRuntime([project()], h.abort.signal, h.deps);
    await vi.waitFor(() => expect(h.deps.store.activeRun).toHaveBeenCalledTimes(2), { interval: 2 });
    h.abort.abort();
    await running;
    expect(h.deps.cycle).not.toHaveBeenCalled();
  });

  it("uses at most four independent instance-scoped worker slots", async () => {
    const h = harness();
    h.deps.cycle = blockedCycle(h.events);
    const running = runWorkshopRuntime([project({ maxParallel: 4 })], h.abort.signal, h.deps);
    await vi.waitFor(() => expect(h.deps.cycle).toHaveBeenCalledTimes(4), { interval: 2 });
    const ids = vi.mocked(h.deps.cycle).mock.calls.map(call => call[3].workerId);
    expect(new Set(ids).size).toBe(4);
    expect(ids.every(id => /^workshop:[0-9a-f-]{36}:example:[0-3]$/.test(id))).toBe(true);
    expect(h.deps.clean).toHaveBeenCalledOnce();
    h.abort.abort();
    await running;
    expect(h.events.filter(e => e === "stopped")).toHaveLength(4);
  });

  it("waits for all cycle shutdowns before marking offline", async () => {
    const h = harness();
    let release!: () => void;
    h.deps.cycle = blockedCycle(h.events, new Promise<void>(done => { release = done; }));
    const running = runWorkshopRuntime([project()], h.abort.signal, h.deps);
    await waitForStarted(h.events);
    h.abort.abort();
    await vi.waitFor(() => expect(h.events).toContain("abort"), { interval: 2 });
    expect(h.events).not.toContain("offline");
    release();
    await running;
    expect(h.events.at(-1)).toBe("offline");
  });

  it("refuses a second live instance without disrupting the first lease", async () => {
    const first = harness();
    let owner: string | undefined;
    first.deps.store.heartbeat = vi.fn(async (_project, instance, _hash, online) => {
      if (online && !owner) owner = instance;
      if (instance !== owner) return false;
      if (!online) owner = undefined;
      return true;
    });
    first.deps.cycle = blockedCycle(first.events);
    const firstRun = runWorkshopRuntime([project()], first.abort.signal, first.deps);
    await waitForStarted(first.events);
    const firstOwner = owner;
    const second = harness();
    second.deps.store = first.deps.store;
    await expect(runWorkshopRuntime([project()], second.abort.signal, second.deps))
      .rejects.toMatchObject({ code: "WORKSHOP_LEASE" });
    expect(second.deps.cycle).not.toHaveBeenCalled();
    expect(owner).toBe(firstOwner);
    first.abort.abort();
    await firstRun;
    expect(owner).toBeUndefined();
  });

  it("aborts all projects when a runtime lease renewal is refused", async () => {
    const h = harness();
    h.deps.cycle = blockedCycle(h.events);
    let onlineCalls = 0;
    h.deps.store.heartbeat = vi.fn(async (_p, _i, _h, online) => {
      h.events.push(online ? "online" : "offline");
      return !online || ++onlineCalls < 3;
    });
    await expect(runWorkshopRuntime([project()], h.abort.signal, h.deps)).rejects.toMatchObject({ code: "WORKSHOP_LEASE" });
    expect(h.events).toContain("abort");
    expect(h.events.at(-1)).toBe("offline");
  });

  it("fails closed on a fresh global kill switch while a worker is running", async () => {
    const h = harness();
    h.deps.cycle = blockedCycle(h.events);
    h.deps.store.killSwitch = vi.fn(async () => h.events.includes("started"));
    await expect(runWorkshopRuntime([project()], h.abort.signal, h.deps)).rejects.toMatchObject({ code: "WORKSHOP_KILL_SWITCH" });
    expect(h.events.indexOf("offline")).toBeGreaterThan(h.events.indexOf("stopped"));
  });

  it("stops cycles on database loss and exposes only a stable safe error", async () => {
    const h = harness();
    h.deps.cycle = blockedCycle(h.events);
    h.deps.store.activeRun = vi.fn(async () => {
      if (h.events.includes("started")) throw new Error("SUPABASE_SECRET_private_information");
      return h.run;
    });
    const result = runWorkshopRuntime([project()], h.abort.signal, h.deps);
    await expect(result).rejects.toMatchObject({ code: "WORKSHOP_DATABASE" });
    await expect(result).rejects.not.toThrow("SUPABASE_SECRET");
    expect(h.events.at(-1)).toBe("offline");
  });

  it("does not erase an unconfirmed process stop with a false offline receipt", async () => {
    const h = harness();
    h.deps.cycle = vi.fn(async () => ({
      state: "blocked_external" as const, taskId: "task", error: "private process details", haltWorker: true as const,
    }));
    await expect(runWorkshopRuntime([project()], undefined, h.deps)).rejects.toMatchObject({ code: "WORKSHOP_PROCESS_STOP" });
    expect(h.events).not.toContain("offline");
  });

  it("also halts on an unconfirmed stop thrown by the existing supervisor", async () => {
    const h = harness();
    h.deps.cycle = vi.fn(async () => { throw new ChefProcessStopUnconfirmedError("private"); });
    await expect(runWorkshopRuntime([project()], undefined, h.deps)).rejects.toMatchObject({ code: "WORKSHOP_PROCESS_STOP" });
    expect(h.events).not.toContain("offline");
  });

  it("cancels through the real CHEF cycle and finishes only after authenticated release", async () => {
    const fixture = await repository();
    const h = harness();
    h.deps.cycle = runChefWorkerCycle;
    let claimed = false;
    let driverStarted = false;
    let released = false;
    const unit = worker();
    const task: ChefRuntimeTask = {
      id: "task-1", missionId, briefHash: "a".repeat(64), instructions: "Review the project",
      cwd: fixture.cwd, accessMode: "read", fencingToken: 1, attempt: 1, verificationProfiles: ["review"], allowedPaths: [],
    };
    unit.control.claimNext = vi.fn(async () => {
      if (claimed) return null;
      claimed = true;
      return task;
    });
    unit.control.transition = vi.fn(async input => {
      h.events.push(input.target);
      if (input.target === "retryable") {
        expect(h.events).toContain("driver-stopped");
        released = true;
      }
      return true;
    });
    unit.driver.run = vi.fn<WorkshopWorker["driver"]["run"]>(async (_request, signal) => {
      driverStarted = true;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          h.events.push("driver-stopped");
          reject(new Error("cancelled"));
        }, { once: true });
      });
    });
    h.deps.createWorker = vi.fn(() => unit);
    h.deps.store.activeRun = vi.fn(async () => ({
      ...h.run, state: driverStarted ? "cancelled" : "active", cancelRequested: driverStarted,
    }));
    h.deps.store.finishCancel = vi.fn(async () => {
      expect(released).toBe(true);
      h.events.push("finish-cancel");
      h.abort.abort();
      return true;
    });
    await runWorkshopRuntime([project({ maxParallel: 1 })], h.abort.signal, h.deps);
    expect(unit.driver.run).toHaveBeenCalledOnce();
    // An interrupted provider has no receipt; the existing reservation remains unknown.
    expect(unit.control.recordUsage).not.toHaveBeenCalled();
    expect(h.events.indexOf("finish-cancel")).toBeGreaterThan(h.events.indexOf("retryable"));
    expect(h.events.at(-1)).toBe("offline");
  });

  it("leaves cancellation pending when SQL cannot confirm every old process", async () => {
    const h = harness();
    h.run.state = "cancelled";
    h.run.cancelRequested = true;
    h.deps.store.finishCancel = vi.fn(async () => false);
    const running = runWorkshopRuntime([project()], h.abort.signal, h.deps);
    await vi.waitFor(() => expect(h.deps.store.finishCancel).toHaveBeenCalledTimes(2), { interval: 2 });
    h.abort.abort();
    await running;
    expect(h.deps.cycle).not.toHaveBeenCalled();
  });

  it("aborts before preflight if shutdown was already requested", async () => {
    const h = harness();
    h.abort.abort();
    await runWorkshopRuntime([project()], h.abort.signal, h.deps);
    expect(h.deps.preflight).not.toHaveBeenCalled();
    expect(h.deps.store.heartbeat).not.toHaveBeenCalled();
  });
});

async function repository(auth = true) {
  const root = await mkdtemp(join(tmpdir(), "chef-workshop-test-"));
  dirs.push(root);
  await mkdir(join(root, "repo"));
  const cwd = await realpath(join(root, "repo"));
  await exec("git", ["init", "-q", cwd]);
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fixture"], { cwd });
  const codex = join(root, "codex");
  await writeFile(codex, "#!" + process.execPath + "\n" +
    "if (process.argv.includes('--version')) { console.log('codex-cli 0.1.0'); }\n" +
    "else if (process.argv.includes('login') && process.argv.includes('status')) {" +
    " if (process.argv.includes('--ignore-user-config')) process.exit(2);" +
    " console.error('private auth detail'); process.exit(" + (auth ? 0 : 1) + "); }\n" +
    "else { console.error('unexpected model invocation'); process.exit(77); }\n", { mode: 0o700 });
  return { root, cwd, codex, project: project({ workdir: cwd, codexCommand: codex }) };
}

describe("workshop local preflight", () => {
  it("validates a real clean Git repository, CLI version, login and verifier executables without a model", async () => {
    const fixture = await repository();
    const result = await preflightWorkshopProject(fixture.project, new AbortController().signal);
    expect(result.cwd).toMatch(/\/repo$/);
    expect(result.codexCommand).toMatch(/\/codex$/);
    expect(result.verificationProfiles).toHaveLength(2);
    await expect(assertCleanWorkshop(result.cwd, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("rejects a CLI without an authenticated account and redacts its output", async () => {
    const fixture = await repository(false);
    const result = preflightWorkshopProject(fixture.project, new AbortController().signal);
    await expect(result).rejects.toMatchObject({ code: "WORKSHOP_PREFLIGHT" });
    await expect(result).rejects.not.toThrow("private auth detail");
  });

  it("refuses pre-existing untracked work", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.cwd, "foreign.txt"), "foreign work");
    await expect(preflightWorkshopProject(fixture.project, new AbortController().signal))
      .rejects.toMatchObject({ code: "WORKSHOP_PREFLIGHT" });
  });

  it("rejects a subdirectory mistaken for a worktree root", async () => {
    const fixture = await repository();
    const nested = join(fixture.cwd, "nested");
    await mkdir(nested);
    await expect(preflightWorkshopProject({ ...fixture.project, workdir: nested }, new AbortController().signal))
      .rejects.toMatchObject({ code: "WORKSHOP_PREFLIGHT" });
  });

  it("rejects a worktree alias before advertising a mismatched SQL identity", async () => {
    const fixture = await repository();
    const alias = join(fixture.root, "alias");
    await symlink(fixture.cwd, alias);
    await expect(preflightWorkshopProject({ ...fixture.project, workdir: alias }, new AbortController().signal))
      .rejects.toMatchObject({ code: "WORKSHOP_PREFLIGHT" });
  });

  it("rejects a missing trusted verifier command", async () => {
    const fixture = await repository();
    fixture.project.verificationProfiles[0].command = join(fixture.root, "missing");
    await expect(preflightWorkshopProject(fixture.project, new AbortController().signal))
      .rejects.toMatchObject({ code: "WORKSHOP_PREFLIGHT" });
  });

  it("rejects an allowed scope that resolves outside the worktree", async () => {
    const fixture = await repository();
    await symlink(fixture.root, join(fixture.cwd, "src"));
    await exec("git", ["add", "src"], { cwd: fixture.cwd });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture symlink"], { cwd: fixture.cwd });
    await expect(preflightWorkshopProject(fixture.project, new AbortController().signal))
      .rejects.toMatchObject({ code: "WORKSHOP_PREFLIGHT" });
  });

  it("forbids a verifier executable stored inside its own worktree", async () => {
    const fixture = await repository();
    const local = join(fixture.cwd, "self-verifier");
    await writeFile(local, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await exec("git", ["add", "self-verifier"], { cwd: fixture.cwd });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture verifier"], { cwd: fixture.cwd });
    fixture.project.verificationProfiles[0].command = local;
    await expect(preflightWorkshopProject(fixture.project, new AbortController().signal))
      .rejects.toMatchObject({ code: "WORKSHOP_PREFLIGHT" });
  });

  it("rejects a Git executable resolved inside the model worktree before invoking it", async () => {
    const fixture = await repository();
    const local = join(fixture.cwd, "git");
    const marker = join(fixture.root, "untrusted-git-ran");
    await writeFile(local, "#!" + process.execPath + "\nrequire('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'bad');\n", { mode: 0o700 });
    await exec("git", ["add", "git"], { cwd: fixture.cwd });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture Git"], { cwd: fixture.cwd });
    const priorPath = process.env.PATH;
    try {
      process.env.PATH = fixture.cwd + ":" + priorPath;
      await expect(preflightWorkshopProject(fixture.project, new AbortController().signal))
        .rejects.toMatchObject({ code: "WORKSHOP_PREFLIGHT" });
      await expect(import("node:fs/promises").then(fs => fs.access(marker))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { process.env.PATH = priorPath; }
  });

  it("forbids a mutable CLI stored inside its own worktree", async () => {
    const fixture = await repository();
    const local = join(fixture.cwd, "local-codex");
    await writeFile(local, "#!" + process.execPath + "\nconsole.log('codex-cli 0.1.0')\n", { mode: 0o700 });
    await exec("git", ["add", "local-codex"], { cwd: fixture.cwd });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture CLI"], { cwd: fixture.cwd });
    await expect(preflightWorkshopProject({ ...fixture.project, codexCommand: local }, new AbortController().signal))
      .rejects.toMatchObject({ code: "WORKSHOP_PREFLIGHT" });
  });
});
