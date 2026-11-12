import { describe, expect, it } from "vitest";
import { parseSessionRequest, planRobotSession, RobotSessionError } from "../src/robotics/session.js";

describe("robotics contract — deterministic generated cases", () => {
  it("accepts only bounded, explicit plans across 2000 varied requests", () => {
    const now = 1_800_000_000_000;
    let seed = 0xc0de;
    const next = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    const values: unknown[] = [null, true, false, [], {}, "", "robot", -1, 0, 1, NaN, Infinity, Number.MAX_SAFE_INTEGER,
      now + 60_000, [{ id: "p", kind: "pause", durationMs: 1 }], [{ id: "p", kind: "motor", durationMs: 1 }]];
    const fields = ["version", "sessionId", "targetId", "expiresAt", "steps"];
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 2000; i++) {
      const data: Record<string, unknown> = {
        version: 1, sessionId: `fuzz-${i}`, targetId: "purama-simulator", expiresAt: now + 60_000,
        steps: [{ id: "p", kind: "pause", durationMs: next(60_000) + 1 }],
      };
      if (i % 4 !== 0) data[fields[next(fields.length)]] = values[next(values.length)];
      let normalized;
      try {
        normalized = parseSessionRequest(data, now);
      } catch (error) {
        expect(error).toBeInstanceOf(RobotSessionError);
        rejected++;
        continue;
      }
      accepted++;
      const plan = planRobotSession(normalized, now);
      expect(plan.execution).toBe("not_executed");
      expect(plan.hardwareControlAvailable).toBe(false);
      expect(plan.totalDurationMs).toBeGreaterThan(0);
      expect(plan.totalDurationMs).toBeLessThanOrEqual(300_000);
      expect(plan.steps.every((step) => Number.isSafeInteger(step.startsAtMs) && step.endsAtMs > step.startsAtMs)).toBe(true);
      if (plan.ok) expect(normalized.targetId).toBe("purama-simulator");
    }
    expect(accepted).toBeGreaterThanOrEqual(500);
    expect(rejected).toBeGreaterThan(1000);
  });
});
