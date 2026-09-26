import { describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, TOOL_FETCH_TIMEOUT_MS } from "../src/lib/bounded-fetch.js";

describe("fetchWithTimeout — borne native des appels d'outils tiers (P0 IAO sous-lot 7)", () => {
  it("délègue au fetch global en préservant l'init et en ajoutant le signal", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      await fetchWithTimeout("https://api.tavily.com/search", { method: "POST", headers: { A: "b" } });

      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("tavily");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ A: "b" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("borne par défaut 25s — VOLONTAIREMENT sous les 30s de withToolTimeout (l'abort natif gagne la course)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      await fetchWithTimeout("https://x.example/api");
      expect(timeoutSpy).toHaveBeenCalledWith(25_000);
      expect(TOOL_FETCH_TIMEOUT_MS).toBe(25_000);
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("borne explicite prioritaire sur le défaut", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      await fetchWithTimeout("https://x.example/api", undefined, 5_000);
      expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
