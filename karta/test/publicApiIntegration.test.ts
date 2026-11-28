import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsultationSqlFixture } from "./consultationSqlFixture.js";
import { createConsultationHost } from "../src/claude/consultation-host.js";
import type { ConsultationRpcClient } from "../src/claude/consultation-store.js";
import { createPublicApiRuntime, generateIaoApiKey } from "../src/api/public-api-runtime.js";
import { startApiServer } from "../src/api/server.js";
import type { ConsultationOperation } from "../src/api/consultation-contract.js";

vi.mock("../src/db/supabase.js", () => ({ supabase: {} }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: {} }));
vi.mock("../src/agents/customAgent.js", () => ({ loadCustomAgent: vi.fn() }));
vi.mock("../src/engine/approval.js", () => ({ resolvePendingAction: vi.fn() }));
vi.mock("../src/engine/killswitch.js", () => ({ setGlobalKillSwitch: vi.fn() }));

const OWNER = "00000000-0000-4000-8000-000000000991";
const PROJECT_A = "00000000-0000-4000-8000-000000000992";
const PROJECT_B = "00000000-0000-4000-8000-000000000993";
const OPERATION = "00000000-0000-4000-8000-000000000994";
const request = { operationId: OPERATION, question: "Question privée", preferences: { model: "qualified-model" } };
const policy = JSON.stringify({ version: "fixture-v1", expiresAt: "2099-01-01T00:00:00Z",
  models: [{ model: "qualified-model", maxInputTokens: 32768, maxOutputTokens: 1024, maxCostMicros: 40 }] });
