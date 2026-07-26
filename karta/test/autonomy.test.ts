import { describe, expect, it } from "vitest";
import { isRunnable, requiresHumanApproval } from "../src/engine/autonomy.js";
import type { AgentState } from "../src/engine/types.js";

function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userId: "u1",
    agentType: "email",
    isEnabled: true,
    autonomyLevel: 1,
    killSwitch: false,
    simulationMode: false,
    ...overrides,
  };
}

describe("requiresHumanApproval", () => {
  it("exige toujours validation en mode simulation, même niveau 3", () => {
    expect(requiresHumanApproval(state({ simulationMode: true, autonomyLevel: 3 }), false)).toBe(true);
  });

  it("niveau 1 exige toujours validation, même outil non sensible", () => {
    expect(requiresHumanApproval(state({ autonomyLevel: 1 }), false)).toBe(true);
  });

  it("niveau 2 exige validation uniquement pour un outil sensible", () => {
    expect(requiresHumanApproval(state({ autonomyLevel: 2 }), true)).toBe(true);
    expect(requiresHumanApproval(state({ autonomyLevel: 2 }), false)).toBe(false);
  });

  it("niveau 3 n'exige jamais validation (hors simulation)", () => {
    expect(requiresHumanApproval(state({ autonomyLevel: 3 }), true)).toBe(false);
    expect(requiresHumanApproval(state({ autonomyLevel: 3 }), false)).toBe(false);
  });
});

describe("isRunnable", () => {
  it("bloque si kill switch actif, même si enabled", () => {
    const result = isRunnable(state({ killSwitch: true, isEnabled: true }));
    expect(result.ok).toBe(false);
  });

  it("bloque si agent désactivé", () => {
    const result = isRunnable(state({ isEnabled: false }));
    expect(result.ok).toBe(false);
  });

  it("autorise si activé et kill switch inactif", () => {
    expect(isRunnable(state({ isEnabled: true, killSwitch: false })).ok).toBe(true);
  });
});
