import { describe, expect, it, vi } from "vitest";
import { parseSessionRequest, RobotSessionError } from "../src/robotics/session.js";
import { RobotSessionSimulator } from "../src/robotics/simulator.js";
import { robotCatalogTool } from "../src/tools/robotics.js";
import { resolveCustomAgentTools } from "../src/tools/customRegistry.js";

const NOW = 1_800_000_000_000;
const request = () => ({
  version: 1, sessionId: "audit", targetId: "purama-simulator", expiresAt: NOW + 60_000,
  steps: [{ id: "one", kind: "pause", durationMs: 1 }],
});
const context = () => ({ userId: "owner", mode: "live" as const, agentType: "custom:robotics" as const });

describe("robotics audit — adversarial inputs and isolation", () => {
  it("rejects sparse step arrays instead of approving an empty timeline", () => {
    expect(() => parseSessionRequest({ ...request(), steps: new Array(1) }, NOW)).toThrow(RobotSessionError);
  });
  it("does not execute accessors while validating a purported JSON object", () => {
    const getter = vi.fn(() => "purama-simulator");
    const input = Object.defineProperty(request(), "targetId", { get: getter, enumerable: true });
    expect(() => parseSessionRequest(input, NOW)).toThrow(RobotSessionError);
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects symbol fields rather than silently discarding them", () => {
    expect(() => parseSessionRequest({ ...request(), [Symbol("command")]: "motor" }, NOW)).toThrow(RobotSessionError);
  });
  it("does not accept non-JSON catalog requests", async () => {
    await expect(robotCatalogTool.execute(new Date() as unknown as Record<string, unknown>, context())).rejects.toBeInstanceOf(RobotSessionError);
  });
  it("returns a domain error for malformed ownership", async () => {
    const invalid = { ...context(), userId: 17 } as unknown as ReturnType<typeof context>;
    await expect(robotCatalogTool.execute({}, invalid)).rejects.toBeInstanceOf(RobotSessionError);
    await expect(new RobotSessionSimulator(() => NOW).run(request(), null as unknown as ReturnType<typeof context>))
      .rejects.toBeInstanceOf(RobotSessionError);
  });
  it("captures ownership before yielding, so caller mutation cannot strand a lock", async () => {
    const simulator = new RobotSessionSimulator(() => NOW);
    const mutableContext = context();
    const pending = simulator.run(request(), mutableContext);
    mutableContext.userId = "other-owner";
    await pending;
    await expect(simulator.run({ ...request(), sessionId: "second" }, context())).resolves.toMatchObject({ ok: true });
  });
  it.each([NaN, Infinity, NOW - 1])("fails closed if the execution clock becomes invalid (%s)", async (clockValue) => {
    let now = NOW;
    const simulator = new RobotSessionSimulator(() => now);
    const pending = simulator.run(request(), context());
    now = clockValue;
    await expect(pending).rejects.toMatchObject({ code: "INVALID_CLOCK" });
    now = NOW;
    await expect(simulator.run({ ...request(), sessionId: "recovered" }, context())).resolves.toMatchObject({ ok: true });
  });
  it("does not resolve inherited Object properties as executable tools", () => {
    expect(resolveCustomAgentTools(["__proto__", "constructor", "toString", "robot_catalog"]).map((tool) => tool.name))
      .toEqual(["robot_catalog"]);
  });
  it("deduplicates configured tools before sending them to a provider", () => {
    expect(resolveCustomAgentTools(["robot_catalog", "robot_catalog"]).map((tool) => tool.name)).toEqual(["robot_catalog"]);
  });
  it("tolerates a malformed stored allowlist without interpreting it as tools", () => {
    expect(resolveCustomAgentTools("robot_catalog" as unknown as string[])).toEqual([]);
    expect(resolveCustomAgentTools([null, 1, {}, "robot_catalog"] as unknown as string[]).map((tool) => tool.name))
      .toEqual(["robot_catalog"]);
  });
});
