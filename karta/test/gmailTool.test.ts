import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const today = new Date().toISOString().slice(0, 10);
let reserved = 0;
const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
  if (name !== "karta_reserve_daily_counter") return { data: null, error: { message: "unexpected rpc" } };
  if (params.p_day !== today || params.p_counter_key !== "gmail_send") {
    return { data: null, error: { message: "invalid counter request" } };
  }
  if (reserved >= Number(params.p_limit)) return { data: null, error: null };
  reserved += 1;
  return { data: reserved, error: null };
});

vi.mock("../src/lib/gmail-token-crypto.js", () => ({
  decryptGmailToken: (value: string) => value,
  encryptGmailToken: (value: string) => value,
}));

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    rpc,
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(async () => ({
        data: {
          gmail_refresh_token: "refresh-token",
          gmail_access_token: "access-token",
          gmail_token_expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        error: null,
      })),
    })),
  },
}));

vi.mock("../src/config.js", () => ({
  config: { googleClientId: "x", googleClientSecret: "y" },
}));

const { buildRawEmail, gmailSendTool } = await import("../src/tools/gmail.js");
const ctx = { userId: "user-1", agentType: "email" as const, mode: "live" as const };

beforeEach(() => {
  reserved = 0;
  rpc.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "message-1" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
});

afterEach(() => vi.unstubAllGlobals());

describe("gmail_send hardening", () => {
  it("réserve atomiquement une place seulement après une authentification disponible", async () => {
    reserved = 5;
    await expect(gmailSendTool.execute({ to: "a@b.com", subject: "s", body: "b" }, ctx)).resolves.toEqual({
      messageId: "message-1",
    });
    expect(reserved).toBe(6);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("bloque lorsque la réservation atomique n'accorde plus de place", async () => {
    reserved = 400;
    await expect(gmailSendTool.execute({ to: "a@b.com", subject: "s", body: "b" }, ctx)).rejects.toThrow(
      /Limite quotidienne.*400/
    );
    expect(reserved).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { to: "victim@example.com\r\nBcc: attacker@example.com", subject: "ok" },
    { to: "victim@example.com", subject: "ok\nBcc: attacker@example.com" },
  ])("refuse l'injection d'en-têtes avant de consommer le quota: %j", async ({ to, subject }) => {
    await expect(gmailSendTool.execute({ to, subject, body: "body" }, ctx)).rejects.toThrow(/invalide/);
    expect(rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(reserved).toBe(0);
  });

  it("produit des en-têtes CRLF valides pour une entrée saine", () => {
    const raw = buildRawEmail("a@b.com", "Sujet", "Bonjour\nMonde");
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: a@b.com\r\nSubject: Sujet\r\n");
    expect(decoded).toContain("\r\n\r\nBonjour\nMonde");
  });
});
