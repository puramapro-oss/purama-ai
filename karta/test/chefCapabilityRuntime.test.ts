import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessChefDriver, type ChefDriverRequest } from "../src/chef/driver.js";
import {
  createFileChefCapabilityResolver, hasChefCapabilityReceipt, prepareChefCapabilities,
  type ChefCapabilityRuntime,
} from "../src/chef/capability-runtime.js";
import type { ChefCapabilitySelection } from "../src/chef/capability-selection.js";
import { runChefWorkerCycle, type ChefControlPlane } from "../src/chef/supervisor.js";

const now = 1_800_000_000_000;
const binding = { userId: "u1", missionId: "m1", taskId: "t1", briefHash: "a".repeat(64) };
const selection: ChefCapabilitySelection = {
  mode: "auto", needs: ["typescript"], selectedIds: [], excludedIds: [], maxSelected: 8,
};
const contexts = () => ({
  binding, observedAtMs: now - 100, validUntilMs: now + 1_000, remainingBudgetMicros: 20,
  capabilities: [{ id: "ts-code", kind: "skill", version: "v1", provides: ["typescript"],
    requires: [], qualified: true, available: true, authorized: true, quality: 0.9, estimatedCostMicros: 2 }],
});
const runtime = (): ChefCapabilityRuntime => ({ adapterProtocol: 1, now: () => now, resolveContext: () => contexts() });
const temp: string[] = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), "chef-capabilities-")); temp.push(dir); return dir; }
function request(cwd: string): ChefDriverRequest {
  return { schemaVersion: 1, ...binding, workerId: "w1", provider: "codex", fencingToken: 1,
    attempt: 1, instructions: "Coder le projet", cwd, accessMode: "read", allowedPaths: [],
    capabilitySelection: selection };
}
const echoScript = `let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{
  const req=JSON.parse(text);console.log(JSON.stringify({schemaVersion:1,status:'completed',summary:'ok',
    metadata:{received:req},usage:{inputTokens:2,outputTokens:3,costMicros:4},
    capabilityReceipt:{selectionHash:req.capabilityPlan?.selectionHash,
      appliedIds:req.capabilityPlan?.selected.map(c=>c.id)}}));});`;

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temp.splice(0).map(dir => rm(dir, { force: true, recursive: true })));
});

