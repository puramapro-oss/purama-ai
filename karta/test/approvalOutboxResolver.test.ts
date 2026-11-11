import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ claimed: false, rpc: vi.fn(), enqueue: vi.fn(), effect: vi.fn(), signals: [] as AbortSignal[] }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc: (...args: unknown[]) => {
  const response = Promise.resolve(h.rpc(...args));
  return Object.assign(response, { abortSignal: (signal: AbortSignal) => { h.signals.push(signal); return response; } });
} } }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: h.enqueue }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", () => ({ loadAgentState: async () => ({ simulationMode: false }), isRunnable: () => ({ ok: true }) }));
vi.mock("../src/engine/resolveDefinition.js", () => ({ resolveAgentDefinition: async () => ({ tools: [{ name: "inert", execute: h.effect }] }) }));
import { resolvePendingAction } from "../src/engine/approval.js";

const actionId = "00000000-0000-4000-8000-000000000711";
beforeEach(() => {
  vi.resetAllMocks(); h.claimed = false; h.signals = [];
  h.effect.mockResolvedValue({ ok: true });
  h.enqueue.mockRejectedValue(new Error("PRIVATE_REDIS_OUTAGE"));
  h.rpc.mockImplementation(async (name: string) => {
    if (name === "karta_claim_pending_action_bounded") {
      if (h.claimed) return { data: [], error: null };
      h.claimed = true;
      return { data: [{ id: actionId, user_id: "00000000-0000-4000-8000-000000000712",
        run_id: "00000000-0000-4000-8000-000000000713", agent_type: "legal", tool_name: "inert", tool_params: {}, status: "executing" }], error: null };
    }
    return { data: null, error: null };
  });
});
afterEach(() => { vi.useRealTimers(); });

describe("approval resolution independent of queue availability", () => {
  it.each(["approve", "reject"] as const)("acknowledges durable %s finalization without attempting Redis publication", async decision => {
    const result = await resolvePendingAction(actionId, decision);
    expect(result.ok).toBe(true);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenCalledWith("karta_finalize_pending_action", expect.objectContaining({ p_id: actionId }));
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REDIS_OUTAGE");
    expect((await resolvePendingAction(actionId, decision)).ok).toBe(false);
    expect(h.effect).toHaveBeenCalledTimes(decision === "approve" ? 1 : 0);
  });

  it("aborts an HTTP claim after five seconds and never executes its late response", async () => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    h.rpc.mockImplementationOnce(() => {
      h.claimed = true; // The remote transaction can have committed already.
      return new Promise(resolve => { release = resolve; });
    });
    const resolving = resolvePendingAction(actionId, "approve");
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await resolving).ok).toBe(false);
    expect(h.signals[0].aborted).toBe(true);
    release({ data: [{ id: actionId, user_id: "late-owner", run_id: "late-run", agent_type: "legal",
      tool_name: "inert", tool_params: {}, status: "executing" }], error: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.effect).not.toHaveBeenCalled();
    expect(h.rpc.mock.calls.some(([name]) => name === "karta_finalize_pending_action")).toBe(false);
    expect((await resolvePendingAction(actionId, "approve")).ok).toBe(false);
    expect(h.effect).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed silent finalization without resetting or repeating the effect", async () => {
    vi.useFakeTimers();
    const original = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation((name: string, params: unknown) => name === "karta_finalize_pending_action"
      ? new Promise(() => {}) : original(name, params));
    const resolving = resolvePendingAction(actionId, "approve");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await resolving).toMatchObject({ ok: false, error: expect.stringContaining("Résultat non confirmé") });
    expect(h.signals.at(-1)?.aborted).toBe(true);
    expect(h.effect).toHaveBeenCalledOnce();
    expect((await resolvePendingAction(actionId, "approve")).ok).toBe(false);
    expect(h.effect).toHaveBeenCalledOnce();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
