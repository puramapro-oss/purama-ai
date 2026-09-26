import { describe, expect, it, vi } from "vitest";

process.env.SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

// Capture des options passées à createClient — le vrai client n'est jamais construit ici.
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ __mockClient: true })),
}));

const createClientMock = vi.mocked(await import("@supabase/supabase-js")).createClient;
const { supabase, boundedFetch } = await import("../src/db/supabase.js");

describe("db/supabase — borne globale des requêtes Supabase (P0 IAO 2026-09-26 sous-lot 6)", () => {
  it("le client est construit avec un custom fetch borné (global.fetch)", () => {
    expect(createClientMock).toHaveBeenCalledOnce();
    const options = createClientMock.mock.calls[0][2] as { global?: { fetch?: unknown } };
    expect(options.global?.fetch).toBeTypeOf("function");
    expect(options.global?.fetch).toBe(boundedFetch);
    expect(supabase).toEqual({ __mockClient: true });
  });

  it("boundedFetch délègue au fetch global AVEC une borne de 30s branchée (init préservé)", async () => {
    expect(boundedFetch).toBeTypeOf("function"); // le type supabase-js le déclare optionnel
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      await boundedFetch!("https://example.invalid/rest/v1/karta_runs", { method: "GET" });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("/rest/v1/karta_runs");
      expect(init.method).toBe("GET"); // l'init d'origine est préservé...
      expect(init.signal).toBeInstanceOf(AbortSignal); // ...et la borne est ajoutée
      expect(timeoutSpy).toHaveBeenCalledWith(30_000); // à la valeur exacte — pas timeout(1)
      timeoutSpy.mockRestore();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
