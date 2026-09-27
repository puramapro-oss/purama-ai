import { describe, expect, it, vi, beforeEach } from "vitest";

const state = {
  pending: null as Record<string, unknown> | null,
  /** Filtres eq/lt + patch capturés par le DERNIER update karta_pending_actions. */
  lastUpdateFilters: null as { eq: Array<[string, unknown]>; lt: Array<[string, unknown]> } | null,
  lastUpdatePatch: null as Record<string, unknown> | null,
  /** Résultat du bulk update de reconcileOrphanPendingActions (erreur DB simulée si non-null). */
  reconcileIds: [] as unknown[],
  reconcileError: null as unknown,
  run: null as Record<string, unknown> | null,
  remainingPending: 0,
};

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === "karta_pending_actions") {
        // Chaînes possibles : CLAIM (update→eq→eq→select→maybeSingle), FINALIZE (update→eq,
        // awaitée), FALLBACK (select→eq→maybeSingle), COUNT (select w/ opts.count→eq→then),
        // RECONCILE (update→eq→lt→select, awaitée).
        // Les filtres eq/lt des UPDATE sont CAPTURÉS : sans cela, retirer .eq("status",
        // "processing") de reconcileOrphanPendingActions laissait les tests VERTS (même
        // classe de faux vert que M6 sur logger, fiabilité lab 2026-09-27).
        const updateFilters: { eq: Array<[string, unknown]>; lt: Array<[string, unknown]> } = { eq: [], lt: [] };
        state.lastUpdateFilters = updateFilters;
        return {
          update: vi.fn((patch: Record<string, unknown>) => {
            state.lastUpdatePatch = patch;
            const chain: Record<string, unknown> = {
              eq: vi.fn((col: string, val: unknown) => {
                updateFilters.eq.push([col, val]);
                return chain;
              }),
              lt: vi.fn((col: string, val: unknown) => {
                updateFilters.lt.push([col, val]);
                return chain;
              }),
              select: vi.fn(() => ({
                // CLAIM : update WHERE id+status='pending' RETURNING * — fidèle à PostgREST :
                // l'écriture ne se produit QUE si la ligne est encore 'pending', et le
                // RETURNING reflète la ligne ÉCRITE (status devient 'processing').
                maybeSingle: vi.fn(async () => {
                  if (patch.status === "processing" && state.pending?.status === "pending") {
                    state.pending = { ...state.pending, ...patch };
                    return { data: { ...state.pending }, error: null };
                  }
                  return { data: null, error: null };
                }),
                // RECONCILE : update WHERE status+resolved_at RETURNING id (await direct)
                then: (onResolve: (v: unknown) => unknown) =>
                  Promise.resolve({
                    data: state.reconcileIds,
                    error: state.reconcileError ?? null,
                  }).then(onResolve),
              })),
              then: (onResolve: (v: unknown) => unknown) => {
                // FINALIZE : update WHERE id, awaitée — applique le patch à la ligne.
                if (state.pending) state.pending = { ...state.pending, ...patch };
                return Promise.resolve({ error: null }).then(onResolve);
              },
            };
            return chain;
          }),
          select: vi.fn((_cols?: string, opts?: { count?: string }) => {
            if (opts?.count) {
              return {
                eq: vi.fn().mockReturnThis(),
                then: (resolve: (v: unknown) => unknown) =>
                  Promise.resolve({ count: state.remainingPending, error: null }).then(resolve),
              };
            }
            // FALLBACK : lecture "précise" après claim perdant (id existe ?)
            return {
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn(async () => ({ data: state.pending ? { id: state.pending.id } : null, error: null })),
            };
          }),
        };
      }
      if (table === "karta_runs") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => ({ data: state.run, error: null })),
          update: vi.fn((patch: Record<string, unknown>) => ({
            eq: vi.fn(async () => {
              state.run = { ...state.run, ...patch };
              return { error: null };
            }),
          })),
        };
      }
      throw new Error(`table inattendue dans le test: ${table}`);
    }),
  },
}));

