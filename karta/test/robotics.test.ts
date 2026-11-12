import { afterEach, describe, expect, it, vi } from "vitest";
import { getRobotTarget, listRobotTargets } from "../src/robotics/catalog.js";
import { parseSessionRequest, planRobotSession, RobotSessionError } from "../src/robotics/session.js";
import { RobotSessionSimulator } from "../src/robotics/simulator.js";

const NOW = 1_800_000_000_000;
const owner = { userId: "owner-a", mode: "simulation" as const };
function session(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, sessionId: "presence", targetId: "purama-simulator", expiresAt: NOW + 60_000,
    steps: [
      { id: "welcome", kind: "speech", text: "Bienvenue. Vous pouvez arrêter la séance.", durationMs: 2_000 },
      { id: "greet", kind: "gesture", gesture: "greeting", durationMs: 1_000, required: false },
      { id: "rest", kind: "pause", durationMs: 3_000 },
    ],
    ...overrides,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("robotics — truthful catalog and strict session contract", () => {
  it("never promotes a researched robot to installed hardware", () => {
    const targets = listRobotTargets();
    expect(targets.filter((target) => target.stage !== "simulator")).toHaveLength(11);
    expect(new Set(targets.map((target) => target.id)).size).toBe(targets.length);
    for (const target of targets) {
      expect(target.hardwareControlAvailable).toBe(false);
      if (target.stage === "simulator") continue;
      const plan = planRobotSession(session({ targetId: target.id }), NOW);
      expect(plan).toMatchObject({ ok: false, status: "blocked", execution: "not_executed" });
      expect(plan.blockers[0].code).toBe("CONNECTOR_NOT_IMPLEMENTED");
      expect(target.hardwareValidation).toBe("not_tested");
      expect(target.sources.length).toBeGreaterThan(0);
    }
  });

  it("does not let callers mutate the capability catalog", () => {
    const target = getRobotTarget("tesla-optimus")!;
    target.stage = "simulator";
    target.sources.length = 0;
    listRobotTargets().length = 0;
    expect(getRobotTarget("tesla-optimus")?.stage).toBe("target");
    expect(getRobotTarget("tesla-optimus")?.sources.length).toBeGreaterThan(0);
    expect(planRobotSession(session({ targetId: "tesla-optimus" }), NOW).ok).toBe(false);
  });

  it("rejects unknown models instead of silently falling back to simulation", () => {
    const plan = planRobotSession(session({ targetId: "invented-robot" }), NOW);
    expect(plan.ok).toBe(false);
    expect(plan.blockers[0].code).toBe("UNKNOWN_TARGET");
  });

  it("builds a logical timeline without claiming playback or motor execution", () => {
    const request = parseSessionRequest(session(), NOW);
    expect(request.steps.map((step) => step.required)).toEqual([true, false, true]);
    const plan = planRobotSession(request, NOW);
    expect(plan).toMatchObject({ ok: true, execution: "not_executed", status: "simulation_ready", totalDurationMs: 6_000 });
    expect(plan.steps.map((step) => [step.startsAtMs, step.endsAtMs])).toEqual([[0, 2_000], [2_000, 3_000], [3_000, 6_000]]);
  });

  it.each(["userId", "mode", "endpoint", "firmware", "command"])("rejects injected %s instead of treating it as authority", (field) => {
    expect(() => parseSessionRequest(session({ [field]: "override" }), NOW)).toThrow(RobotSessionError);
  });

  it.each([NaN, Infinity, NOW, NOW - 1, NOW + 300_001, "tomorrow"])("rejects invalid or stale expiration %s", (expiresAt) => {
    expect(() => parseSessionRequest(session({ expiresAt }), NOW)).toThrow(RobotSessionError);
  });

  it.each([
    null, [], { version: 2 },
    session({ steps: [] }),
    session({ steps: Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, kind: "pause", durationMs: 1 })) }),
    session({ steps: [{ id: "p", kind: "pause", durationMs: 0 }] }),
    session({ steps: [{ id: "p", kind: "pause", durationMs: 0.5 }] }),
    session({ steps: [{ id: "p", kind: "pause", durationMs: 60_001 }] }),
    session({ steps: [{ id: "p", kind: "pause", durationMs: 1, required: "false" }] }),
    session({ steps: [{ id: "p", kind: "speech", durationMs: 1, text: " " }] }),
    session({ steps: [{ id: "p", kind: "speech", durationMs: 1, text: "x".repeat(2_001) }] }),
    session({ steps: [{ id: "p", kind: "speech", durationMs: 1, text: "hello", gesture: "greeting" }] }),
    session({ steps: [{ id: "p", kind: "gesture", durationMs: 1, gesture: "walk" }] }),
    session({ steps: [{ id: "p", kind: "motor", durationMs: 1 }] }),
    session({ steps: [{ id: "p", kind: "pause", durationMs: 1, velocity: 100 }] }),
    session({ steps: [{ id: "p", kind: "pause", durationMs: 1 }, { id: "p", kind: "pause", durationMs: 1 }] }),
    session({ steps: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, kind: "pause", durationMs: 60_000 })) }),
  ])("rejects malformed, excessive, or unsupported instructions %#", (input) => {
    expect(() => parseSessionRequest(input, NOW)).toThrow(RobotSessionError);
  });
});

