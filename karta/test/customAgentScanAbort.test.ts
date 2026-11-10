import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ abortSignal: vi.fn(), eq: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: () => {
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { state.eq(column, value); return query; },
        abortSignal: (signal: AbortSignal) => { state.abortSignal(signal); return query; },
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return query;
    },
  },
}));
vi.mock("../src/tools/customRegistry.js", () => ({ resolveCustomAgentTools: vi.fn() }));

const { listKartaEnabledCustomAgents } = await import("../src/agents/customAgent.js");
beforeEach(() => { state.abortSignal.mockClear(); state.eq.mockClear(); });

it("forwards the scheduler's exact abort signal to the database query", async () => {
  const controller = new AbortController();
  await listKartaEnabledCustomAgents(controller.signal);
  expect(state.abortSignal).toHaveBeenCalledExactlyOnceWith(controller.signal);
  controller.abort();
  expect((state.abortSignal.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
});

it("keeps existing no-signal callers and activation filters unchanged", async () => {
  await expect(listKartaEnabledCustomAgents()).resolves.toEqual([]);
  expect(state.abortSignal).not.toHaveBeenCalled();
  expect(state.eq.mock.calls).toEqual([["karta_enabled", true], ["is_active", true]]);
});
