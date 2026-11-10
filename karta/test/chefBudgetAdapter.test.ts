import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc } }));
import { SupabaseChefControlPlane } from "../src/chef/control-plane.js";

const control = new SupabaseChefControlPlane({ repo: "repo", defaultCwd: "/tmp", defaultVerificationProfiles: ["review"] });
const receipt = {
  eventKey: "claim-receipt-001", missionId: "mission", taskId: "task", workerId: "worker", provider: "codex" as const,
  attempt: 3, fencingToken: 19, inputTokens: 10, outputTokens: 5, cachedInputTokens: null, costMicros: null,
};

beforeEach(() => { rpc.mockReset(); });
describe("CHEF claim-bound usage adapter", () => {
  it("sends the claim identity and preserves unknown dimensions to SQL", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await control.recordUsage(receipt)).toBe(false);
    expect(rpc).toHaveBeenCalledWith("chef_record_claim_usage", {
      p_event_key: receipt.eventKey, p_mission_id: receipt.missionId, p_task_id: receipt.taskId,
      p_worker_id: receipt.workerId, p_provider: "codex", p_model: null, p_attempt: 3, p_fencing_token: 19,
      p_input_tokens: 10, p_output_tokens: 5, p_cached_input_tokens: null, p_cost_micros: null,
    });
  });
  it("accepts a confirmed settlement and propagates transport/database failures", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await control.recordUsage({ ...receipt, costMicros: 0 })).toBe(true);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "claim conflict" } });
    await expect(control.recordUsage(receipt)).rejects.toThrow("claim conflict");
  });
  it.each([null, undefined, "true", {}, 1])("fails closed on malformed acknowledgement %s", async value => {
    rpc.mockResolvedValueOnce({ data: value, error: null });
    await expect(control.recordUsage(receipt)).rejects.toThrow(/réconciliation/);
  });
});
