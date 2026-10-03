import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ready: false, verify: vi.fn() }));
vi.mock("../src/runtime.js", () => ({
  isRuntimeReady: () => h.ready,
  verifyRuntimeDependencies: h.verify,
}));
vi.mock("../src/engine/opsAlert.js", () => ({
  sanitizeOpsMessage: (value: string) => value,
}));

const { handleRequest } = await import("../src/api/server.js");

function responseCapture() {
  const result = { status: 0, body: {} as Record<string, unknown> };
  const response = {
    writeHead(status: number) { result.status = status; },
    end(body: string) { result.body = JSON.parse(body) as Record<string, unknown>; },
  } as unknown as ServerResponse;
  return { response, result };
}

async function get(path: string) {
  const { response, result } = responseCapture();
  await handleRequest({ method: "GET", url: path, headers: {} } as IncomingMessage, response);
  return result;
}

describe("API health/readiness", () => {
  beforeEach(() => {
    h.ready = false;
    h.verify.mockReset().mockResolvedValue(undefined);
  });

  it("garde la liveness indépendante des services externes", async () => {
    expect(await get("/health")).toMatchObject({ status: 200, body: { status: "ok" } });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("refuse la readiness avant la fin du bootstrap", async () => {
    expect(await get("/ready")).toMatchObject({ status: 503, body: { status: "not_ready" } });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("retire la readiness dès qu'une dépendance tombe", async () => {
    h.ready = true;
    h.verify.mockRejectedValue(new Error("redis down"));
    expect(await get("/ready")).toMatchObject({ status: 503, body: { status: "not_ready" } });
  });

  it("confirme la readiness après bootstrap et vérification fraîche", async () => {
    h.ready = true;
    expect(await get("/ready")).toMatchObject({ status: 200, body: { status: "ready" } });
    expect(h.verify).toHaveBeenCalledOnce();
  });
});
