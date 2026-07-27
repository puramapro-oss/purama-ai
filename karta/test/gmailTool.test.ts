import { describe, expect, it, vi } from "vitest";

const today = new Date().toISOString().slice(0, 10);

/** État mutable du compteur quotidien, lu/écrit par les mocks ci-dessous. */
let memoryCounter: { date: string; count: number } | null = null;

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === "karta_agent_memory") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => ({ data: memoryCounter ? { memory_value: memoryCounter } : null, error: null })),
          upsert: vi.fn(async (row: { memory_value: { date: string; count: number } }) => {
            memoryCounter = row.memory_value;
            return { error: null };
          }),
        };
      }
      // email_agent_config : jamais connecté (Gmail OAuth non complété) — suffisant pour isoler
      // le test sur la limite quotidienne, qui doit se déclencher AVANT même de vérifier l'OAuth.
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      };
    }),
  },
}));

vi.mock("../src/config.js", () => ({
  config: { googleClientId: "x", googleClientSecret: "y" },
}));

const { gmailSendTool } = await import("../src/tools/gmail.js");

const ctx = { userId: "user-1", agentType: "email" as const, mode: "live" as const };

describe("gmail_send — anti-ban Gmail (max 400 envois/jour/compte, cf brief §Sécurité)", () => {
  it("laisse passer sous la limite (échoue ensuite sur l'OAuth non connecté, pas sur la limite)", async () => {
    memoryCounter = { date: today, count: 5 };
    await expect(gmailSendTool.execute({ to: "a@b.com", subject: "s", body: "b" }, ctx)).rejects.toThrow(
      /OAuth non complété/
    );
  });

  it("bloque au-delà de 400 envois le même jour", async () => {
    memoryCounter = { date: today, count: 400 };
    await expect(gmailSendTool.execute({ to: "a@b.com", subject: "s", body: "b" }, ctx)).rejects.toThrow(
      /Limite quotidienne.*400/
    );
  });

  it("réinitialise le compteur sur un nouveau jour", async () => {
    memoryCounter = { date: "2020-01-01", count: 400 };
    await expect(gmailSendTool.execute({ to: "a@b.com", subject: "s", body: "b" }, ctx)).rejects.toThrow(
      /OAuth non complété/
    );
  });
});
