import { describe, expect, it, beforeEach, vi } from "vitest";
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

/**
 * Faux client Supabase qui simule la contrainte UNIQUE(user_id, agent_type) sur karta_agent_state.
 * Le 2e INSERT concurrent échoue avec code 23505, déclenchant le re-SELECT de convergence.
 */
class FakeSupabaseClient {
  store = new Map<string, { is_enabled: boolean; autonomy_level: number; kill_switch: boolean; simulation_mode: boolean }>();
  insertCount = 0;

  seed(key: string, row: { is_enabled: boolean; autonomy_level: number; kill_switch: boolean; simulation_mode: boolean }) {
    this.store.set(key, row);
  }

  from(_table: string) {
    const self = this;
    return {
      select(_cols: string) {
        return {
          eq(_col1: string, val1: string) {
            return {
              eq(_col2: string, val2: string) {
                return {
                  async maybeSingle() {
                    const key = `${val1}:${val2}`;
                    const row = self.store.get(key);
                    return { data: row ?? null, error: null };
                  },
                  async single() {
                    const key = `${val1}:${val2}`;
                    const row = self.store.get(key);
                    if (!row) return { data: null, error: { message: "ligne absente" } };
                    return { data: row, error: null };
                  },
                };
              },
            };
          },
        };
      },
      insert(payload: { user_id: string; agent_type: string }) {
        return {
          select() {
            return {
              async single() {
                const key = `${payload.user_id}:${payload.agent_type}`;
                self.insertCount++;

                // Simule la contrainte UNIQUE : le 1er INSERT gagne, les suivants échouent avec 23505
                if (self.store.has(key)) {
                  return { data: null, error: { code: "23505", message: "duplicate key violation" } };
                }

                // Valeurs par défaut (simulées, cohérentes avec la migration)
                const row = { is_enabled: true, autonomy_level: 1, kill_switch: false, simulation_mode: true };
                self.store.set(key, row);
                return { data: row, error: null };
              },
            };
          },
        };
      },
    };
  }
}

// Créer fakeClient DANS la factory du mock pour éviter le hoisting issue
let fakeClient: FakeSupabaseClient;

// Mock du module supabase AVANT tout import (pattern standard Vitest)
vi.mock("../src/db/supabase.js", () => {
  fakeClient = new FakeSupabaseClient();
  return { supabase: fakeClient };
});

// Import dynamique APRÈS le mock
const { isRunnable, requiresHumanApproval, loadAgentState } = await import("../src/engine/autonomy.js");

describe("loadAgentState — convergence race-safe sur INSERT concurrent", () => {
  beforeEach(() => {
    // Reset le store avant chaque test
    fakeClient.store.clear();
    fakeClient.insertCount = 0;
  });
  it("deux appels concurrents convergent vers le même état (catch 23505 + re-SELECT)", async () => {
    // Simule deux appels concurrents qui voient tous les deux data=null
    const [state1, state2] = await Promise.all([
      loadAgentState("user456", "email"),
      loadAgentState("user456", "email"),
    ]);

    // Les deux doivent converger vers le même état (valeurs par défaut : niveau 1, simulation true)
    expect(state1).toEqual({
      userId: "user456",
      agentType: "email",
      isEnabled: true,
      autonomyLevel: 1,
      killSwitch: false,
      simulationMode: true,
    });

    expect(state2).toEqual(state1); // convergence stricte

    // Vérifier qu'une seule ligne a été créée dans le store
    const finalRow = fakeClient["store"].get("user456:email");
    expect(finalRow).toEqual({ is_enabled: true, autonomy_level: 1, kill_switch: false, simulation_mode: true });
  });

  it("retourne l'état existant si la ligne est déjà présente (pas de race)", async () => {
    // Pré-créer une ligne avec des valeurs custom
    fakeClient.seed("user789:newsletter", {
      is_enabled: false,
      autonomy_level: 3,
      kill_switch: true,
      simulation_mode: false,
    });

    const state = await loadAgentState("user789", "newsletter" as any);
    expect(state).toEqual({
      userId: "user789",
      agentType: "newsletter",
      isEnabled: false,
      autonomyLevel: 3,
      killSwitch: true,
      simulationMode: false,
    });
  });
});
