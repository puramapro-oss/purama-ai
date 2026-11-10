import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: enqueue }));
const { delegateToAgentTool, MAX_DELEGATION_DEPTH } = await import("../src/tools/delegate.js");

const context = (agentType: "legal" | "partner", payload?: Record<string, unknown>) => ({
  userId: "user-1",
  agentType,
  mode: "live" as const,
  trigger: { type: payload ? "delegation" as const : "manual" as const, source: "test", payload },
});

describe("delegate_to_agent — garde-fous de graphe", () => {
  beforeEach(() => enqueue.mockReset().mockResolvedValue(undefined));

  it("propage une profondeur et une lignée serveur", async () => {
    await delegateToAgentTool.execute({ targetAgent: "partner", reason: "Relire le partenariat" }, context("legal"));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentType: "partner",
      trigger: expect.objectContaining({
        payload: {
          reason: "Relire le partenariat",
          kartaDelegation: { depth: 1, lineage: ["legal", "partner"] },
        },
      }),
    }), undefined);
  });

  it("interdit l'auto-délégation", async () => {
    await expect(delegateToAgentTool.execute({ targetAgent: "legal", reason: "Boucle" }, context("legal")))
      .rejects.toThrow(/Auto-délégation/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("interdit de revenir vers un agent déjà visité", async () => {
    const payload = { kartaDelegation: { depth: 1, lineage: ["legal", "partner"] } };
    await expect(delegateToAgentTool.execute({ targetAgent: "legal", reason: "Retour" }, context("partner", payload)))
      .rejects.toThrow(/Cycle de délégation/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("interdit une délégation au-delà de la profondeur maximale", async () => {
    const payload = { kartaDelegation: { depth: MAX_DELEGATION_DEPTH, lineage: ["email", "compta", "legal", "partner"] } };
    await expect(delegateToAgentTool.execute({ targetAgent: "legal", reason: "Trop profond" }, context("partner", payload)))
      .rejects.toThrow(/Profondeur maximale/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    { kartaDelegation: "invalid" },
    { kartaDelegation: { depth: -1, lineage: ["legal"] } },
    { kartaDelegation: { depth: 1, lineage: ["partner"] } },
  ])("refuse une trace forgée ou incohérente: %j", async (payload) => {
    await expect(delegateToAgentTool.execute({ targetAgent: "partner", reason: "Test" }, context("legal", payload)))
      .rejects.toThrow(/délégation|Lignée/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("préserve la clé métier de livraison et l'identité du propriétaire", async () => {
    const ctx = { ...context("legal"), operationId: "run-1:0" };
    await delegateToAgentTool.execute({ targetAgent: "partner", reason: "  Relire le contrat  " }, ctx);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      trigger: expect.objectContaining({ payload: expect.objectContaining({ reason: "Relire le contrat" }) }),
    }), { dedupeKey: "delegation|run-1:0|partner|user-1" });
  });

  it("ne remet pas une ancienne approbation sans origine à la profondeur zéro", async () => {
    const { trigger: _trigger, ...ctx } = context("legal");
    await expect(delegateToAgentTool.execute({ targetAgent: "partner", reason: "Suite" }, ctx))
      .rejects.toThrow(/Contexte de délégation absent/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("ne remet pas une reprise sans lignée à la profondeur zéro", async () => {
    await expect(delegateToAgentTool.execute({ targetAgent: "partner", reason: "Suite" }, {
      ...context("legal"), trigger: { type: "delegation", source: "approval-resume", payload: {} },
    })).rejects.toThrow(/Trace de délégation absente/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("n'enfile aucune tâche depuis une exécution simulée", async () => {
    await expect(delegateToAgentTool.execute({ targetAgent: "partner", reason: "Suite" }, {
      ...context("legal"), mode: "simulation",
    })).rejects.toThrow(/simulation/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "x".repeat(2001), "contains\0null"])("refuse le motif absent, trop long ou non sérialisable en base", async reason => {
    await expect(delegateToAgentTool.execute({ targetAgent: "partner", reason }, context("legal")))
      .rejects.toThrow(/Motif de délégation invalide/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("préserve la lignée parent tout en bornant la chaîne complète", async () => {
    const lineage = ["email", "legal"];
    const parent = { kartaDelegation: { depth: 1, lineage } };
    await delegateToAgentTool.execute({ targetAgent: "partner", reason: "Suite" }, context("legal", parent));
    expect(parent).toEqual({ kartaDelegation: { depth: 1, lineage: ["email", "legal"] } });
    const child = enqueue.mock.calls[0][0];
    expect(child.trigger.payload.kartaDelegation).toEqual({ depth: 2, lineage: ["email", "legal", "partner"] });
    await delegateToAgentTool.execute({ targetAgent: "compta", reason: "Facture" }, {
      ...context("partner"), trigger: child.trigger,
    });
    expect(enqueue.mock.calls[1][0].trigger.payload.kartaDelegation).toEqual({
      depth: 3, lineage: ["email", "legal", "partner", "compta"],
    });
  });
});
