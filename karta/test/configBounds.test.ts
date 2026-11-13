import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv/config", () => ({})); // Never load an on-disk environment file.
import { boundedMilliseconds, config } from "../src/config.js";

afterEach(() => vi.unstubAllEnvs());

describe("lifecycle timeout bounds", () => {
  it("has finite defaults inside the Docker stop grace", () => {
    expect(config.shutdownTimeoutMs).toBe(30_000);
    expect(config.readinessTimeoutMs).toBe(5_000);
    expect(boundedMilliseconds("ABSENT_KARTA_TEST_TIMEOUT", 50, 10, 100)).toBe(50);
  });

  it.each(["", " ", "NaN", "Infinity", "-1", "0", "1.5", "2147483648", "121000"] )("rejects invalid shutdown deadline %j", (value) => {
    vi.stubEnv("KARTA_TEST_TIMEOUT", value);
    expect(() => boundedMilliseconds("KARTA_TEST_TIMEOUT", 30_000, 1_000, 120_000)).toThrow();
  });

  it.each(["1000", "120000"])("accepts the boundary %s", (value) => {
    vi.stubEnv("KARTA_TEST_TIMEOUT", value);
    expect(boundedMilliseconds("KARTA_TEST_TIMEOUT", 30_000, 1_000, 120_000)).toBe(Number(value));
  });
});
