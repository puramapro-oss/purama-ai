import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { opsAlertUrl: "https://ops.example.test/alerts", opsAlertTimeoutMs: 2_000 },
  fetch: vi.fn(),
}));

vi.mock("../src/config.js", () => ({ config: mocks.config }));
const { alertOps } = await import("../src/engine/opsAlert.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.opsAlertUrl = "https://ops.example.test/alerts";
  mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => vi.unstubAllGlobals());

describe("ops alerts", () => {
  it("is disabled without a configured destination", async () => {
    mocks.config.opsAlertUrl = "";
    await alertOps("worker", "failed");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("uses a bounded request and redacts common credentials", async () => {
    await alertOps("scheduler", "Bearer token-value\ngsk_exampleSecret");
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe("https://ops.example.test/alerts");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body)).toMatchObject({
      source: "scheduler",
      message: "Bearer [REDACTED] [REDACTED]",
    });
  });

  it("rejects a non-HTTPS destination before making a request", async () => {
    mocks.config.opsAlertUrl = "http://ops.example.test/alerts";
    await expect(alertOps("worker", "failed")).rejects.toThrow("HTTPS");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reports a refused alert without exposing its response body", async () => {
    mocks.fetch.mockResolvedValue(new Response("private", { status: 403 }));
    await expect(alertOps("approval-reconciler", "failed")).rejects.toThrow("alerte ops refusee (403)");
  });
});
