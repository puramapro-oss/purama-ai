import { afterEach, describe, expect, it, vi } from "vitest";

async function loadConfig(environment: string, provider: string, fallback = "none") {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", environment);
  vi.stubEnv("AI_PROVIDER", provider);
  vi.stubEnv("AI_FALLBACK_PROVIDER", fallback);
  return import("../src/config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("mock provider boundary", () => {
  it.each(["test", "development"])("autorise le mock explicitement en %s", async (environment) => {
    await expect(loadConfig(environment, "mock")).resolves.toBeDefined();
  });

  it("refuse le mock principal en production", async () => {
    await expect(loadConfig("production", "mock")).rejects.toThrow(/reserve aux environnements test et development/);
  });

  it("refuse aussi un fallback mock en production", async () => {
    await expect(loadConfig("production", "anthropic", "mock")).rejects.toThrow(/reserve aux environnements test et development/);
  });

  it("refuse une clé service_role vide en production", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("KARTA_ADMIN_TOKEN", "admin-test-token");
    await expect(loadConfig("production", "anthropic")).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("refuse une API interne sans token admin en production", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
    vi.stubEnv("KARTA_ADMIN_TOKEN", "");
    await expect(loadConfig("production", "anthropic")).rejects.toThrow(/KARTA_ADMIN_TOKEN/);
  });
});