const executeMock = vi.fn();
vi.mock("../src/engine/resolveDefinition.js", () => ({
  resolveAgentDefinition: vi.fn(async () => ({
    type: "compta",
    systemPrompt: "",
    buildContext: async () => ({}),
    tools: [{ name: "supabase_upsert", description: "", sensitive: false, execute: executeMock }],
  })),
}));

// Le verrou de sérialisation des patchs run a ses propres tests (run-lock.test.ts) — ici on
// vérifie seulement que patchParentRun passe bien DEDANS, avec le bon run_id.
vi.mock("../src/engine/run-lock.js", () => ({
  withRunSerialization: vi.fn(async (_runId: string, fn: () => Promise<unknown>) => fn()),
}));

const { resolvePendingAction, reconcileOrphanPendingActions } = await import("../src/engine/approval.js");
const { withRunSerialization } = await import("../src/engine/run-lock.js");

function resetState(pendingStatus = "pending") {
  state.pending = {
    id: "pending-1",
    user_id: "user-1",
    run_id: "run-1",
    agent_type: "compta",
    tool_name: "supabase_upsert",
    tool_params: { table: "compta_transactions" },
    status: pendingStatus,
  };
  state.reconcileIds = [];
  state.reconcileError = null;
  state.lastUpdateFilters = null; // hygiène : jamais lire la chaîne du test précédent
  state.lastUpdatePatch = null;
  state.run = {
    tools_used: [
      {
        tool: "supabase_upsert",
        paramsSummary: "{}",
        resultSummary: "en attente de validation humaine",
        success: true,
        pendingActionId: "pending-1",
      },
    ],
  };
  state.remainingPending = 0;
  executeMock.mockReset();
}

