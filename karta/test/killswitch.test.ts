import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ active: false, error: null as null | { message: string }, read: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: vi.fn(() => {
      const builder = { select: vi.fn(() => builder), eq: vi.fn(() => builder), single: h.read };
      return builder;
    }),
  },
}));

describe("fresh global stop checks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    h.active = false;
    h.error = null;
    h.read.mockImplementation(async () => ({ data: { kill_switch: h.active }, error: h.error }));
  });

  it("contourne immédiatement une valeur false déjà en cache", async () => {
    const { isGlobalKillSwitchActive } = await import("../src/engine/killswitch.js");
    expect(await isGlobalKillSwitchActive()).toBe(false);
    h.active = true;
    expect(await isGlobalKillSwitchActive({ fresh: true })).toBe(true);
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it("ne renvoie pas l'ancien false si la lecture fraîche échoue", async () => {
    const { isGlobalKillSwitchActive } = await import("../src/engine/killswitch.js");
    expect(await isGlobalKillSwitchActive()).toBe(false);
    h.error = { message: "database unavailable" };
    await expect(isGlobalKillSwitchActive({ fresh: true })).rejects.toThrow("database unavailable");
  });

  it("conserve le cache pour les lectures qui ne demandent pas de fraîcheur", async () => {
    const { isGlobalKillSwitchActive } = await import("../src/engine/killswitch.js");
    expect(await isGlobalKillSwitchActive()).toBe(false);
    h.active = true;
    expect(await isGlobalKillSwitchActive()).toBe(false);
    expect(h.read).toHaveBeenCalledOnce();
  });
});
