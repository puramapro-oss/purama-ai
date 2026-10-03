import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: enqueue }));
const { delegateToAgentTool, MAX_DELEGATION_DEPTH } = await import("../src/tools/delegate.js");

const context = (agentType: "legal" | "partner", payload?: Record<string, unknown>) => ({
  userId: "user-1",
  agentType,
  mode: "live" as const,
  trigger: { type: "delegation" as const, source: "test", payload },
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
    }));
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
});
