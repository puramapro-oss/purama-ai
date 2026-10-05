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
      delete() {
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
                            // Sérialise les DELETEs concurrents via un compteur
                            self.callOrder++;
                            const key = `${val1}:${val2}:${val3}`;
                            const currentValue = self.store.get(key);

                            // Garde CAS : réplique la comparaison JSONB réelle de Postgres —
                            // JSON.stringify(currentValue) vs val4 (déjà JSON.stringify(value)
                            // côté appelant), jamais une égalité JS brute sur la valeur stockée.
                            // Vérifié empiriquement contre un vrai Postgres+PostgREST (review
                            // indépendante 2026-10-05) : comparer la valeur JS brute masquait un
                            // vrai bug de production (texte libre → erreur JSON ; valeur
                            // "JSON-like" → 0 ligne silencieux).
                            if (currentValue !== undefined && JSON.stringify(currentValue) === val4) {
                              // DELETE réel : la ligne disparaît (pas de passage à `null`, qui
                              // violerait memory_value JSONB NOT NULL en vrai Postgres).
                              self.store.delete(key);
                              return { data: [{ memory_value: currentValue }], error: null };
                            } else {
                              // La valeur a changé/disparu entre-temps → DELETE ne touche aucune ligne
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

    // Vérifier que la ligne est bien SUPPRIMÉE du store après (pas mise à `null` : violerait
    // memory_value JSONB NOT NULL en vrai Postgres — vérifié empiriquement le 2026-10-05).
    const finalValue = fakeClient["store"].get("user123:email:pending_brief");
    expect(finalValue).toBeUndefined();
  });

  it("retourne null si le brief est vide ou absent", async () => {
    fakeClient.seed("user123:email:pending_brief", "");
    expect(await consumeBrief("user123", "email" as AgentType, "pending_brief")).toBeNull();

    fakeClient.seed("user123:email:pending_brief", "   ");
    expect(await consumeBrief("user123", "email" as AgentType, "pending_brief")).toBeNull();

    fakeClient.delete("user123:email:pending_brief");
    expect(await consumeBrief("user123", "email" as AgentType, "pending_brief")).toBeNull();
  });

  // Cas bordure trouvés par la review indépendante (2026-10-05), reproduits ici avec un faux
  // client fidèle à la comparaison JSONB réelle (voir commentaire dans le faux client ci-dessus).
  // Vérifiés aussi empiriquement contre un vrai Postgres + vrai PostgREST (pas seulement ce mock).

  it("consomme un brief qui ressemble à un littéral JSON (nombre/bool) sans faux-négatif", async () => {
    fakeClient.seed("user123:email:pending_brief", "123");
    expect(await consumeBrief("user123", "email" as AgentType, "pending_brief")).toBe("123");
    expect(fakeClient["store"].get("user123:email:pending_brief")).toBeUndefined();

    fakeClient.seed("user123:email:pending_brief", "true");
    expect(await consumeBrief("user123", "email" as AgentType, "pending_brief")).toBe("true");
  });

  it("consomme un brief contenant guillemets/apostrophes/virgule/caractères spéciaux", async () => {
    const value = 'Dis "bonjour", l\'ami — 100% sûr';
    fakeClient.seed("user123:email:pending_brief", value);
    expect(await consumeBrief("user123", "email" as AgentType, "pending_brief")).toBe(value);
    expect(fakeClient["store"].get("user123:email:pending_brief")).toBeUndefined();
  });

  it("deux consommateurs concurrents sur une valeur JSON-like : exactement un gagne (pas de faux-négatif double)", async () => {
    fakeClient.seed("user123:email:pending_brief", "123");

    const [result1, result2] = await Promise.all([
      consumeBrief("user123", "email" as AgentType, "pending_brief"),
      consumeBrief("user123", "email" as AgentType, "pending_brief"),
    ]);

    const results = [result1, result2].sort((a, b) => (a === null ? -1 : b === null ? 1 : 0));
    expect(results).toEqual([null, "123"]);
  });
});
