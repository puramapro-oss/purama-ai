import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.RESEND_API_KEY = "test-resend";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// supabase-js capture `fetch` à l'import du module (avant stubGlobal) et notify.ts l'utilise
// pour résoudre l'email du user : mock pour tenir tout le chemin email sous test.
vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    auth: {
      admin: {
        getUserById: vi.fn(async () => ({ data: { user: { email: "dest@example.com" } }, error: null })),
      },
    },
  },
}));

const { notify } = await import("../src/engine/notify.js");

function okResponse() {
  return { ok: true, text: async () => "" } as unknown as Response;
}

describe("notify — timeout AbortSignal sur les fetch (P0 IAO 2026-09-26 sous-lot 5)", () => {
  beforeEach(() => fetchMock.mockReset());

  it("in-app seul : 1 fetch vers agent-push-send, AVEC signal de timeout branché", async () => {
    fetchMock.mockResolvedValue(okResponse());

    await notify({ userId: "u1", agentType: "compta", title: "t", body: "b", channels: ["in_app"] });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.signal).toBeInstanceOf(AbortSignal); // le branchement du timeout est la garantie testée
  });

  it("channel email : 2e fetch vers Resend, également borné par un signal", async () => {
    fetchMock.mockResolvedValue(okResponse());

    await notify({ userId: "u1", agentType: "compta", title: "t", body: "b", channels: ["in_app", "email"] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const resendOptions = fetchMock.mock.calls[1] as unknown[] as [string, RequestInit];
    expect(resendOptions[0]).toContain("api.resend.com");
    expect(resendOptions[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("borne réelle : chaque fetch de notification est borné à 15s via AbortSignal.timeout", async () => {
    // AbortSignal.timeout s'appuie sur un timer natif non fakeable — on vérifie donc le
    // BRANCHEMENT (chaque fetch reçoit une borne de 15_000ms). Le comportement
    // "abort → rejet du fetch" est une garantie native d'undici, pas du code testé ;
    // l'aval du rejet par loop.ts (.catch non fatal) est déjà couvert par loop.test.ts.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(okResponse());

    await notify({ userId: "u1", agentType: "compta", title: "t", body: "b", channels: ["in_app", "email"] });

    expect(timeoutSpy).toHaveBeenCalledTimes(2); // agent-push-send + Resend
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 15_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 15_000);
    timeoutSpy.mockRestore();
  });

  it("réponse HTTP en erreur → message FR avec statut (comportement inchangé)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => "upstream" } as unknown as Response);

    await expect(
      notify({ userId: "u1", agentType: "compta", title: "t", body: "b" })
    ).rejects.toThrow(/agent-push-send a répondu 502/);
  });
});
