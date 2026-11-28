import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createConsultationSqlFixture } from "./consultationSqlFixture.js";
import { normalizeConsultationRequest } from "../src/claude/consultation.js";
import { resolveModelExecutionPlan } from "../src/claude/execution-profile.js";

const OWNER = "00000000-0000-4000-8000-000000000981";
const OTHER = "00000000-0000-4000-8000-000000000982";
const EXTERNAL = "00000000-0000-4000-8000-000000000983";
const MODEL = "qualified-model";
const FUTURE = "2099-01-01T00:00:00Z";
const scopes = ["catalog", "read", "create", "cancel"];
let fixture: Awaited<ReturnType<typeof createConsultationSqlFixture>>;
type Credential = { projectId: string; keyId: string; hash: string };
type Created = { created: boolean; generation: string; operation: { operationId: string; state: string } };
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const plan = resolveModelExecutionPlan({ model: MODEL }, [{ model: MODEL, reasoning: "none", maxOutputTokens: 1024 }]);
const estimates = { policyVersion: "api-test-v1", calls: [
  { kind: "synthesis", provider: "anthropic", model: MODEL, maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 1024, maxCostMicros: 50 },
] };
async function scalar<T>(sql: string, args: unknown[] = []): Promise<T> {
  return (await fixture.db.query<{ value: T }>(sql, args)).rows[0].value;
}
async function credential(options: { owner?: string; scopes?: string[]; cap?: number; rate?: number; projectId?: string } = {}): Promise<Credential> {
  const projectId = options.projectId ?? await scalar<string>(`INSERT INTO purama_ai.iao_api_projects
    (user_id,name,expires_at,allowed_models,max_operation_cost_micros,requests_per_minute)
    VALUES($1,'API test project',$2,$3,$4,$5) RETURNING id AS value`,
  [options.owner ?? OWNER, FUTURE, [MODEL], options.cap ?? 100, options.rate ?? 60]);
  // The fixture stores only a one-way digest. No real provider/developer key is used.
  const hash = fingerprint(randomUUID());
  const keyId = await scalar<string>(`INSERT INTO purama_ai.iao_api_keys(project_id,key_hash,scopes,expires_at)
    VALUES($1,$2,$3,$4) RETURNING id AS value`, [projectId, hash, options.scopes ?? scopes, FUTURE]);
  return { projectId, keyId, hash };
}
const authorize = (key: Credential, scope = "create", consume = false) => scalar<Record<string, unknown>>(
  "SELECT purama_ai.iao_api_authorize($1,$2,$3) AS value", [key.hash, scope, consume]);
const bind = (key: Credential, id = EXTERNAL, create = true, scope = "create") => scalar<string | null>(
  "SELECT purama_ai.iao_api_bind_operation($1,$2,$3,$4) AS value", [key.hash, id, create, scope]);
const rpc = <T = unknown>(key: Credential, external: string | null, method: string, args: unknown) => scalar<T>(
  "SELECT purama_ai.iao_api_consultation_call($1,$2,$3,$4::jsonb) AS value", [key.hash, external, method, JSON.stringify(args)]);
const identity = (internal: string, owner = OWNER) => ({ p_user_id: owner, p_operation_id: internal });
function createArgs(internal: string, question = "Question privée", owner = OWNER) {
  const request = normalizeConsultationRequest({ userId: owner, operationId: internal, question, preferences: { model: MODEL } });
  return { ...identity(internal, owner), p_request_hash: fingerprint(request), p_request: request, p_plan: plan, p_estimates: estimates };
}
const call = (internal: string, callId = "api-call-1") => ({ userId: OWNER, operationId: internal, callId,
  kind: "synthesis", provider: "anthropic", model: MODEL, inputHash: "b".repeat(64), maxOutputTokens: 1024 });