describe("robotics — isolated software simulator", () => {
  it.each(["simulation", "live"] as const)("stays software-only in a KARTA %s context", async (mode) => {
    const fetch = vi.fn(() => { throw new Error("No network expected"); });
    vi.stubGlobal("fetch", fetch);
    const result = await new RobotSessionSimulator(() => NOW).run(session(), { ...owner, mode });
    expect(result).toMatchObject({ ok: true, execution: "simulation", physicalActions: 0, status: "simulated" });
    expect(result.events).toHaveLength(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses missing ownership and every physical target", async () => {
    const simulator = new RobotSessionSimulator(() => NOW);
    await expect(simulator.run(session(), { ...owner, userId: " " })).rejects.toBeInstanceOf(RobotSessionError);
    for (const target of listRobotTargets().filter((item) => item.stage !== "simulator")) {
      await expect(simulator.run(session({ targetId: target.id }), owner)).rejects.toMatchObject({ code: "NO_HARDWARE_ADAPTER" });
    }
  });

  it("coalesces concurrent retries and returns independent copies", async () => {
    const clock = vi.fn(() => NOW);
    const simulator = new RobotSessionSimulator(clock);
    const [first, second] = await Promise.all([simulator.run(session(), owner), simulator.run(session(), owner)]);
    expect(first).toEqual(second);
    expect(clock).toHaveBeenCalledTimes(5); // two request checks, one pass through three steps
    first.events.length = 0;
    expect(second.events).toHaveLength(3);
    expect((await simulator.run(session(), owner)).events).toHaveLength(3);
    expect(clock).toHaveBeenCalledTimes(6); // replay checks expiration, does not run steps again
    await expect(simulator.run(session({ steps: [{ id: "changed", kind: "pause", durationMs: 1 }] }), owner))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("limits a user's concurrent sessions without blocking another user", async () => {
    const simulator = new RobotSessionSimulator(() => NOW);
    const first = simulator.run(session(), owner);
    const busy = simulator.run(session({ sessionId: "second" }), owner);
    const otherUser = simulator.run(session(), { ...owner, userId: "owner-b" });
    await expect(busy).rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect((await first).ok).toBe(true);
    expect((await otherUser).ok).toBe(true);
    expect((await simulator.run(session({ sessionId: "second" }), owner)).ok).toBe(true);
  });

  it("keeps cancellation sticky for retries and releases the owner", async () => {
    const simulator = new RobotSessionSimulator(() => NOW);
    const controller = new AbortController();
    const pending = simulator.run(session(), owner, controller.signal);
    await Promise.resolve(); // one logical step has run
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: "cancelled", physicalActions: 0 });
    expect(result.events).toHaveLength(1);
    expect(await simulator.run(session(), owner)).toEqual(result);
    expect((await simulator.run(session({ sessionId: "another" }), owner)).ok).toBe(true);
  });

  it("does not start an already cancelled session", async () => {
    const result = await new RobotSessionSimulator(() => NOW).run(session(), owner, AbortSignal.abort());
    expect(result).toMatchObject({ ok: false, status: "cancelled", events: [] });
  });

  it("stops at expiration and recovers bounded cache capacity afterward", async () => {
    let now = NOW;
    const simulator = new RobotSessionSimulator(() => now, 1);
    const pending = simulator.run(session(), owner);
    now = NOW + 60_000;
    expect(await pending).toMatchObject({ ok: false, status: "expired", events: [] });
    const next = session({ sessionId: "next", expiresAt: now + 60_000 });
    expect((await simulator.run(next, owner)).ok).toBe(true);
    await expect(simulator.run({ ...next, sessionId: "full" }, owner)).rejects.toMatchObject({ code: "SIMULATOR_CAPACITY" });
    await expect(simulator.run(session(), owner)).rejects.toMatchObject({ code: "EXPIRED_REQUEST" });
  });
});