describe("CHEF capability process admission", () => {
  it("passes only the selected versioned capabilities to a real subprocess", async () => {
    const cwd = await directory();
    const driver = new ProcessChefDriver({ provider: "codex", command: process.execPath,
      args: ["-e", echoScript], allowedRoots: [cwd], capabilityRuntime: runtime() });
    const result = await driver.run({ ...request(cwd), capabilityPlan: { forged: true } } as ChefDriverRequest);
    expect(result.status).toBe("completed");
    const received = result.metadata?.received as Record<string, unknown>;
    expect(received.capabilityPlan).toMatchObject({ protocolVersion: 1,
      selected: [{ id: "ts-code", kind: "skill", version: "v1" }], estimatedCostMicros: 2 });
    expect(JSON.stringify(received)).not.toContain("remainingBudgetMicros");
    expect(JSON.stringify(received)).not.toContain("authorized");
    expect(JSON.stringify(received)).not.toContain("forged");
  });

  it("preserves strict manual selections through the process boundary", async () => {
    const cwd = await directory();
    const driver = new ProcessChefDriver({ provider: "codex", command: process.execPath,
      args: ["-e", echoScript], allowedRoots: [cwd], capabilityRuntime: runtime() });
    const input = request(cwd);
    input.capabilitySelection = { ...selection, mode: "manual", selectedIds: ["ts-code"] };
    const result = await driver.run(input);
    expect(result.status).toBe("completed");
    expect(result.capabilityReceipt?.appliedIds).toEqual(["ts-code"]);
    expect(result.metadata).toMatchObject({ received: { capabilitySelection: { mode: "manual" } } });
  });

  it("binds acknowledgments to the current worker generation", async () => {
    const cwd = await directory();
    const driver = new ProcessChefDriver({ provider: "codex", command: process.execPath,
      args: ["-e", echoScript], allowedRoots: [cwd], capabilityRuntime: runtime() });
    const first = await driver.run(request(cwd));
    const second = await driver.run({ ...request(cwd), attempt: 2, fencingToken: 2 });
    expect(first.capabilityReceipt?.selectionHash).not.toBe(second.capabilityReceipt?.selectionHash);
    expect(second.metadata).toMatchObject({ received: { capabilityPlan: { execution: {
      workerId: "w1", attempt: 2, fencingToken: 2,
    } } } });
  });

  it.each(["missing runtime", "stale snapshot", "wrong task", "resolver failure", "unavailable manual choice"])(
    "blocks %s with zero usage and no process side effect", async (scenario) => {
      const cwd = await directory();
      const marker = join(cwd, "started");
      const config = runtime();
      if (scenario === "stale snapshot") config.now = () => now + 10_000;
      if (scenario === "wrong task") config.resolveContext = () => ({ ...contexts(), binding: { ...binding, taskId: "other" } });
      if (scenario === "resolver failure") config.resolveContext = () => { throw new Error("secret-token-private"); };
      const driver = new ProcessChefDriver({ provider: "codex", command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
        allowedRoots: [cwd], capabilityRuntime: scenario === "missing runtime" ? undefined : config });
      const input = request(cwd);
      if (scenario === "unavailable manual choice") input.capabilitySelection = {
        ...selection, mode: "manual", selectedIds: ["missing"],
      };
      const result = await driver.run(input);
      expect(result.status).toBe("blocked_external");
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, costMicros: 0 });
      expect(JSON.stringify(result)).not.toContain("secret-token-private");
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("bounds an unresponsive resolver and aborts its work", async () => {
    vi.useFakeTimers();
    let resolverSignal: AbortSignal | undefined;
    const prepared = prepareChefCapabilities(selection, binding, { ...runtime(),
      resolveContext: (_binding, signal) => { resolverSignal = signal; return new Promise(() => {}); } });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await prepared).toEqual({ ready: false, reason: "capability_context_unavailable" });
    expect(resolverSignal?.aborted).toBe(true);
  });

  it("cancels resolution immediately even if a resolver ignores AbortSignal", async () => {
    const abort = new AbortController();
    const prepared = prepareChefCapabilities(selection, binding, {
      ...runtime(), resolveContext: () => new Promise(() => {}),
    }, abort.signal);
    await Promise.resolve();
    abort.abort();
    expect(await prepared).toEqual({ ready: false, reason: "cancelled" });
  });

  it("rechecks freshness after async resolution", async () => {
    const config = runtime();
    config.resolveContext = async () => { config.now = () => now + 10_000; return contexts(); };
    expect((await prepareChefCapabilities(selection, binding, config)).ready).toBe(false);
  });

  it("blocks a missing adapter receipt after execution without inventing zero usage or repeating work", async () => {
    const cwd = await directory();
    const marker = join(cwd, "calls");
    const script = `require('node:fs').appendFileSync(${JSON.stringify(marker)},'x');
      console.log(JSON.stringify({schemaVersion:1,status:'completed',summary:'ok',
        usage:{inputTokens:10,outputTokens:2,costMicros:7}}))`;
    const driver = new ProcessChefDriver({ provider: "codex", command: process.execPath,
      args: ["-e", script], allowedRoots: [cwd], capabilityRuntime: runtime() });
    const result = await driver.run(request(cwd));
    expect(result.status).toBe("blocked_external");
    expect(result.usage?.costMicros).toBe(7);
    expect(await readFile(marker, "utf8")).toBe("x");
  });

  it("runs independent process requests without sharing their chosen capabilities", async () => {
    const cwd = await directory();
    const driver = new ProcessChefDriver({ provider: "codex", command: process.execPath,
      args: ["-e", echoScript], allowedRoots: [cwd], capabilityRuntime: {
        ...runtime(), resolveContext: taskBinding => ({ ...contexts(), binding: taskBinding }),
      } });
    const first = request(cwd);
    const second = { ...request(cwd), taskId: "t2", capabilitySelection: { ...selection, needs: [] } };
    const [a, b] = await Promise.all([driver.run(first), driver.run(second)]);
    expect(a.capabilityReceipt?.appliedIds).toEqual(["ts-code"]);
    expect(b.capabilityReceipt?.appliedIds).toEqual([]);
    expect(a.capabilityReceipt?.selectionHash).not.toBe(b.capabilityReceipt?.selectionHash);
  });

  it.each(["process.exit(1)", "console.log('logs only')", "console.log(JSON.stringify({schemaVersion:1,status:'completed',summary:''}))"])(
    "does not retry an uncertain capability process: %s", async (failure) => {
      const cwd = await directory();
      const marker = join(cwd, "calls");
      const script = `require('node:fs').appendFileSync(${JSON.stringify(marker)},'x');${failure}`;
      const driver = new ProcessChefDriver({ provider: "codex", command: process.execPath,
        args: ["-e", script], allowedRoots: [cwd], capabilityRuntime: runtime() });
      const input = request(cwd);
      const transitions: string[] = [];
      const recordUsage = vi.fn(async () => true);
      const control: ChefControlPlane = {
        heartbeat: async () => {}, claimNext: async () => ({ ...input, id: input.taskId,
          verificationProfiles: ["test"] }), renewLease: async () => true,
        transition: async change => { transitions.push(change.target); return true; },
        addEvidence: async () => true, recordUsage, tryFinishMission: async () => true,
      };
      const outcome = await runChefWorkerCycle(control, driver, { verify: vi.fn() }, {
        missionId: input.missionId, workerId: input.workerId, provider: input.provider,
      });
      expect(outcome.state).toBe("blocked_external");
      expect(transitions).toEqual(["running", "blocked_external"]);
      expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ costMicros: null, inputTokens: null }));
      expect(await readFile(marker, "utf8")).toBe("x");
    },
  );

  it("keeps an interrupted capability task blocked even when shutdown is requested", async () => {
    const abort = new AbortController();
    const input = request(process.cwd());
    const transitions: string[] = [];
    const control: ChefControlPlane = {
      heartbeat: async () => {}, claimNext: async () => ({ ...input, id: input.taskId, verificationProfiles: ["test"] }),
      renewLease: async () => true, transition: async change => { transitions.push(change.target); return true; },
      addEvidence: async () => true, recordUsage: async () => true, tryFinishMission: async () => true,
    };
    const outcome = await runChefWorkerCycle(control, { provider: "codex", run: async received => {
      expect(received.capabilitySelection).toEqual(selection);
      abort.abort();
      return { schemaVersion: 1, status: "blocked_external", summary: "Effet incertain" };
    } }, { verify: vi.fn() }, {
      missionId: input.missionId, workerId: input.workerId, provider: input.provider, signal: abort.signal,
    });
    expect(outcome.state).toBe("blocked_external");
    expect(transitions).toEqual(["running", "blocked_external"]);
  });

  it.each(["verification failed", "verification threw", "shutdown during usage", "missing commit"])(
    "does not replay a completed adapter after %s", async (scenario) => {
      const cwd = await directory();
      const abort = new AbortController();
      const input = request(cwd);
      if (scenario === "missing commit") {
        execFileSync("git", ["init", "--quiet", cwd]);
        execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "baseline"], { cwd });
        input.accessMode = "write"; input.allowedPaths = ["."];
      }
      const driver = new ProcessChefDriver({ provider: "codex", command: process.execPath,
        args: ["-e", echoScript], allowedRoots: [cwd], capabilityRuntime: runtime() });
      const transitions: string[] = [];
      const control: ChefControlPlane = {
        heartbeat: async () => {}, claimNext: async () => ({ ...input, id: input.taskId, verificationProfiles: ["test"] }),
        renewLease: async () => true, transition: async change => { transitions.push(change.target); return true; },
        addEvidence: async () => true, recordUsage: async () => {
          if (scenario === "shutdown during usage") abort.abort();
          return true;
        }, tryFinishMission: async () => true,
      };
      const outcome = await runChefWorkerCycle(control, driver, { verify: async () => {
        if (scenario === "verification threw") throw new Error("Verifier interrupted");
        return { ok: false, error: "Test failed", evidence: [] };
      } }, { missionId: input.missionId, workerId: input.workerId, provider: input.provider, signal: abort.signal });
      expect(outcome.state).toBe("blocked_external");
      expect(transitions).not.toContain("retryable");
      expect(transitions.at(-1)).toBe("blocked_external");
    },
  );

  it("rejects partial, extra and duplicated acknowledgment IDs", () => {
    const plan = { protocolVersion: 1 as const, selectionHash: "h", estimatedCostMicros: 0,
      selected: [{ id: "a", kind: "skill" as const, version: "1" }, { id: "b", kind: "skill" as const, version: "1" }] };
    expect(hasChefCapabilityReceipt({ selectionHash: "h", appliedIds: ["b", "a"] }, plan)).toBe(true);
    for (const ids of [["a"], ["a", "a"], ["a", "b", "c"], ["a", "c"]]) {
      expect(hasChefCapabilityReceipt({ selectionHash: "h", appliedIds: ids }, plan)).toBe(false);
    }
    expect(hasChefCapabilityReceipt({ selectionHash: "other", appliedIds: ["a", "b"] }, plan)).toBe(false);
  });
});