describe("approval — mécanisme de validation humaine réel (fix bloquant QA 2026-07-27)", () => {
  beforeEach(() => resetState());

  it("approuver EXÉCUTE réellement l'outil et clôture le run en succès", async () => {
    executeMock.mockResolvedValue({ ok: true });
    const result = await resolvePendingAction("pending-1", "approve");

    expect(result.ok).toBe(true);
    expect(executeMock).toHaveBeenCalledWith({ table: "compta_transactions" }, { userId: "user-1", agentType: "compta", mode: "live" });
    expect(state.pending?.status).toBe("executed");
    expect(state.run?.status).toBe("success");
    // Le patch du journal parent passe par le verrou de sérialisation du run (sous-lot 8)
    expect(withRunSerialization).toHaveBeenCalledWith("run-1", expect.any(Function));
  });

  it("approuver marque le run en erreur si l'outil échoue à l'exécution", async () => {
    executeMock.mockRejectedValue(new Error("Gmail send échoué (500)"));
    const result = await resolvePendingAction("pending-1", "approve");

    expect(result.ok).toBe(true); // la résolution réussit ; c'est l'exécution de l'outil qui échoue
    expect(state.pending?.status).toBe("failed");
    expect(state.run?.status).toBe("error");
  });

  it("approuver un outil qui retourne {ok:false} SANS lever = échec (faux succès interdit, P0 2026-09-26)", async () => {
    executeMock.mockResolvedValue({ ok: false, error: "envoi refusé par Gmail" });
    const result = await resolvePendingAction("pending-1", "approve");

    expect(result.ok).toBe(true);
    expect(state.pending?.status).toBe("failed"); // AVANT le contrat strict : "executed" (mensonge)
    expect(String(state.pending?.result_summary)).toContain("envoi refusé par Gmail");
    expect(state.run?.status).toBe("error");
  });

  it("approuver un outil qui retourne void est un succès légitime (contrat : null/undefined = ok)", async () => {
    executeMock.mockResolvedValue(undefined);
    await resolvePendingAction("pending-1", "approve");

    expect(state.pending?.status).toBe("executed");
    expect(state.run?.status).toBe("success");
  });

  it("rejeter n'exécute jamais l'outil", async () => {
    const result = await resolvePendingAction("pending-1", "reject");

    expect(result.ok).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
    expect(state.pending?.status).toBe("rejected");
    expect(state.run?.status).toBe("success");
  });

  it("refuse de retraiter une action déjà résolue (claim atomique perdant → message précis)", async () => {
    resetState("executed"); // la ligne n'est plus 'pending' → le claim UPDATE ... WHERE status='pending' ne matche pas
    const result = await resolvePendingAction("pending-1", "approve");

    expect(result).toMatchObject({ ok: false, error: "Action déjà traitée" });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("laisse le run en awaiting_approval tant qu'il reste d'autres actions en attente sur ce run", async () => {
    state.remainingPending = 1;
    executeMock.mockResolvedValue({ ok: true });
    await resolvePendingAction("pending-1", "approve");

    expect(state.run?.status).toBeUndefined();
  });
});

describe("approval — exactement-une-fois (claim atomique, P0 IAO 2026-09-26 sous-lot 3)", () => {
  beforeEach(() => resetState());

  it("deux approbations simultanées → l'outil n'est exécuté qu'UNE fois", async () => {
    executeMock.mockResolvedValue({ ok: true });

    // Le claim atomique de PostgREST ne donne la ligne qu'à UN gagnant : après le 1er appel
    // (attendu jusqu'à la finalisation), la ligne n'est plus 'pending' → le 2e UPDATE ...
    // WHERE status='pending' ne matche pas (le mock applique réellement l'écriture).
    const first = await resolvePendingAction("pending-1", "approve");
    const second = await resolvePendingAction("pending-1", "approve");

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error: "Action déjà traitée" }); // lecture de repli : la ligne existe
    expect(executeMock).toHaveBeenCalledTimes(1); // AVANT le claim : 2 exécutions réelles
  });

  it("claim perdant sur une action inexistante → 'Action introuvable' (distinction préservée)", async () => {
    state.pending = null;
    const result = await resolvePendingAction("pending-inconnu", "approve");

    expect(result).toMatchObject({ ok: false, error: "Action introuvable" });
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe("reconcileOrphanPendingActions — clôture des 'processing' orphelins au boot", () => {
  beforeEach(() => resetState());

  it("retourne le nombre d'actions 'processing' orphelines clôturées en échec", async () => {
    state.reconcileIds = [{ id: "a1" }, { id: "a2" }];
    await expect(reconcileOrphanPendingActions()).resolves.toBe(2);
  });

  it("rien à réconcilier → 0", async () => {
    await expect(reconcileOrphanPendingActions()).resolves.toBe(0);
  });

  it("échec DB non fatal : loggé, retourne 0", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    state.reconcileError = { message: "connection refused" };
    await expect(reconcileOrphanPendingActions()).resolves.toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("reconcileOrphanPendingActions"));
    spy.mockRestore();
  });

  it("PRÉDICATS — ne réconcilie QUE les 'processing' orphelins de plus de 10min, en 'failed'", async () => {
    const before = Date.now();
    state.reconcileIds = [{ id: "a1" }];
    await reconcileOrphanPendingActions();
    const after = Date.now();

    const filters = state.lastUpdateFilters;
    expect(filters).not.toBeNull();
    expect(filters!.eq).toContainEqual(["status", "processing"]); // jamais les pending/executed
    const ltCall = filters!.lt.find(([col]) => col === "resolved_at");
    expect(ltCall).toBeDefined();
    const cutoff = new Date(String(ltCall![1])).getTime();
    // Fenêtre orpheline 10min : cutoff ≈ now-600s
    expect(cutoff).toBeGreaterThan(before - 600_000 - 5_000);
    expect(cutoff).toBeLessThan(after - 600_000 + 5_000);
    // Le PATCH aussi : réconcilier en "executed"/"rejected" serait un mensonge (rien n'a
    // été exécuté) — écran M8 : flip du statut doit faire échouer ce test.
    expect(state.lastUpdatePatch).toMatchObject({ status: "failed" });
  });
});
