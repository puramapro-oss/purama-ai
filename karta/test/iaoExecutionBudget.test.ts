import { describe, expect, it, vi } from "vitest";
import { IaoFacade, type IaoRequest, type KartaIaoPort } from "../src/iao/iaoFacade.js";
import { KartaRuntimeIaoPort } from "../src/iao/kartaRuntimePort.js";

function request(): IaoRequest {
  const now = Date.now();
  return {
    type: "conversation", requestId: "11111111-1111-4111-8111-111111111111",
    tenantId: "tenant", actorId: "actor", conversationId: "conversation", prompt: "test",
    identity: { tenantId: "tenant", actorId: "actor", session: {
      tenantId: "tenant", userId: "actor", sessionId: "22222222-2222-4222-8222-222222222222",
      appSlug: "purama-ai", issuedAt: now - 1_000, expiresAt: now + 60_000,
    } },
  };
}

describe("IAO execution budget metadata", () => {
  it.each([
    [undefined, 240_000, 120_000],
    [100, 200, 100],
    [20_500, 41_000, 20_500],
    [600_000, 1_200_000, 600_000],
  ])("reports both stage budgets for timeout %s without dispatching work", (timeout, conversation, control) => {
    const smarana = { buildContext: vi.fn(), control: vi.fn() };
    const completion = { complete: vi.fn() };
    const port = new KartaRuntimeIaoPort(smarana, completion, timeout);
    const facade = new IaoFacade(port);
    expect(port.executionBudgetMs("conversation")).toBe(conversation);
    expect(port.executionBudgetMs("memory-control")).toBe(control);
    expect(facade.executionBudgetMs("conversation")).toBe(conversation);
    expect(facade.executionBudgetMs("memory-control")).toBe(control);
    expect(smarana.buildContext).not.toHaveBeenCalled();
    expect(smarana.control).not.toHaveBeenCalled();
    expect(completion.complete).not.toHaveBeenCalled();
  });

  it("keeps ports without metadata compatible with ordinary submission", async () => {
    const prepare = vi.fn(async () => ({ kind: "accepted" as const, preview: "prepared" }));
    const facade = new IaoFacade({ prepare });
    expect(facade.executionBudgetMs("conversation")).toBeUndefined();
    expect(facade.executionBudgetMs("memory-control")).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    expect(await facade.submit(request())).toMatchObject({ status: "partial", preview: "prepared" });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it.each([0, -1, NaN, Infinity, -Infinity, 1_200_001, Number.MAX_VALUE, 1.5, undefined, null, false, "240000"])(
    "ignores invalid metadata %s without preventing submission", async value => {
      const prepare = vi.fn(async () => ({ kind: "accepted" as const, preview: "prepared" }));
      const facade = new IaoFacade({ prepare, executionBudgetMs: () => value as number });
      expect(facade.executionBudgetMs("conversation")).toBeUndefined();
      expect(facade.executionBudgetMs("memory-control")).toBeUndefined();
      expect(await facade.submit(request())).toMatchObject({ status: "partial", preview: "prepared" });
      expect(prepare).toHaveBeenCalledOnce();
    },
  );

  it.each(["method", "getter"] as const)("keeps a throwing metadata %s harmless and private", async mode => {
    const prepare = vi.fn(async () => ({ kind: "accepted" as const, preview: "prepared" }));
    const port: KartaIaoPort = { prepare };
    const fail = () => { throw new Error("PRIVATE_BUDGET_DETAILS"); };
    if (mode === "method") port.executionBudgetMs = fail;
    else Object.defineProperty(port, "executionBudgetMs", { get: fail });
    const facade = new IaoFacade(port);
    expect(facade.executionBudgetMs("conversation")).toBeUndefined();
    expect(facade.executionBudgetMs("memory-control")).toBeUndefined();
    const result = await facade.submit(request());
    expect(result).toMatchObject({ status: "partial", preview: "prepared" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BUDGET_DETAILS");
    expect(prepare).toHaveBeenCalledOnce();
  });
});