describe("operator-managed capability snapshots", () => {
  it("reads only the exact bound context and sees revocation on the next request", async () => {
    const cwd = await directory();
    const path = join(cwd, "contexts.json");
    const config = runtime();
    config.resolveContext = createFileChefCapabilityResolver(path);
    await writeFile(path, JSON.stringify({ schemaVersion: 1, contexts: [contexts()] }));
    expect((await prepareChefCapabilities(selection, binding, config)).ready).toBe(true);
    const revoked = contexts(); revoked.capabilities[0].authorized = false;
    await writeFile(path, JSON.stringify({ schemaVersion: 1, contexts: [revoked] }));
    expect((await prepareChefCapabilities(selection, binding, config)).ready).toBe(false);
    expect((await prepareChefCapabilities(selection, { ...binding, missionId: "other" }, config)).ready).toBe(false);
  });

  it("rejects symlinks, oversized files and duplicate bound snapshots", async () => {
    const cwd = await directory();
    const target = join(cwd, "contexts.json"), link = join(cwd, "link.json");
    await writeFile(target, JSON.stringify({ schemaVersion: 1, contexts: [contexts(), contexts()] }));
    const signal = new AbortController().signal;
    await expect(createFileChefCapabilityResolver(target)(binding, signal)).rejects.toThrow(/ambigu/);
    await symlink(target, link);
    await expect(createFileChefCapabilityResolver(link)(binding, signal)).rejects.toThrow();
    await writeFile(target, " ".repeat(1024 * 1024 + 1));
    await expect(createFileChefCapabilityResolver(target)(binding, signal)).rejects.toThrow(/volumineux/);
  });

  it("rejects a FIFO without waiting for a writer", async () => {
    const cwd = await directory();
    const path = join(cwd, "pipe");
    execFileSync("mkfifo", [path]);
    await expect(createFileChefCapabilityResolver(path)(binding, new AbortController().signal)).rejects.toThrow();
  });
});
