import { describe, expect, it, vi, beforeEach } from "vitest";

const state = {
  pending: null as Record<string, unknown> | null,
  run: null as Record<string, unknown> | null,
  remainingPending: 0,
};

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === "karta_pending_actions") {
        return {
          select: vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.count) {
              return {
                eq: vi.fn().mockReturnThis(),
                then: (resolve: (v: unknown) => unknown) =>
                  Promise.resolve({ count: state.remainingPending, error: null }).then(resolve),
              };
            }
            return {
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn(async () => ({ data: state.pending, error: null })),
            };
          }),
          update: vi.fn((patch: Record<string, unknown>) => ({
            eq: vi.fn(async () => {
              state.pending = { ...state.pending, ...patch };
              return { error: null };
            }),
          })),
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

const { resolvePendingAction } = await import("../src/engine/approval.js");

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
  });

  it("approuver marque le run en erreur si l'outil échoue à l'exécution", async () => {
    executeMock.mockRejectedValue(new Error("Gmail send échoué (500)"));
    const result = await resolvePendingAction("pending-1", "approve");

    expect(result.ok).toBe(true); // la résolution réussit ; c'est l'exécution de l'outil qui échoue
    expect(state.pending?.status).toBe("failed");
    expect(state.run?.status).toBe("error");
  });

  it("rejeter n'exécute jamais l'outil", async () => {
    const result = await resolvePendingAction("pending-1", "reject");

    expect(result.ok).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
    expect(state.pending?.status).toBe("rejected");
    expect(state.run?.status).toBe("success");
  });

  it("refuse de retraiter une action déjà résolue", async () => {
    resetState("executed");
    const result = await resolvePendingAction("pending-1", "approve");

    expect(result.ok).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("laisse le run en awaiting_approval tant qu'il reste d'autres actions en attente sur ce run", async () => {
    state.remainingPending = 1;
    executeMock.mockResolvedValue({ ok: true });
    await resolvePendingAction("pending-1", "approve");

    expect(state.run?.status).toBeUndefined();
  });
});
