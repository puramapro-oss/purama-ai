import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { ProcessChefDriver, type ChefDriverRequest } from "../src/chef/driver.js";
import { CommandChefVerifier } from "../src/chef/verifier.js";

// Observe the process boundary without replacing the child processes. Every
// command below is a local Node fixture with no files, network or provider call.
const processBoundary = vi.hoisted(() => ({
  children: [] as ChildProcess[],
  onSpawn: undefined as ((child: ChildProcess) => void) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn(...args: Parameters<typeof actual.spawn>) {
      const child = actual.spawn(...args);
      processBoundary.children.push(child);
      processBoundary.onSpawn?.(child);
      return child;
    },
  };
});

afterEach(async () => {
  processBoundary.onSpawn = undefined;
  await Promise.all(processBoundary.children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await closed;
  }));
});

function request(): ChefDriverRequest {
  return {
    schemaVersion: 1,
    missionId: "cancel-mission",
    taskId: "cancel-task",
    workerId: "cancel-worker",
    provider: "codex",
    fencingToken: 1,
    attempt: 1,
    briefHash: "a".repeat(64),
    instructions: "Cancellation fixture only",
    cwd: process.cwd(),
    accessMode: "read",
    allowedPaths: [],
  };
}

function driver(script: string): ProcessChefDriver {
  return new ProcessChefDriver({
    provider: "codex",
    command: process.execPath,
    args: ["-e", script],
    allowedRoots: [process.cwd()],
    timeoutMs: 5_000,
    envAllowList: [],
  });
}

function verifier(scripts: string[]): CommandChefVerifier {
  return new CommandChefVerifier(scripts.map((script, index) => ({
    name: `profile-${index}`,
    kind: "test",
    command: process.execPath,
    args: ["-e", script],
    timeoutMs: 5_000,
    envAllowList: [],
  })), [process.cwd()]);
}

async function outcome(promise: Promise<unknown>): Promise<
  { status: "resolved" } | { status: "rejected"; error: unknown }
> {
  try {
    await promise;
    return { status: "resolved" };
  } catch (error) {
    return { status: "rejected", error };
  }
}

function expectCancellation(result: Awaited<ReturnType<typeof outcome>>): void {
  expect.soft(result.status).toBe("rejected");
  if (result.status === "rejected") {
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/annul|abort|cancel/i);
  }
}

// The interval only keeps the fixture alive. Cancellation is synchronized with
// the actual stdout marker, never with an assumed delay or a fake timer.
const runningFixture = "process.stdin.resume(); console.log('CHEF_READY'); setInterval(() => {}, 60_000);";

function abortWhenChildIsReady(controller: AbortController) {
  const lifecycle = { started: false, closed: Promise.resolve() };
  processBoundary.onSpawn = (child) => {
    lifecycle.closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!lifecycle.started && output.includes("CHEF_READY\n")) {
        lifecycle.started = true;
        controller.abort();
      }
    });
  };
  return lifecycle;
}

describe("CHEF cancellation at process and verification boundaries", () => {
  it("does not spawn a worker for a signal already cancelled before run", async () => {
    const controller = new AbortController();
    const privateReason = "FICTIONAL_PRIVATE_WORKER_CANCEL_CONTEXT";
    controller.abort(new Error(privateReason));
    const worker = driver([
      "process.stdin.resume();",
      "process.stdin.on('end', () => console.log(JSON.stringify({schemaVersion:1,status:'completed',summary:'SHOULD_NOT_RUN'})));",
    ].join(""));

    const result = await outcome(worker.run(request(), controller.signal));

    expectCancellation(result);
    if (result.status === "rejected") expect((result.error as Error).message).not.toContain(privateReason);
    expect(processBoundary.children).toHaveLength(0);
  });

  it("does not spawn a verifier or create a success for a signal already cancelled", async () => {
    const controller = new AbortController();
    const privateReason = "FICTIONAL_PRIVATE_VERIFIER_CANCEL_CONTEXT";
    controller.abort(new Error(privateReason));
    const checks = verifier(["console.log('SHOULD_NOT_RUN')"]);

    const result = await outcome(checks.verify(process.cwd(), ["profile-0"], controller.signal));

    expectCancellation(result);
    if (result.status === "rejected") expect((result.error as Error).message).not.toContain(privateReason);
    expect(processBoundary.children).toHaveLength(0);
  });

  it("rejects and terminates a running worker when cancellation arrives", async () => {
    const controller = new AbortController();
    const lifecycle = abortWhenChildIsReady(controller);

    const result = await outcome(driver(runningFixture).run(request(), controller.signal));

    expectCancellation(result);
    expect(lifecycle.started).toBe(true);
    expect(processBoundary.children).toHaveLength(1);
    await lifecycle.closed;
    const child = processBoundary.children[0];
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("rejects and terminates a running verifier without continuing to another profile", async () => {
    const controller = new AbortController();
    const lifecycle = abortWhenChildIsReady(controller);
    const checks = verifier([runningFixture, "console.log('SECOND_PROFILE_MUST_NOT_RUN')"]);

    const result = await outcome(checks.verify(process.cwd(), ["profile-0", "profile-1"], controller.signal));

    expectCancellation(result);
    expect(lifecycle.started).toBe(true);
    expect(processBoundary.children).toHaveLength(1);
    await lifecycle.closed;
    const child = processBoundary.children[0];
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("does not return a completed worker if cancellation arrives before run resumes", async () => {
    const controller = new AbortController();
    processBoundary.onSpawn = (child) => {
      // This close listener follows the driver's own listener. Its internal
      // promise has resolved, but the async run method has not yet resumed.
      child.once("spawn", () => child.once("close", () => controller.abort()));
    };
    const worker = driver([
      "process.stdin.resume();",
      "process.stdin.on('end', () => console.log(JSON.stringify({schemaVersion:1,status:'completed',summary:'WORKER_FINISHED'})));",
    ].join(""));

    const result = await outcome(worker.run(request(), controller.signal));

    expect(controller.signal.aborted).toBe(true);
    expectCancellation(result);
    expect(processBoundary.children).toHaveLength(1);
    expect(processBoundary.children[0].exitCode).toBe(0);
  });

  it("does not publish overall success if cancellation arrives after the final profile closes", async () => {
    const controller = new AbortController();
    processBoundary.onSpawn = (child) => {
      // There is no later profile whose preflight could catch this signal.
      child.once("spawn", () => child.once("close", () => controller.abort()));
    };
    const checks = verifier(["console.log('FINAL_PROFILE_PASS')"]);

    const result = await outcome(checks.verify(process.cwd(), ["profile-0"], controller.signal));

    expect(controller.signal.aborted).toBe(true);
    expectCancellation(result);
    expect(processBoundary.children).toHaveLength(1);
    expect(processBoundary.children[0].exitCode).toBe(0);
  });

  it("rechecks cancellation after a successful profile before spawning the next one", async () => {
    const controller = new AbortController();
    processBoundary.onSpawn = (child) => {
      if (processBoundary.children.length !== 1) return;
      // Register after the verifier's close listener, using the real spawn
      // event. The first result is settled, then cancellation arrives before
      // the async verification loop can advance to its next profile.
      child.once("spawn", () => child.once("close", () => controller.abort()));
    };
    const checks = verifier(["console.log('FIRST_PROFILE_PASS')", "console.log('SECOND_PROFILE_MUST_NOT_RUN')"]);

    const result = await outcome(checks.verify(process.cwd(), ["profile-0", "profile-1"], controller.signal));

    expect(controller.signal.aborted).toBe(true);
    expectCancellation(result);
    expect(processBoundary.children).toHaveLength(1);
  });
});
