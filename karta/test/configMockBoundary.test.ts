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
});
