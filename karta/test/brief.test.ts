import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc: h.rpc } }));
const { claimPendingBrief, peekPendingBrief, armPendingBrief } = await import("../src/engine/brief.js");

const owner = "00000000-0000-4000-8000-000000000101";
const runId = "00000000-0000-4000-8000-000000000102";
const briefId = "00000000-0000-4000-8000-000000000103";
const privateText = "PRIVATE_BRIEF_SENTINEL";
const request = () => ({ userId: owner, agentType: "newsletter-genie" as const, runId });
const row = () => ({ brief_id: briefId, brief: `  ${privateText}  ` });

beforeEach(() => { h.rpc.mockReset(); });

describe("private brief RPC client", () => {
  it("returns the original payload while using only the bound run identity", async () => {
    h.rpc.mockResolvedValue({ data: [row()], error: null });
    expect(await claimPendingBrief(request())).toEqual({ briefId, brief: `  ${privateText}  ` });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("karta_claim_pending_brief", {
      p_user_id: owner, p_agent_type: "newsletter-genie", p_run_id: runId, p_key: "pending_brief",
    });
    expect(JSON.stringify(h.rpc.mock.calls)).not.toContain(privateText);
  });

  it("reconciles a lost response with the same run and key, at most once", async () => {
    const input = { ...request(), key: "campaign_input" };
    h.rpc.mockImplementationOnce(async () => {
      input.runId = "changed-after-dispatch";
      input.key = "changed-key";
      return { data: null, error: { message: privateText } };
    }).mockResolvedValueOnce({ data: [row()], error: null });
    expect(await claimPendingBrief(input)).toEqual({ briefId, brief: `  ${privateText}  ` });
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(h.rpc.mock.calls[0]).toEqual(h.rpc.mock.calls[1]);
    expect(h.rpc.mock.calls[1][1]).toMatchObject({ p_run_id: runId, p_key: "campaign_input" });
  });

  it("returns null for a confirmed empty result without retrying or inventing input", async () => {
    h.rpc.mockResolvedValue({ data: [], error: null });
    expect(await claimPendingBrief(request())).toBeNull();
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, [row(), row()], [{ brief: privateText, brief_id: "not-an-id" }],
    [{ brief: " \n\u00a0", brief_id: briefId }], [{ brief: { secret: privateText }, brief_id: briefId }]].map(data => ({ data })))(
    "refuses malformed successful responses without exposing their contents: %j", async ({ data }) => {
      h.rpc.mockResolvedValue({ data, error: null });
      await expect(claimPendingBrief(request())).rejects.toThrow(
        "Mission indisponible : vérifier son état avant toute reprise",
      );
      expect(h.rpc).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["returned", "thrown"])("replaces %s transport errors with static public text", async failure => {
    if (failure === "returned") h.rpc.mockResolvedValue({ data: null, error: { message: privateText } });
    else h.rpc.mockRejectedValue(new Error(privateText));
    const error = await claimPendingBrief(request()).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Mission indisponible : vérifier son état avant toute reprise");
    expect(JSON.stringify(error)).not.toContain(privateText);
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it("uses the read-only preview RPC for simulation", async () => {
    h.rpc.mockResolvedValue({ data: [row()], error: null });
    expect(await peekPendingBrief(request())).toEqual({ briefId, brief: `  ${privateText}  ` });
    expect(h.rpc.mock.calls.map(call => call[0])).toEqual(["karta_peek_pending_brief"]);
  });

  it("confirms an arm after a lost response without dispatching anything", async () => {
    h.rpc.mockRejectedValueOnce(new Error(privateText)).mockResolvedValueOnce({ data: true, error: null });
    await expect(armPendingBrief(request())).resolves.toBeUndefined();
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(h.rpc.mock.calls[0]).toEqual(h.rpc.mock.calls[1]);
    expect(h.rpc.mock.calls[0]).toEqual(["karta_arm_pending_brief", {
      p_user_id: owner, p_agent_type: "newsletter-genie", p_run_id: runId,
    }]);
  });

  it.each([null, false, [], { armed: true }].map(data => ({ data })))("does not treat an ambiguous arm acknowledgement as permission: %j", async ({ data }) => {
    h.rpc.mockResolvedValue({ data, error: null });
    await expect(armPendingBrief(request())).rejects.toThrow(
      "Autorisation de la mission non confirmée : vérifier son état avant toute action",
    );
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it("does not restore or release a possibly committed arm after both responses fail", async () => {
    h.rpc.mockRejectedValue(new Error(privateText));
    await expect(armPendingBrief(request())).rejects.toThrow(
      "Autorisation de la mission non confirmée : vérifier son état avant toute action",
    );
    expect(h.rpc.mock.calls.map(call => call[0])).toEqual(["karta_arm_pending_brief", "karta_arm_pending_brief"]);
  });
});
