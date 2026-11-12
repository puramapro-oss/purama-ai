import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({ config: {
  supabaseUrl: "https://usage-db-fixture.invalid", supabaseServiceRoleKey: "fixture-not-a-secret", schema: "purama_ai",
} }));
vi.mock("../src/queue/redis.js", () => ({ redisConnection: { status: "ready", ping: async () => "PONG" } }));
import { probeRuntime } from "../src/runtime/probe.js";
import { bounded } from "../src/runtime/lifecycle.js";

const network = vi.fn<typeof fetch>();
let missingUsageColumn = false;
const urls: URL[] = [];
beforeEach(() => {
  network.mockReset(); urls.length = 0; missingUsageColumn = false;
  vi.stubGlobal("fetch", network);
  network.mockImplementation(async resource => {
    const url = new URL(resource instanceof Request ? resource.url : String(resource));
    urls.push(url);
    const table = url.pathname.split("/").at(-1);
    let status = 200;
    let body: unknown = [];
    if (table === "karta_approval_outbox_health") body = { protocol: 1, ready: true };
    if (table === "karta_global_state") body = { kill_switch: false };
    if (table === "karta_runs" && missingUsageColumn && url.searchParams.get("select")?.split(",").includes("model_usage")) {
      status = 400; body = { code: "42703", message: "column karta_runs.model_usage does not exist" };
    }
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("model usage schema admission through the real Supabase SDK", () => {
  it("checks the usage column in the existing zero-row schema probe without an extra request", async () => {
    await expect(bounded(probeRuntime, 1000)).resolves.toEqual({ globalKillSwitch: false });
    const calls = urls.filter(url => url.pathname.endsWith("/karta_runs"));
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("select")).toBe("execution_fingerprint,model_usage");
    expect(calls[0].searchParams.get("limit")).toBe("0");
    expect(network).toHaveBeenCalledTimes(4);
    expect(urls.every(url => url.origin === "https://usage-db-fixture.invalid")).toBe(true);
  });

  it("refuses readiness on the previous schema instead of admitting a run whose close cannot be recorded", async () => {
    missingUsageColumn = true;
    await expect(bounded(probeRuntime, 1000)).rejects.toThrow("Dépendances KARTA indisponibles ou incompatibles");
    expect(network).toHaveBeenCalledTimes(4);
  });
});
