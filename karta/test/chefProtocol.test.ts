import { describe, expect, it } from "vitest";
import { acceptWorkerReport, validateWorkerReport, type ChefWorkerReport } from "../src/chef/protocol.js";

function report(overrides: Partial<ChefWorkerReport> = {}): ChefWorkerReport {
  return {
    schemaVersion: 1,
    workerId: "worker-1",
    provider: "codex",
    state: "running",
    sequence: 1,
    timestamp: "2026-09-27T12:00:00.000Z",
    taskId: "task-1",
    fencingToken: 3,
    headSha: "a".repeat(40),
    progress: { phase: "implementation", completed: 3, total: 10 },
    ...overrides,
  };
}

describe("CHEF worker protocol", () => {
  it("accepte un rapport actif complet", () => {
    expect(() => validateWorkerReport(report())).not.toThrow();
  });

  it("refuse un worker actif sans identité de tâche/fencing", () => {
    expect(() => validateWorkerReport(report({ taskId: undefined }))).toThrow(/taskId/);
    expect(() => validateWorkerReport(report({ fencingToken: undefined }))).toThrow(/fencingToken/);
  });

  it("refuse les événements dupliqués ou arrivés dans le désordre", () => {
    expect(() => acceptWorkerReport(10, report({ sequence: 10 }))).toThrow(/désordre/);
    expect(() => acceptWorkerReport(10, report({ sequence: 9 }))).toThrow(/désordre/);
    expect(() => acceptWorkerReport(10, report({ sequence: 11 }))).not.toThrow();
  });

  it("refuse les faux SHA et les progressions impossibles", () => {
    expect(() => validateWorkerReport(report({ headSha: "not-a-sha" }))).toThrow(/headSha/);
    expect(() => validateWorkerReport(report({
      progress: { phase: "test", completed: 11, total: 10 },
    }))).toThrow(/progress/);
  });

  it("autorise un heartbeat idle sans tâche", () => {
    expect(() => validateWorkerReport(report({
      state: "idle",
      taskId: undefined,
      fencingToken: undefined,
      progress: undefined,
    }))).not.toThrow();
  });
});