const keyA = generateIaoApiKey();
const keyB = generateIaoApiKey();
let fixture: Awaited<ReturnType<typeof createConsultationSqlFixture>>;
let beforeRpc: ((name: string, args: Record<string, unknown>) => Promise<void>) | undefined;
const network = vi.fn<typeof fetch>();
const servers: ReturnType<typeof startApiServer>[] = [];
const query = (sql: string, args: unknown[] = []) => fixture.db.query<Record<string, unknown>>(sql, args);
const client: ConsultationRpcClient = {
  rpc(name, args) {
    if (!/^(model_consultation|iao_api)_[a-z_]+$/.test(name) || Object.keys(args).some(k => !/^p_[a-z_]+$/.test(k))) {
      throw new Error("Unexpected test RPC");
    }
    return { async abortSignal(signal) {
      signal.throwIfAborted();
      await beforeRpc?.(name, args);
      try {
        const values = Object.values(args).map(v => v !== null && typeof v === "object" ? JSON.stringify(v) : v);
        const names = Object.keys(args).map((k, i) => `${k}=>$${i + 1}`).join(",");
        const result = await fixture.db.query<{ data: unknown }>(`SELECT purama_ai.${name}(${names}) AS data`, values);
        return { data: result.rows[0].data, error: null };
      } catch (error) { return { data: null, error: { code: String((error as { code?: string }).code ?? "unknown") } }; }
    } };
  },
};
function runtime() {
  return createPublicApiRuntime({ client, createHost: store => createConsultationHost({
    store, policyJson: policy, apiKey: "fixture-provider-key", simulation: false, stopped: async () => false,
    loadCatalog: async () => [{ model: "qualified-model", reasoning: "none", maxOutputTokens: 1024 }],
  }) });
}
async function listen(enabled = true) {
  const server = startApiServer(async () => ({ ready: true, phase: "ready", globalKillSwitch: false }), {
    consultationHost: null, publicApiRuntime: enabled ? runtime() : null,
  });
  await once(server, "listening"); servers.push(server); return server;
}
function call(server: Server, path: string, method = "GET", body?: unknown, key = keyA.key) {
  return new Promise<{ status: number; body: { code?: string; operation?: ConsultationOperation; catalog?: { available: boolean; models: unknown[] } }; raw: string }>((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback port missing");
    const req = httpRequest({ host: "127.0.0.1", port: address.port, path, method,
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    }, res => {
      let raw = ""; res.setEncoding("utf8").on("data", chunk => { raw += chunk; });
      res.once("end", () => resolve({ status: res.statusCode!, body: JSON.parse(raw), raw }));
    });
    req.once("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
function providerResponse() {
  return new Response(JSON.stringify({ id: "msg_api_fixture", type: "message", role: "assistant", model: "qualified-model", stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ answer: "Réponse conservée", citedSourceIds: [], disagreements: [], uncertainties: ["Non vérifié"] }) }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
  }), { status: 200, headers: { "content-type": "application/json" } });
}
async function provision() {
  await query("SELECT purama_ai.model_consultation_provision($1,1000000,10000,'2099-01-01',4)", [OWNER]);
}
beforeAll(async () => {
  fixture = await createConsultationSqlFixture();
  await fixture.db.exec("RESET ROLE");
  await fixture.db.exec(await readFile(new URL("../migrations/039_iao_public_api.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await fixture.db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await query("INSERT INTO auth.users VALUES($1)", [OWNER]);
  await fixture.db.exec("SET ROLE service_role");
  for (const [project, key] of [[PROJECT_A, keyA], [PROJECT_B, keyB]] as const) {
    await query(`INSERT INTO purama_ai.iao_api_projects(id,user_id,name,expires_at,allowed_models,max_operation_cost_micros,requests_per_minute)
      VALUES($1,$2,'Fixture','2099-01-01',ARRAY['qualified-model'],100,600)`, [project, OWNER]);
    await query(`INSERT INTO purama_ai.iao_api_keys(id,project_id,key_hash,scopes,expires_at)
      VALUES($1,$2,$3,ARRAY['catalog','create','read','cancel'],'2099-01-01')`, [key.keyId, project, key.keyHash]);
  }
  beforeRpc = undefined;
  network.mockReset(); network.mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("fixture-provider-key");
    return providerResponse();
  });
  vi.stubGlobal("fetch", network);
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await server.drainRequests();
  }
  vi.unstubAllGlobals();
});
afterAll(async () => { await fixture?.close(); });

describe("public HTTP → project authority → existing Council/CHEF → installed SDK", () => {
  it("isolates two projects of one owner and resumes after restart without another inference", async () => {
    await provision(); const first = await listen();
    expect((await call(first, "/v1/iao/models")).body.catalog?.available).toBe(true);
    const result = await call(first, "/v1/iao/consultations", "POST", request);
    expect(result.status).toBe(200);
    expect(result.body.operation).toMatchObject({ operationId: OPERATION, status: "reconciliation_required", result: { answer: "Réponse conservée" } });
    expect(network).toHaveBeenCalledOnce();
    const privateBinding = (await query("SELECT internal_operation_id FROM purama_ai.iao_api_operations WHERE project_id=$1", [PROJECT_A])).rows[0];
    expect(result.raw).not.toContain(String(privateBinding.internal_operation_id));
    expect(result.raw).not.toContain(keyA.key); expect(result.raw).not.toContain(OWNER);
    expect((await call(first, `/v1/iao/consultations/${OPERATION}`, "GET", undefined, keyB.key)).status).toBe(404);
    const restarted = await listen();
    expect((await call(restarted, "/v1/iao/consultations", "POST", request)).body).toEqual(result.body);
    expect((await call(restarted, `/v1/iao/consultations/${OPERATION}`)).body).toEqual(result.body);
    expect((await call(restarted, "/v1/iao/consultations", "POST", { ...request, question: "Changed" })).status).toBe(409);
    expect(network).toHaveBeenCalledOnce();
    expect((await call(restarted, "/v1/iao/consultations", "POST", request, keyB.key)).status).toBe(200);
    expect(network).toHaveBeenCalledTimes(2);
    const ids = (await query("SELECT internal_operation_id FROM purama_ai.iao_api_operations")).rows.map(row => row.internal_operation_id);
    expect(new Set(ids).size).toBe(2);
    expect((await query("SELECT count(*)::int AS n FROM purama_ai.chef_missions WHERE kind='consultation'")).rows[0].n).toBe(1);
    expect((await query("SELECT actual_cost_micros FROM purama_ai.chef_budget_reservations")).rows.every(row => row.actual_cost_micros === null)).toBe(true);
  });
  it("keeps the public API closed unless explicitly configured and never grants admin access", async () => {
    const server = await listen(false);
    expect((await call(server, "/v1/iao/models")).status).toBe(503);
    const configured = await listen();
    expect((await call(configured, "/kill-switch/global", "POST", { active: true })).status).toBe(401);
    expect(network).not.toHaveBeenCalled();
  });
  it("does not allocate resources when the shared owner budget is absent", async () => {
    const result = await call(await listen(), "/v1/iao/consultations", "POST", request);
    expect(result).toMatchObject({ status: 429, body: { code: "IAO_BUDGET" } });
    expect(network).not.toHaveBeenCalled();
    expect((await query("SELECT count(*)::int AS n FROM purama_ai.chef_missions")).rows[0].n).toBe(0);
  });
  it("rechecks key revocation at reservation before dispatch", async () => {
    await provision();
    beforeRpc = async (name, args) => {
      if (name === "iao_api_consultation_call" && args.p_method === "reserve") {
        await query("UPDATE purama_ai.iao_api_keys SET revoked_at=clock_timestamp() WHERE id=$1", [keyA.keyId]);
      }
    };
    expect(await call(await listen(), "/v1/iao/consultations", "POST", request)).toMatchObject({ status: 401, body: { code: "IAO_API_UNAUTHORIZED" } });
    expect(network).not.toHaveBeenCalled();
  });
  it("records already-dispatched usage even when its key was revoked in flight", async () => {
    await provision(); network.mockImplementation(async () => {
      await query("UPDATE purama_ai.iao_api_keys SET revoked_at=clock_timestamp() WHERE id=$1", [keyA.keyId]);
      return providerResponse();
    });
    const server = await listen();
    const result = await call(server, "/v1/iao/consultations", "POST", request);
    expect(result.status).toBe(200); expect(result.body.operation?.status).toBe("reconciliation_required");
    expect((await query("SELECT actual_input_tokens,actual_cost_micros FROM purama_ai.chef_budget_reservations")).rows[0]).toEqual({ actual_input_tokens: 10, actual_cost_micros: null });
    expect((await call(server, `/v1/iao/consultations/${OPERATION}`)).status).toBe(401);
    expect(network).toHaveBeenCalledOnce();
  });
  it("enforces project cost ceilings before allocating or dispatching", async () => {
    await provision();
    await query("UPDATE purama_ai.iao_api_projects SET max_operation_cost_micros=39 WHERE id=$1", [PROJECT_A]);
    expect(await call(await listen(), "/v1/iao/consultations", "POST", request)).toMatchObject({ status: 429, body: { code: "IAO_API_LIMIT" } });
    expect(network).not.toHaveBeenCalled();
    expect((await query("SELECT count(*)::int AS n FROM purama_ai.chef_budget_reservations")).rows[0].n).toBe(0);
  });
  it("persists cancellation before create without cancelling another project", async () => {
    await provision(); const server = await listen();
    expect((await call(server, `/v1/iao/consultations/${OPERATION}/cancel`, "POST")).body.operation?.status).toBe("cancelled");
    expect((await call(server, "/v1/iao/consultations", "POST", request)).body.operation?.status).toBe("cancelled");
    expect(network).not.toHaveBeenCalled();
    expect((await call(server, "/v1/iao/consultations", "POST", request, keyB.key)).body.operation?.result?.answer).toBe("Réponse conservée");
    expect(network).toHaveBeenCalledOnce();
  });
  it("filters inaccessible models and refuses forged authority in requests", async () => {
    await provision(); const server = await listen();
    await query("UPDATE purama_ai.iao_api_projects SET allowed_models=ARRAY['another-model'] WHERE id=$1", [PROJECT_A]);
    expect((await call(server, "/v1/iao/models")).body.catalog).toMatchObject({ available: false, models: [] });
    expect((await call(server, "/v1/iao/consultations", "POST", request)).status).toBe(403);
    expect((await call(server, "/v1/iao/consultations", "POST", { ...request, userId: OWNER })).status).toBe(400);
    expect(network).not.toHaveBeenCalled();
  });
  it("does not disclose a completed answer to a cancellation-only key", async () => {
    await provision(); const server = await listen();
    expect((await call(server, "/v1/iao/consultations", "POST", request)).status).toBe(200);
    const cancellationKey = generateIaoApiKey();
    await query(`INSERT INTO purama_ai.iao_api_keys(id,project_id,key_hash,scopes,expires_at)
      VALUES($1,$2,$3,ARRAY['cancel'],'2099-01-01')`, [cancellationKey.keyId, PROJECT_A, cancellationKey.keyHash]);
    expect((await call(server, `/v1/iao/consultations/${OPERATION}`, "GET", undefined, cancellationKey.key)).status).toBe(403);
    const cancelled = await call(server, `/v1/iao/consultations/${OPERATION}/cancel`, "POST", undefined, cancellationKey.key);
    expect(cancelled.status).toBe(200);
    expect(Object.keys(cancelled.body.operation!).sort()).toEqual(["cancelRequested", "operationId", "status"]);
    expect(cancelled.raw).not.toContain("Réponse conservée");
    expect(network).toHaveBeenCalledOnce();
  });
  it("interrupts an in-flight call on local cancellation and retains its uncertain receipt", async () => {
    await provision(); let dispatched!: () => void;
    const dispatch = new Promise<void>(resolve => { dispatched = resolve; });
    network.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      dispatched(); init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const server = await listen();
    const pending = call(server, "/v1/iao/consultations", "POST", request);
    await dispatch;
    const cancelled = await call(server, `/v1/iao/consultations/${OPERATION}/cancel`, "POST");
    expect(cancelled.body.operation?.cancelRequested).toBe(true);
    expect((await pending).body.operation?.status).toBe("reconciliation_required");
    expect((await query("SELECT state FROM purama_ai.model_consultation_calls")).rows[0].state).toBe("uncertain");
    expect(network).toHaveBeenCalledOnce();
  });
  it("drains delayed settlement after shutdown has already ended the HTTP response", async () => {
    await provision();
    let dispatched!: () => void; let settling!: () => void; let release!: () => void;
    const dispatch = new Promise<void>(resolve => { dispatched = resolve; });
    const settlement = new Promise<void>(resolve => { settling = resolve; });
    const settled = new Promise<void>(resolve => { release = resolve; });
    network.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      dispatched(); init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    beforeRpc = async name => { if (name === "model_consultation_settle") { settling(); await settled; } };
    const lifetime = new AbortController();
    const server = startApiServer(async () => ({ ready: true, phase: "ready", globalKillSwitch: false }), {
      consultationHost: null, publicApiRuntime: runtime(), lifetime: lifetime.signal,
    });
    await once(server, "listening"); servers.push(server);
    const pending = call(server, "/v1/iao/consultations", "POST", request);
    await dispatch; lifetime.abort(); await settlement;
    expect((await pending).status).toBe(503);
    let drained = false;
    const draining = server.drainRequests().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(drained).toBe(false);
    release(); await draining;
    expect((await query("SELECT state FROM purama_ai.model_consultation_calls")).rows[0].state).toBe("uncertain");
    expect((await query("SELECT actual_cost_micros FROM purama_ai.chef_budget_reservations")).rows[0].actual_cost_micros).toBeNull();
    expect(network).toHaveBeenCalledOnce();
  });
});
