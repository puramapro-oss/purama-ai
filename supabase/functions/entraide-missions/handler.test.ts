// Tests du transport HTTP. Les règles transactionnelles sont testées sur PostgreSQL séparément.
import assert from "node:assert/strict";
import { createMissionsHandler, type MissionCommand, type MissionsBackend } from "./handler.ts";
import { assertEntraideRateLimit } from "../_shared/entraide-http.ts";

const missionId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";
const creation = { request_id: requestId, title: "  Cuisine solidaire  ", description: "Préparer ensemble.", min_participants: 2, max_participants: 3 };

function request(method = "GET", suffix = "", body?: unknown, authenticated = true) {
  return new Request(`https://example.test/functions/v1/entraide-missions${suffix}`, {
    method, headers: { ...(authenticated ? { Authorization: "Bearer test-token" } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

function fixture(overrides: Partial<MissionsBackend> = {}, realLimit = false) {
  const commands: MissionCommand[] = [];
  let authCalls = 0;
  const backend: MissionsBackend = {
    getUserId: async () => "30000000-0000-4000-8000-000000000001",
    listMissions: async () => ({ data: [{ id: missionId, organizer_id: "owner", version: 1 }], error: null }),
    mutateMission: async (command) => {
      commands.push(command);
      return { data: { mission: { id: missionId }, replayed: false }, error: null };
    },
    ...overrides,
  };
  return {
    commands,
    authCalls: () => authCalls,
    handle: createMissionsHandler({
      createBackend: () => { authCalls++; return backend; },
      limit: realLimit ? assertEntraideRateLimit : () => {},
    }),
  };
}

Deno.test("HTTP: preflight 204 sans authentification, méthodes annoncées", async () => {
  const f = fixture();
  const response = await f.handle(request("OPTIONS", "", undefined, false));
  assert.equal(response.status, 204);
  assert.equal(f.authCalls(), 0);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
});

Deno.test("HTTP: absence ou refus de session donne 401 sans écriture", async () => {
  const f = fixture();
  assert.equal((await f.handle(request("GET", "", undefined, false))).status, 401);
  assert.equal(f.authCalls(), 0);
  const invalid = fixture({ getUserId: async () => null });
  const response = await invalid.handle(request("POST", "", creation));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "auth_required");
  assert.equal(invalid.commands.length, 0);
});

Deno.test("HTTP: liste JSON, CORS et absence de cache partagé", async () => {
  const response = await fixture().handle(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /application\/json/);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
  assert.equal((await response.json()).missions[0].version, 1);
});

Deno.test("HTTP: création 201, identité de requête transmise et aucun acteur fourni à la RPC", async () => {
  const f = fixture();
  const response = await f.handle(request("POST", "", creation));
  assert.equal(response.status, 201);
  assert.deepEqual(f.commands, [{ p_request_id: requestId, p_action: "create", p_mission_id: null,
    p_expected_version: null, p_payload: { title: "Cuisine solidaire", description: creation.description,
      min_participants: 2, max_participants: 3 } }]);
});

Deno.test("HTTP: reprise de création retourne 200 et conserve le marqueur replayed", async () => {
  const f = fixture({ mutateMission: async () => ({ data: { mission: { id: missionId }, replayed: true }, error: null }) });
  const response = await f.handle(request("POST", "", creation));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).replayed, true);
});

Deno.test("HTTP: données invalides et tentative de forger le propriétaire refusées avant RPC", async () => {
  for (const body of ["{", null, [], { ...creation, organizer_id: "other" },
    { ...creation, request_id: "bad" }, { ...creation, title: "  " },
    { ...creation, min_participants: 3, max_participants: 2 },
    { ...creation, min_participants: 2.5 }, { ...creation, min_participants: 2147483648 },
    { ...creation, description: "x".repeat(2001) }]) {
    const f = fixture();
    assert.equal((await f.handle(request("POST", "", body))).status, 400, JSON.stringify(body));
    assert.equal(f.commands.length, 0);
  }
});

Deno.test("HTTP: version requise seulement pour les commandes organisateur", async () => {
  for (const action of ["start", "complete", "cancel"]) {
    const f = fixture();
    assert.equal((await f.handle(request("POST", `/${missionId}/${action}`, { request_id: requestId }))).status, 400);
    assert.equal((await f.handle(request("POST", `/${missionId}/${action}`, { request_id: requestId, expected_version: 4 }))).status, 200);
    assert.equal(f.commands[0].p_expected_version, 4);
  }
  for (const action of ["join", "leave"]) {
    const f = fixture();
    assert.equal((await f.handle(request("POST", `/${missionId}/${action}`, { request_id: requestId }))).status, 200);
    assert.equal(f.commands[0].p_expected_version, null);
  }
});

for (const [code, status] of Object.entries({ organizer_required: 403, mission_not_found: 404,
  stale_mission: 409, request_id_conflict: 409, mission_full: 409, already_joined: 409,
  not_a_participant: 409, not_ready: 409, not_in_progress: 409, mission_closed: 409,
  mission_not_recruiting: 409, already_closed: 409 })) {
  Deno.test(`HTTP: erreur métier ${code} → ${status}`, async () => {
    const f = fixture({ mutateMission: async () => ({ data: null, error: { code: "P0001", message: code } }) });
    const response = await f.handle(request("POST", `/${missionId}/join`, { request_id: requestId }));
    assert.equal(response.status, status);
    assert.equal((await response.json()).error, code);
  });
}

Deno.test("HTTP: une erreur interne ne divulgue ni SQL ni secrets", async () => {
  const f = fixture({ mutateMission: async () => ({ data: null, error: { code: "XX000", message: "secret internal database details" } }) });
  const response = await f.handle(request("POST", "", creation));
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /internal_error/);
  assert.doesNotMatch(body, /secret|database details/);
});

Deno.test("HTTP: limitation réellement appliquée, la onzième création n'atteint pas la RPC", async () => {
  const f = fixture({ getUserId: async () => "rate-test-" + requestId }, true);
  for (let i = 0; i < 10; i++) assert.equal((await f.handle(request("POST", "", creation))).status, 201);
  const response = await f.handle(request("POST", "", creation));
  assert.equal(response.status, 429);
  assert.equal(f.commands.length, 10);
  assert.equal((await response.json()).error, "rate_limited");
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
});

Deno.test("HTTP: méthode ou route inconnue ne déclenche aucune mutation", async () => {
  const f = fixture();
  const response = await f.handle(request("DELETE"));
  assert.equal(response.status, 405);
  assert.match(response.headers.get("Allow") ?? "", /POST/);
  for (const suffix of ["/bad/join", `/${missionId}/unknown`, `/${missionId}/join/extra`, `/${missionId}`]) {
    assert.equal((await f.handle(request("POST", suffix, {}))).status, 404);
  }
  assert.equal(f.commands.length, 0);
});
