import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc: h.rpc } }));
const { claimPendingBrief, peekPendingBrief } = await import("../src/engine/brief.js");
const briefId = "00000000-0000-4000-8000-000000000abc";
const request = () => ({ userId: "00000000-0000-4000-8000-000000000701", agentType: "newsletter-genie" as const,
  runId: "00000000-0000-4000-8000-000000000703", expectedBriefId: briefId });

beforeEach(() => { h.rpc.mockReset(); });
describe("exact submitted input at the RPC boundary", () => {
  it.each([claimPendingBrief, peekPendingBrief])("passes one frozen expected identity through a lost response", async read => {
    const input = request();
    h.rpc.mockImplementationOnce(async () => {
      input.expectedBriefId = "00000000-0000-4000-8000-000000000def";
      throw new Error("transport lost");
    }).mockResolvedValueOnce({ data: [{ brief_id: briefId, brief: "private input" }], error: null });
    expect(await read(input)).toEqual({ briefId, brief: "private input" });
    expect(h.rpc.mock.calls[0]).toEqual(h.rpc.mock.calls[1]);
    expect(h.rpc.mock.calls[1][1]).toMatchObject({ p_expected_brief_id: briefId });
  });

  it("rejects an incorrectly wired RPC returning a different valid identity", async () => {
    h.rpc.mockResolvedValue({ data: [{ brief_id: "00000000-0000-4000-8000-000000000def", brief: "PRIVATE_WRONG_INPUT" }], error: null });
    await expect(claimPendingBrief(request())).rejects.toThrow("Mission indisponible : vérifier son état avant toute reprise");
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it("accepts UUID case normalization but rejects malformed identity before calling SQL", async () => {
    h.rpc.mockResolvedValue({ data: [{ brief_id: briefId, brief: "private input" }], error: null });
    expect((await claimPendingBrief({ ...request(), expectedBriefId: briefId.toUpperCase() }))?.briefId).toBe(briefId);
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_expected_brief_id: briefId });
    h.rpc.mockClear();
    await expect(claimPendingBrief({ ...request(), expectedBriefId: "not-an-id" })).rejects.toThrow("Mission indisponible");
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
