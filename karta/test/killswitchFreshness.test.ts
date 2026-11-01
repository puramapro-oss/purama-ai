import { beforeEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: {
  from: () => ({ select: () => ({ eq: () => ({ single: db.read }) }) }),
} }));

beforeEach(() => { vi.resetModules(); db.read.mockReset(); });

it("a dispatch refresh observes a stop set by a different worker despite a cached false", async () => {
  db.read.mockResolvedValueOnce({ data: { kill_switch: false }, error: null });
  const { isGlobalKillSwitchActive } = await import("../src/engine/killswitch.js");
  expect(await isGlobalKillSwitchActive()).toBe(false);
  db.read.mockResolvedValueOnce({ data: { kill_switch: true }, error: null });
  expect(await isGlobalKillSwitchActive(true)).toBe(true);
  expect(db.read).toHaveBeenCalledTimes(2);
});

it("a failed dispatch refresh cannot fall back to cached permission", async () => {
  db.read.mockResolvedValueOnce({ data: { kill_switch: false }, error: null });
  const { isGlobalKillSwitchActive } = await import("../src/engine/killswitch.js");
  await isGlobalKillSwitchActive();
  db.read.mockResolvedValueOnce({ data: null, error: { message: "offline" } });
  await expect(isGlobalKillSwitchActive(true)).rejects.toThrow("offline");
});
