import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentType } from "../src/engine/types.js";

/**
 * Faux client Supabase qui simule fidèlement le comportement SQL d'un UPDATE avec garde CAS.
 * L'ordre d'exécution réel des UPDATEs concurrents est sérialisé via un compteur interne.
 */
class FakeSupabaseClient {
  private store = new Map<string, unknown>();
  private callOrder = 0;

  seed(key: string, value: unknown) {
    this.store.set(key, value);
  }

  delete(key: string) {
    this.store.delete(key);
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
                  eq(_col3: string, val3: string) {
                    return {
                      async maybeSingle() {
                        const key = `${val1}:${val2}:${val3}`;
                        const value = self.store.get(key);
                        return { data: value !== undefined ? { memory_value: value } : null, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
      update(payload: { memory_value: unknown; updated_at: string }) {
        return {
          eq(_col1: string, val1: string) {
            return {
              eq(_col2: string, val2: string) {
                return {
                  eq(_col3: string, val3: string) {
                    return {
                      eq(_col4: string, val4: unknown) {
                        return {
                          async select() {
                            // Sérialise les UPDATEs concurrents via un compteur
                            self.callOrder++;
                            const key = `${val1}:${val2}:${val3}`;
                            const currentValue = self.store.get(key);

                            // Garde CAS : UPDATE réussit SEULEMENT si la valeur actuelle === val4
                            if (currentValue === val4) {
                              self.store.set(key, payload.memory_value);
                              return { data: [{ memory_value: currentValue }], error: null };
                            } else {
                              // La valeur a changé entre-temps → UPDATE ne touche aucune ligne
                              return { data: [], error: null };
                            }
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
  }
}

const fakeClient = new FakeSupabaseClient();

// Mock du module supabase AVANT tout import (pattern standard Vitest)
vi.mock("../src/db/supabase.js", () => ({
  supabase: fakeClient,
}));

// Import dynamique APRÈS le mock
const { consumeBrief } = await import("../src/engine/memory.js");

describe("consumeBrief — exactly-once semantics via CAS", () => {
  beforeEach(() => {
    // Reset le store avant chaque test
    fakeClient["store"].clear();
    fakeClient["callOrder"] = 0;
  });

  it("deux consommateurs concurrents : exactement un reçoit le brief, l'autre null", async () => {
    fakeClient.seed("user123:email:pending_brief", "Envoie une newsletter sur l'IA");

    // Simule deux appels concurrents sur la même clé
    const [result1, result2] = await Promise.all([
      consumeBrief("user123", "email" as AgentType, "pending_brief"),
      consumeBrief("user123", "email" as AgentType, "pending_brief"),
    ]);

    // Exactement UN doit recevoir le brief, l'autre null (ordre indéterminé mais stable)
    const results = [result1, result2].sort((a, b) => {
      if (a === null) return -1;
      if (b === null) return 1;
      return 0;
    });

    expect(results).toEqual([null, "Envoie une newsletter sur l'IA"]);

    // Vérifier que la valeur est bien clearée dans le store après
    const finalValue = fakeClient["store"].get("user123:email:pending_brief");
    expect(finalValue).toBeNull();
  });

  it("retourne null si le brief est vide ou absent", async () => {
    fakeClient.seed("user123:email:pending_brief", "");
    expect(await consumeBrief("user123", "email" as AgentType, "pending_brief")).toBeNull();

    fakeClient.seed("user123:email:pending_brief", "   ");
    expect(await consumeBrief("user123", "email" as AgentType, "pending_brief")).toBeNull();

    fakeClient.delete("user123:email:pending_brief");
    expect(await consumeBrief("user123", "email" as AgentType, "pending_brief")).toBeNull();
  });
});
