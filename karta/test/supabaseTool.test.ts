import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: vi.fn(() => ({
      upsert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: "row-1" }, error: null }),
      then: undefined,
    })),
  },
}));

const { supabaseUpsertTool, supabaseSelectTool } = await import("../src/tools/supabase-tool.js");

describe("supabase-tool — liste blanche des tables", () => {
  const ctx = { userId: "u1", agentType: "compta" as const, mode: "live" as const };

  it("rejette une table non autorisée en upsert", async () => {
    await expect(
      supabaseUpsertTool.execute({ table: "auth.users", row: {} }, ctx)
    ).rejects.toThrow(/non autorisée/);
  });

  it("rejette une table non autorisée en select", async () => {
    await expect(supabaseSelectTool.execute({ table: "profiles" }, ctx)).rejects.toThrow(/non autorisée/);
  });

  it("accepte une table autorisée", async () => {
    const result = await supabaseUpsertTool.execute({ table: "compta_transactions", row: { amount: 10 } }, ctx);
    expect(result.id).toBe("row-1");
  });
});