async function provision(cost = 1000) {
  return scalar<string>("SELECT purama_ai.model_consultation_provision($1,100000,$2,$3,4) AS value", [OWNER, cost, FUTURE]);
}
async function begin(key: Credential, external = EXTERNAL) {
  const internal = (await bind(key, external))!;
  const args = createArgs(internal);
  const created = await rpc<Created>(key, external, "create", args);
  return { internal, args, created };
}
async function start(key: Credential, value: Awaited<ReturnType<typeof begin>>, external = EXTERNAL) {
  return rpc<boolean>(key, external, "start", { ...identity(value.internal), p_request_hash: value.args.p_request_hash, p_generation: value.created.generation });
}
const reserve = (key: Credential, value: Awaited<ReturnType<typeof begin>>, callId = "api-call-1") => rpc<boolean>(key, EXTERNAL, "reserve",
  { ...identity(value.internal), p_generation: value.created.generation, p_call: call(value.internal, callId) });

beforeAll(async () => {
  fixture = await createConsultationSqlFixture();
  await fixture.db.exec("RESET ROLE");
  await fixture.db.exec(await readFile(new URL("../migrations/039_iao_public_api.sql", import.meta.url), "utf8"));
});
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => {
  await fixture.db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await fixture.db.query("INSERT INTO auth.users VALUES($1),($2)", [OWNER, OTHER]);
  await fixture.db.exec("SET ROLE service_role");
});

