import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupabaseChefControlPlane } from "../src/chef/control-plane.js";
import { ChefProcessStopUnconfirmedError } from "../src/chef/process.js";

const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc: db.rpc } }));
const control = new SupabaseChefControlPlane({
  repo: "test", defaultCwd: process.cwd(), defaultVerificationProfiles: ["unit"],
});
const claim = { workerId: "worker", attempt: 2, fencingToken: 4 };

beforeEach(() => { db.rpc.mockReset().mockResolvedValue({ data: true, error: null }); });

describe("CHEF process quarantine adapter", () => {
  it("sends the original generation and lets the server derive every exclusion scope", async () => {
    await expect(control.quarantineProcess("task", claim, "stop unconfirmed")).resolves.toBe(true);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("chef_quarantine_process", {
      p_task_id: "task", p_worker_id: "worker", p_fencing_token: 4, p_attempt: 2, p_reason: "stop unconfirmed",
    });
  });

  it.each([false, null, {}, "true"])("does not accept a missing boolean acknowledgement: %j", async (data) => {
    db.rpc.mockResolvedValue({ data, error: null });
    await expect(control.quarantineProcess("task", claim, "unconfirmed")).resolves.toBe(false);
  });

  it("propagates persistence failure so the daemon cannot claim that exclusion was stored", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { code: "08006", message: "offline" } });
    await expect(control.quarantineProcess("task", claim, "unconfirmed")).rejects.toThrow(/offline/);
    expect(db.rpc).toHaveBeenCalledOnce();
  });

  it.each([
    { ...claim, workerId: " " }, { ...claim, attempt: 0 }, { ...claim, fencingToken: 0 },
    { ...claim, attempt: 1.5 }, { ...claim, fencingToken: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects an invalid generation before RPC: %j", async (badClaim) => {
    await expect(control.quarantineProcess("task", badClaim, "unconfirmed")).rejects.toThrow(/invalide/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("turns admission quarantine into a persistent stop without retrying the RPC", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { code: "PCQ01", message: "persistent quarantine" } });
    await expect(control.claimNext({ missionId: "mission", workerId: "worker", provider: "codex", leaseSeconds: 300 }))
      .rejects.toThrow(ChefProcessStopUnconfirmedError);
    expect(db.rpc).toHaveBeenCalledOnce();
  });

  it("retains an ordinary empty-queue result", async () => {
    db.rpc.mockResolvedValue({ data: [], error: null });
    await expect(control.claimNext({ missionId: "mission", workerId: "worker", provider: "codex", leaseSeconds: 300 }))
      .resolves.toBeNull();
  });

  it("halts on an unauthenticated expired claim without continuing housekeeping", async () => {
    db.rpc.mockResolvedValueOnce({ data: 0, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "PCQ01", message: "active exclusion retained" } });
    await expect(control.housekeeping("mission")).rejects.toThrow(ChefProcessStopUnconfirmedError);
    expect(db.rpc).toHaveBeenCalledTimes(2);
  });

  it("halts when quarantine prevents a mission success label", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { code: "PCQ01", message: "mission quarantined" } });
    await expect(control.tryFinishMission("mission")).rejects.toThrow(ChefProcessStopUnconfirmedError);
    expect(db.rpc).toHaveBeenCalledOnce();
  });
});
