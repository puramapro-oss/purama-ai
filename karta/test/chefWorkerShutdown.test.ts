import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChefWorkerCycleOptions } from "../src/chef/supervisor.js";

const mocks = vi.hoisted(() => ({ cycle: vi.fn() }));
vi.mock("../src/chef/control-plane.js", () => ({ SupabaseChefControlPlane: class {} }));
vi.mock("../src/chef/driver.js", () => ({ ProcessChefDriver: class {} }));
vi.mock("../src/chef/verifier.js", () => ({ CommandChefVerifier: class {} }));
vi.mock("../src/chef/supervisor.js", () => ({ runChefWorkerCycle: mocks.cycle }));

const originalExitCode = process.exitCode;
let originalTermListeners: Set<NodeJS.SignalsListener>;
let originalIntListeners: Set<NodeJS.SignalsListener>;

beforeEach(() => {
  vi.resetModules();
  mocks.cycle.mockReset();
  process.exitCode = undefined;
  originalTermListeners = new Set(process.listeners("SIGTERM"));
  originalIntListeners = new Set(process.listeners("SIGINT"));
  for (const [name, value] of Object.entries({
    CHEF_MISSION_ID: "fixture-mission", CHEF_WORKER_ID: "fixture-worker", CHEF_PROVIDER: "codex",
    CHEF_WORKDIR: process.cwd(), CHEF_REPO: "fixture/repo", CHEF_DRIVER_COMMAND: "never-executed",
    CHEF_VERIFICATION_PROFILES_JSON: '[{"name":"unit","kind":"test","command":"never-executed"}]',
  })) vi.stubEnv(name, value);
});

afterEach(async () => {
  // These are only the handlers installed by this module, never an OS signal.
  for (const handler of process.listeners("SIGTERM")) if (!originalTermListeners.has(handler)) handler("SIGTERM");
  for (const handler of process.listeners("SIGINT")) if (!originalIntListeners.has(handler)) handler("SIGINT");
  await Promise.resolve();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

describe("CHEF daemon shutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)("forwards %s to the active cycle and does not start another one", async (signalName) => {
    let activeSignal: AbortSignal | undefined;
    mocks.cycle.mockImplementation((_control: unknown, _driver: unknown, _verifier: unknown, options: ChefWorkerCycleOptions) => {
      activeSignal = options.signal;
      return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve({ state: "idle" }), { once: true }));
    });
    await import("../src/chef/worker-main.js");
    await vi.waitFor(() => expect(mocks.cycle).toHaveBeenCalledOnce());
    expect(activeSignal).toBeDefined();
    const before = signalName === "SIGTERM" ? originalTermListeners : originalIntListeners;
    const handlers = process.listeners(signalName).filter((handler) => !before.has(handler));
    expect(handlers).toHaveLength(1);
    handlers[0](signalName);
    expect(activeSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(process.listeners(signalName).filter((handler) => !before.has(handler))).toHaveLength(0));
    expect(mocks.cycle).toHaveBeenCalledOnce();
  });

  it("halts after a persisted block for an unconfirmed stop", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.cycle.mockResolvedValue({ state: "blocked_external", taskId: "task", error: "non confirmé", haltWorker: true });
    await import("../src/chef/worker-main.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(3));
    expect(mocks.cycle).toHaveBeenCalledOnce();
  });

  it("halts instead of infrastructure retry when a block could not be persisted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Import after resetModules so instanceof uses the daemon's module instance.
    const { ChefProcessStopUnconfirmedError: RuntimeError } = await import("../src/chef/process.js");
    mocks.cycle.mockRejectedValue(new RuntimeError("blocage durable non enregistré"));
    await import("../src/chef/worker-main.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(3));
    expect(mocks.cycle).toHaveBeenCalledOnce();
  });
});