describe("public API SQL identity and existing CHEF admission", () => {
  it("returns a bounded grant without hashes, credentials or invented funding", async () => {
    const key = await credential();
    expect(await authorize(key)).toEqual({ keyId: key.keyId, projectId: key.projectId, userId: OWNER,
      allowedModels: [MODEL], maxOperationCostMicros: 100 });
    expect(await rpc(key, null, "availability", { p_user_id: OWNER })).toBe(false);
    const internal = await bind(key);
    await expect(rpc(key, EXTERNAL, "create", createArgs(internal!))).rejects.toMatchObject({ code: "PCO02" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.chef_missions")).toBe(0);
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.chef_budget_reservations")).toBe(0);
  });

  it("isolates identical external IDs across projects owned by the same account and across accounts", async () => {
    const a = await credential(); const b = await credential(); const c = await credential({ owner: OTHER });
    const internalA = (await bind(a))!; const internalB = (await bind(b))!; const internalC = (await bind(c))!;
    expect(new Set([internalA, internalB, internalC]).size).toBe(3);
    await provision();
    await rpc(a, EXTERNAL, "create", createArgs(internalA));
    expect(await rpc(b, EXTERNAL, "status", identity(internalB))).toBeNull();
    expect(await rpc(c, EXTERNAL, "status", identity(internalC, OTHER))).toBeNull();
    await expect(rpc(b, EXTERNAL, "status", identity(internalA))).rejects.toMatchObject({ code: "PIA02" });
    await expect(rpc(b, EXTERNAL, "cancel", identity(internalA))).rejects.toMatchObject({ code: "PIA02" });
    await expect(rpc(c, EXTERNAL, "status", identity(internalA))).rejects.toMatchObject({ code: "PIA02" });
    expect(await rpc(a, EXTERNAL, "status", identity(internalA))).toMatchObject({ operationId: internalA, cancelRequested: false });
  });

  it("shares a project's namespace across rotated keys while retaining durable idempotency", async () => {
    const a = await credential(); const rotated = await credential({ projectId: a.projectId });
    // PGlite serializes its single connection. This tests persistence/invariants,
    // not native PostgreSQL multi-connection locking or replica behaviour.
    const bindings = await Promise.all([bind(a), bind(rotated), bind(a)]);
    expect(new Set(bindings).size).toBe(1);
    await provision(); const first = await begin(a);
    expect(await rpc(rotated, EXTERNAL, "create", first.args)).toMatchObject({ created: false, operation: first.created.operation });
    await expect(rpc(rotated, EXTERNAL, "create", createArgs(first.internal, "Changed content"))).rejects.toMatchObject({ code: "PCO01" });
    const { p_plan: _plan, p_estimates: _estimates, ...resume } = first.args;
    expect(await rpc(rotated, EXTERNAL, "resume", resume)).toMatchObject({ operationId: first.internal, state: "pending" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.chef_budget_reservations")).toBe(1);
  });

  it("does not expose or cancel an ordinary UI operation through a developer binding", async () => {
    await provision(); const ui = createArgs(EXTERNAL);
    await scalar("SELECT purama_ai.model_consultation_create($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) AS value",
      [OWNER, EXTERNAL, ui.p_request_hash, JSON.stringify(ui.p_request), JSON.stringify(plan), JSON.stringify(estimates)]);
    const key = await credential(); const internal = (await bind(key))!;
    expect(internal).not.toBe(EXTERNAL);
    expect(await rpc(key, EXTERNAL, "status", identity(internal))).toBeNull();
    await expect(rpc(key, EXTERNAL, "cancel", identity(EXTERNAL))).rejects.toMatchObject({ code: "PIA02" });
    expect(await scalar("SELECT purama_ai.model_consultation_status($1,$2) AS value", [OWNER, EXTERNAL])).toMatchObject({ cancelRequested: false });
  });

  it("preserves cancellation before a delayed create without allocating CHEF resources", async () => {
    const key = await credential(); const cancelKey = await credential({ projectId: key.projectId, scopes: ["cancel"] });
    const internal = (await bind(cancelKey, EXTERNAL, true, "cancel"))!;
    expect(await rpc(cancelKey, EXTERNAL, "cancel", identity(internal))).toMatchObject({ state: "cancelled" });
    expect(await bind(key)).toBe(internal);
    expect(await rpc(key, EXTERNAL, "create", createArgs(internal))).toMatchObject({ created: false, operation: { state: "cancelled" } });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.chef_missions")).toBe(0);
  });

  it("enforces each scope without giving read-only keys the power to bind new operations", async () => {
    const key = await credential({ scopes: ["read"] });
    expect(await authorize(key, "read")).toMatchObject({ projectId: key.projectId });
    for (const scope of ["create", "cancel", "catalog"]) await expect(authorize(key, scope)).rejects.toMatchObject({ code: "PIA02" });
    await expect(bind(key, EXTERNAL, true, "read")).rejects.toMatchObject({ code: "PIA05" });
    expect(await bind(key, EXTERNAL, false, "read")).toBeNull();
    await expect(bind(key)).rejects.toMatchObject({ code: "PIA02" });
    await expect(rpc(key, null, "availability", { p_user_id: OWNER })).rejects.toMatchObject({ code: "PIA02" });
  });

  it.each(["unknown", "revoked", "key-expired", "project-expired", "disabled"])("fails closed for %s authority", async reason => {
    const key = await credential();
    if (reason === "unknown") key.hash = "0".repeat(64);
    if (reason === "revoked") await fixture.db.query("UPDATE purama_ai.iao_api_keys SET revoked_at=now() WHERE id=$1", [key.keyId]);
    if (reason === "key-expired") await fixture.db.query("UPDATE purama_ai.iao_api_keys SET expires_at=now()-interval '1 second' WHERE id=$1", [key.keyId]);
    if (reason === "project-expired") await fixture.db.query("UPDATE purama_ai.iao_api_projects SET expires_at=now()-interval '1 second' WHERE id=$1", [key.projectId]);
    if (reason === "disabled") await fixture.db.query("UPDATE purama_ai.iao_api_projects SET active=false WHERE id=$1", [key.projectId]);
    await expect(authorize(key)).rejects.toMatchObject({ code: "PIA01" });
    await expect(bind(key)).rejects.toMatchObject({ code: "PIA01" });
  });

  it("counts admission durably per project, across keys, without counting internal rechecks", async () => {
    const key = await credential({ rate: 2 }); const otherKey = await credential({ projectId: key.projectId });
    await authorize(key, "create", true); await authorize(otherKey, "create", true);
    await authorize(key); await bind(key); // Revalidation does not spend another admission slot.
    await expect(authorize(otherKey, "create", true)).rejects.toMatchObject({ code: "PIA03" });
    expect(await scalar("SELECT rate_count AS value FROM purama_ai.iao_api_projects WHERE id=$1", [key.projectId])).toBe(2);
    await fixture.db.query("UPDATE purama_ai.iao_api_projects SET rate_window=now()-interval '61 seconds' WHERE id=$1", [key.projectId]);
    await authorize(otherKey, "create", true);
    expect(await scalar("SELECT rate_count AS value FROM purama_ai.iao_api_projects WHERE id=$1", [key.projectId])).toBe(1);
  });

  it("never bypasses the existing owner budget when multiple projects reserve envelopes", async () => {
    await provision(50); const a = await credential(); const b = await credential();
    await begin(a);
    await expect(begin(b)).rejects.toMatchObject({ code: "PCO02" });
    expect(await scalar("SELECT sum(reserved_cost_micros)::int AS value FROM purama_ai.chef_budget_reservations")).toBe(50);
  });

  it("rejects unauthorized primary, reviewer and estimated models before reserving resources", async () => {
    const key = await credential(); const internal = (await bind(key))!; await provision();
    const base = createArgs(internal);
    const primary = { ...base, p_request: { ...base.p_request, preferences: { model: "not-permitted" } }, p_plan: { ...plan, model: "not-permitted" } };
    const reviewer = { ...base, p_request: { ...base.p_request, reviewerModels: ["not-permitted"] } };
    const estimate = { ...base, p_estimates: { ...estimates, calls: [{ ...estimates.calls[0], model: "not-permitted" }] } };
    for (const args of [primary, reviewer, estimate]) await expect(rpc(key, EXTERNAL, "create", args)).rejects.toMatchObject({ code: "PIA02" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.chef_budget_reservations")).toBe(0);
  });

  it("enforces the sum of all call ceilings using overflow-safe arithmetic", async () => {
    const key = await credential({ cap: 90 }); const internal = (await bind(key))!; await provision();
    const base = createArgs(internal);
    const twice = { ...base, p_estimates: { ...estimates, calls: [{ ...estimates.calls[0], maxCalls: 2 }] } };
    await expect(rpc(key, EXTERNAL, "create", twice)).rejects.toMatchObject({ code: "PIA04" });
    const huge = { ...base, p_estimates: { ...estimates, calls: [{ ...estimates.calls[0], maxCalls: 32, maxCostMicros: Number.MAX_SAFE_INTEGER }] } };
    await expect(rpc(key, EXTERNAL, "create", huge)).rejects.toMatchObject({ code: "PIA04" });
    for (const invalid of [null, "50", -1, 0.5]) {
      await expect(rpc(key, EXTERNAL, "create", { ...base, p_estimates: { ...estimates,
        calls: [{ ...estimates.calls[0], maxCostMicros: invalid }] } })).rejects.toMatchObject({ code: "PIA05" });
    }
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.chef_budget_reservations")).toBe(0);
  });

  it.each(["models", "ceiling", "revoked"])("rechecks %s after creation and before each provider admission", async change => {
    const key = await credential(); await provision(); const first = await begin(key);
    expect(await start(key, first)).toBe(true);
    if (change === "models") await fixture.db.query("UPDATE purama_ai.iao_api_projects SET allowed_models=ARRAY['other-model'] WHERE id=$1", [key.projectId]);
    if (change === "ceiling") await fixture.db.query("UPDATE purama_ai.iao_api_projects SET max_operation_cost_micros=49 WHERE id=$1", [key.projectId]);
    if (change === "revoked") await fixture.db.query("UPDATE purama_ai.iao_api_keys SET revoked_at=now() WHERE id=$1", [key.keyId]);
    await expect(reserve(key, first)).rejects.toMatchObject({ code: change === "models" ? "PIA02" : change === "ceiling" ? "PIA04" : "PIA01" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.model_consultation_calls")).toBe(0);
    if (change !== "revoked") {
      expect(await rpc(key, EXTERNAL, "status", identity(first.internal))).toMatchObject({ state: "running" });
      const { p_plan: _plan, p_estimates: _estimates, ...resume } = first.args;
      expect(await rpc(key, EXTERNAL, "resume", resume)).toMatchObject({ state: "running" });
    }
  });

  it("allows private evidence settlement after revocation but forbids public settlement RPCs", async () => {
    const key = await credential(); await provision(); const first = await begin(key);
    expect(await start(key, first)).toBe(true); expect(await reserve(key, first)).toBe(true);
    await fixture.db.query("UPDATE purama_ai.iao_api_keys SET revoked_at=now() WHERE id=$1", [key.keyId]);
    const receipt = { call: call(first.internal), status: "uncertain", usage: [] };
    expect(await scalar("SELECT purama_ai.model_consultation_settle($1,$2,$3,$4::jsonb) AS value",
      [OWNER, first.internal, first.created.generation, JSON.stringify(receipt)])).toBe(true);
    expect(await scalar("SELECT state AS value FROM purama_ai.model_consultation_calls")).toBe("uncertain");
    await expect(rpc(key, EXTERNAL, "settle", {})).rejects.toMatchObject({ code: "PIA05" });
    await expect(rpc(key, EXTERNAL, "finalize", {})).rejects.toMatchObject({ code: "PIA05" });
    expect(await scalar("SELECT actual_cost_micros AS value FROM purama_ai.chef_budget_reservations")).toBeNull();
  });

  it("rejects null and malformed start fingerprints without claiming the operation", async () => {
    const key = await credential(); await provision(); const first = await begin(key);
    for (const invalid of [null, 123, "short", "A".repeat(64), "a".repeat(64) + "\n"]) {
      await expect(rpc(key, EXTERNAL, "start", { ...identity(first.internal), p_generation: first.created.generation,
        p_request_hash: invalid })).rejects.toMatchObject({ code: "PIA05" });
    }
    expect(await rpc(key, EXTERNAL, "status", identity(first.internal))).toMatchObject({ state: "pending" });
    expect(await start(key, first)).toBe(true);
  });

  it("rejects method injection, extra authority arguments and mismatched request/call identities", async () => {
    const key = await credential(); const internal = (await bind(key))!; await provision();
    await expect(rpc(key, EXTERNAL, "status; select 1", identity(internal))).rejects.toMatchObject({ code: "PIA05" });
    await expect(rpc(key, EXTERNAL, "status", { ...identity(internal), p_admin: true })).rejects.toMatchObject({ code: "PIA05" });
    await expect(rpc(key, EXTERNAL, "create", { ...createArgs(internal), p_request: { ...createArgs(internal).p_request, userId: OTHER } })).rejects.toMatchObject({ code: "PIA05" });
    await expect(rpc(key, null, "availability", { p_user_id: OTHER })).rejects.toMatchObject({ code: "PIA02" });
    const first = await begin(key); expect(await start(key, first)).toBe(true);
    await expect(rpc(key, EXTERNAL, "reserve", { ...identity(internal), p_generation: first.created.generation,
      p_call: { ...call(internal), operationId: EXTERNAL } })).rejects.toMatchObject({ code: "PIA05" });
  });

  it("prevents owner/key rebinding and resurrection of a revoked credential", async () => {
    const a = await credential(); const b = await credential(); await bind(a);
    await expect(fixture.db.query("UPDATE purama_ai.iao_api_projects SET user_id=$1 WHERE id=$2", [OTHER, a.projectId])).rejects.toMatchObject({ code: "PIA05" });
    await expect(fixture.db.query("UPDATE purama_ai.iao_api_keys SET project_id=$1 WHERE id=$2", [b.projectId, a.keyId])).rejects.toMatchObject({ code: "PIA05" });
    await expect(fixture.db.query("UPDATE purama_ai.iao_api_keys SET key_hash=$1 WHERE id=$2", ["a".repeat(64), a.keyId])).rejects.toMatchObject({ code: "PIA05" });
    await expect(fixture.db.query("UPDATE purama_ai.iao_api_operations SET internal_operation_id=$1 WHERE project_id=$2", [randomUUID(), a.projectId])).rejects.toMatchObject({ code: "PIA05" });
    await fixture.db.query("UPDATE purama_ai.iao_api_keys SET revoked_at=now() WHERE id=$1", [a.keyId]);
    await expect(fixture.db.query("UPDATE purama_ai.iao_api_keys SET revoked_at=NULL WHERE id=$1", [a.keyId])).rejects.toMatchObject({ code: "PIA05" });
  });

  it.each(["anon", "authenticated"])("denies %s direct table access and RPC invocation", async role => {
    const key = await credential(); await fixture.db.exec(`SET ROLE ${role}`);
    for (const table of ["iao_api_projects", "iao_api_keys", "iao_api_operations"]) {
      await expect(fixture.db.query(`SELECT * FROM purama_ai.${table}`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(authorize(key)).rejects.toMatchObject({ code: "42501" });
    await expect(bind(key)).rejects.toMatchObject({ code: "42501" });
    await expect(rpc(key, null, "availability", { p_user_id: OWNER })).rejects.toMatchObject({ code: "42501" });
  });
});
