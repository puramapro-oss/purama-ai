import test from "node:test";
import assert from "node:assert/strict";
import { createFounderDashboardHandler, FOUNDER_EMAIL } from "../../supabase/functions/founder-dashboard/handler.ts";
import { createDashboardReader } from "../../supabase/functions/founder-dashboard/reader.ts";
const OWNER = "ac7b6572-f0a9-4dee-942a-c3d751b2dd08";
const OTHER = "2cc38348-9f36-4d2b-a0a0-4985cab858b4";
const PROFILE = "a4484cef-6859-47e3-9e82-018bc98aa39d";
const ORIGIN = "https://one.purama.dev";
const DATE = "2026-11-10T03:00:00.000Z";
const URL = "https://auth.example.test/functions/v1/founder-dashboard";
const AUTH = { Authorization: "Bearer test-token", Origin: ORIGIN };
function fixture(overrides = {}) {
  const calls = [];
  const state = {
    user: { id: OWNER, email: FOUNDER_EMAIL, email_confirmed_at: DATE },
    allowed: true,
    authError: null,
    readerError: null,
    results: {
      profiles: { count: 15, error: null },
      activeSubscriptions: { count: 4, error: null },
      enabledAgents: { count: 12, error: null },
      recentProfiles: { data: [{ id: PROFILE, full_name: "Exemple", created_at: DATE }], error: null },
    },
  };
  const read = (key, signal) => {
    calls.push(["read", key, signal]);
    const result = state.results[key];
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  const deps = {
    founderUserId: OWNER,
    allowedOrigin: ORIGIN,
    authenticate: async (token) => {
      calls.push(["authenticate", token]);
      if (state.authError) throw state.authError;
      return state.user;
    },
    rateLimit: (...args) => { calls.push(["limit", ...args]); return { allowed: state.allowed }; },
    createReader: () => {
      calls.push(["admin"]);
      if (state.readerError) throw state.readerError;
      return {
        countProfiles: (signal) => read("profiles", signal),
        countActiveSubscriptions: (signal) => read("activeSubscriptions", signal),
        countEnabledAgents: (signal) => read("enabledAgents", signal),
        recentProfiles: (signal) => read("recentProfiles", signal),
      };
    },
    now: () => new Date(DATE),
    ...overrides,
  };
  return { calls, state, handler: createFounderDashboardHandler(deps) };
}
const request = (method = "GET", headers = AUTH, url = URL) => new Request(url, { method, headers });
function privateHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Authorization, Origin");
  assert.notEqual(response.headers.get("access-control-allow-origin"), "*");
}
function noPrivilegedAccess(calls) {
  assert.equal(calls.some(([kind]) => kind === "admin" || kind === "read"), false);
}
test("verified owner receives only the bounded contract, after authorization", async () => {
  const f = fixture();
  const response = await f.handler(request());
  assert.equal(response.status, 200);
  privateHeaders(response);
  assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
  assert.deepEqual(f.calls.slice(0, 3), [
    ["authenticate", "test-token"], ["limit", "founder-dashboard:" + OWNER, 30, 60_000], ["admin"],
  ]);
  assert.deepEqual(await response.json(), {
    version: 1, scope: "purama_ai", observedAt: DATE,
    metrics: {
      profiles: { status: "available", value: 15 },
      activeSubscriptions: { status: "available", value: 4 },
      enabledAgents: { status: "available", value: 12 },
    },
    recentProfiles: { status: "available", items: [{ id: PROFILE, full_name: "Exemple", created_at: DATE }] },
  });
});
for (const authorization of [undefined, "", "Basic abc", "Bearer", "Bearer a b"]) {
  test("missing or malformed authorization fails without admin access: " + String(authorization), async () => {
    const f = fixture();
    const response = await f.handler(request("GET", authorization ? { Authorization: authorization } : {}));
    assert.equal(response.status, 401);
    privateHeaders(response);
    assert.equal(f.calls.length, 0);
  });
}
for (const [name, user] of [
  ["another account", { id: OTHER, email: "other@example.test", email_confirmed_at: DATE }],
  ["same email but wrong immutable ID", { id: OTHER, email: FOUNDER_EMAIL, email_confirmed_at: DATE }],
  ["same ID but wrong email", { id: OWNER, email: "other@example.test", email_confirmed_at: DATE }],
  ["unconfirmed email", { id: OWNER, email: FOUNDER_EMAIL }],
  ["phone-only confirmation", { id: OWNER, email: FOUNDER_EMAIL, confirmed_at: DATE }],
  ["malformed email confirmation", { id: OWNER, email: FOUNDER_EMAIL, email_confirmed_at: "true" }],
  ["forged metadata or roles", { id: OTHER, email: "other@example.test", email_confirmed_at: DATE,
    user_metadata: { id: OWNER, email: FOUNDER_EMAIL, role: "super_admin" }, app_metadata: { role: "owner" } }],
]) {
  test("owner gate rejects " + name, async () => {
    const f = fixture();
    f.state.user = user;
    const response = await f.handler(request());
    assert.equal(response.status, 403);
    privateHeaders(response);
    noPrivilegedAccess(f.calls);
    assert.equal(f.calls.some(([kind]) => kind === "limit"), false);
  });
}
for (const founderUserId of [undefined, "", "not-a-uuid", "00000000-0000-0000-0000-000000000000",
  "00000000-0000-4000-8000-000000000000", " " + OWNER]) {
  test("missing or placeholder owner configuration fails closed: " + String(founderUserId), async () => {
    const f = fixture({ founderUserId });
    const response = await f.handler(request("GET", AUTH, URL + "?founderUserId=" + OWNER));
    assert.equal(response.status, 503);
    privateHeaders(response);
    assert.equal(f.calls.length, 0);
  });
}
test("expired/invalid session and provider failure never construct an admin client", async () => {
  for (const brokenProvider of [false, true]) {
    const f = fixture();
    f.state.user = null;
    if (brokenProvider) f.state.authError = new Error("private-provider-token-and-host");
    const response = await f.handler(request());
    assert.equal(response.status, brokenProvider ? 503 : 401);
    assert.equal((await response.text()).includes("private-provider"), false);
    privateHeaders(response);
    noPrivilegedAccess(f.calls);
  }
});
test("read-only methods and preflight do not authenticate or query", async () => {
  const f = fixture();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
    const response = await f.handler(request(method));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, OPTIONS");
    privateHeaders(response);
  }
  const preflight = await f.handler(request("OPTIONS", { Origin: ORIGIN, "Access-Control-Request-Method": "GET" }));
  assert.equal(preflight.status, 204);
  privateHeaders(preflight);
  assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  const rejected = await f.handler(request("OPTIONS", { Origin: ORIGIN, "Access-Control-Request-Method": "POST" }));
  assert.equal(rejected.status, 405);
  assert.equal(f.calls.length, 0);
});
test("CORS rejects unconfigured or lookalike origins and allows no-Origin authenticated clients", async () => {
  for (const allowedOrigin of [undefined, "*", ORIGIN + "/", "http://one.purama.dev"]) {
    const f = fixture({ allowedOrigin });
    const response = await f.handler(request());
    assert.equal(response.status, 403);
    privateHeaders(response);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    noPrivilegedAccess(f.calls);
  }
  for (const Origin of [ORIGIN + ".attacker.test", "null", "https://evil.test"]) {
    const f = fixture();
    const response = await f.handler(request("GET", { ...AUTH, Origin }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    noPrivilegedAccess(f.calls);
  }
  const f = fixture({ allowedOrigin: undefined });
  const response = await f.handler(request("GET", { Authorization: AUTH.Authorization }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});
test("rate limit and missing service configuration fail without reading data or leaking errors", async () => {
  const limited = fixture();
  limited.state.allowed = false;
  const denied = await limited.handler(request());
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "60");
  privateHeaders(denied);
  noPrivilegedAccess(limited.calls);
  const unavailable = fixture();
  unavailable.state.readerError = new Error("service-role-private-value");
  const response = await unavailable.handler(request());
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("service-role-private-value"), false);
  assert.equal(unavailable.calls.some(([kind]) => kind === "read"), false);
});
test("database errors stay unavailable while actual zeros survive; the next request can recover", async () => {
  const f = fixture();
  f.state.results.profiles = { count: 0, error: null };
  f.state.results.activeSubscriptions = { count: 9, error: { message: "secret database host" } };
  f.state.results.recentProfiles = new Error("private DB details");
  let response = await f.handler(request());
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.deepEqual(body.metrics.profiles, { status: "available", value: 0 });
  assert.deepEqual(body.metrics.activeSubscriptions, { status: "unavailable", value: null });
  assert.deepEqual(body.metrics.enabledAgents, { status: "available", value: 12 });
  assert.deepEqual(body.recentProfiles, { status: "unavailable", items: [] });
  assert.equal(JSON.stringify(body).includes("secret"), false);
  f.state.results.activeSubscriptions = { count: 3, error: null };
  f.state.results.recentProfiles = { data: [], error: null };
  response = await f.handler(request());
  body = await response.json();
  assert.deepEqual(body.metrics.activeSubscriptions, { status: "available", value: 3 });
  assert.deepEqual(body.recentProfiles, { status: "available", items: [] });
  assert.equal(f.calls.filter(([kind]) => kind === "authenticate").length, 2);
});
test("malformed counts and profile results never become plausible data", async () => {
  for (const count of [null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "12"]) {
    const f = fixture();
    f.state.results.profiles = { count, error: null };
    f.state.results.recentProfiles = { data: [{ id: PROFILE, full_name: "X", created_at: "invalid" }], error: null };
    const body = await (await f.handler(request())).json();
    assert.deepEqual(body.metrics.profiles, { status: "unavailable", value: null });
    assert.deepEqual(body.recentProfiles, { status: "unavailable", items: [] });
  }
});
test("profile output strips all extra properties and never returns more than ten profiles", async () => {
  const f = fixture();
  f.state.results.recentProfiles.data = Array.from({ length: 14 }, (_, index) => ({
    id: (index + 1).toString(16).padStart(8, "0") + PROFILE.slice(8), full_name: null, created_at: null, email: "private@example.test", user_metadata: { secret: true },
  }));
  const body = await (await f.handler(request())).json();
  assert.equal(body.recentProfiles.items.length, 10);
  assert.deepEqual(Object.keys(body.recentProfiles.items[0]), ["id", "full_name", "created_at"]);
  assert.equal(JSON.stringify(body).includes("private@example.test"), false);
});
test("reader uses exact counts, subscription state filters and bounded explicit profile selection", async () => {
  const queries = [];
  const client = { from: (table) => {
    const operations = [["from", table]];
    queries.push(operations);
    const query = { then: (resolve, reject) => Promise.resolve({ count: 0, data: [], error: null }).then(resolve, reject) };
    for (const method of ["select", "eq", "neq", "not", "order", "limit", "abortSignal"]) {
      query[method] = (...args) => { operations.push([method, ...args]); return query; };
    }
    return query;
  } };
  const reader = createDashboardReader(client);
  const signal = new AbortController().signal;
  await Promise.all([reader.countProfiles(signal), reader.countActiveSubscriptions(signal), reader.countEnabledAgents(signal), reader.recentProfiles(signal)]);
  queries.forEach((query) => assert.deepEqual(query.pop(), ["abortSignal", signal]));
  for (const query of queries.slice(0, 3)) {
    assert.deepEqual(query[1], ["select", "id", { count: "exact", head: true }]);
    assert.equal(query.some(([operation]) => operation === "limit"), false);
  }
  assert.deepEqual(queries[1].slice(2), [
    ["eq", "status", "active"], ["not", "plan_type", "is", null], ["neq", "plan_type", "free"], ["neq", "plan_type", ""],
  ]);
  assert.deepEqual(queries[2].slice(2), [["eq", "is_active", true]]);
  assert.deepEqual(queries[3], [
    ["from", "profiles"], ["select", "id, full_name, created_at"], ["order", "created_at", { ascending: false }], ["limit", 10],
  ]);
});
test("malformed recent profiles degrade only the list, preserving useful metrics", async () => {
  const row = { id: PROFILE, full_name: "Nom", created_at: DATE };
  for (const data of [[{ ...row, full_name: "x".repeat(501) }], [{ ...row, created_at: "November 10, 2026" }], [row, row]]) {
    const f = fixture();
    f.state.results.recentProfiles = { data, error: null };
    const body = await (await f.handler(request())).json();
    assert.deepEqual(body.recentProfiles, { status: "unavailable", items: [] });
    assert.deepEqual(body.metrics.profiles, { status: "available", value: 15 });
  }
});
test("deadline covers an authentication body suspended after headers", { timeout: 1000 }, async () => {
  let signal, bodyController;
  const f = fixture({ requestTimeoutMs: 5, authenticate: async (_token, receivedSignal) => {
    signal = receivedSignal;
    const body = new ReadableStream({ start(controller) { bodyController = controller; } });
    await new Response(body, { status: 200 }).json();
    return { id: OWNER, email: FOUNDER_EMAIL, email_confirmed_at: DATE };
  } });
  const response = await f.handler(request());
  bodyController.close();
  assert.equal(response.status, 503);
  assert.equal(signal.aborted, true);
  privateHeaders(response);
  noPrivilegedAccess(f.calls);
});
test("one shared deadline bounds all SDK reads even if a provider ignores cancellation", { timeout: 1000 }, async () => {
  let authSignal;
  const f = fixture({ requestTimeoutMs: 10, authenticate: async (_token, signal) => {
    authSignal = signal;
    await new Promise((resolve) => setTimeout(resolve, 2));
    return { id: OWNER, email: FOUNDER_EMAIL, email_confirmed_at: DATE };
  } });
  f.state.results.profiles = new Promise(() => {});
  const response = await f.handler(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.metrics.profiles, { status: "unavailable", value: null });
  assert.deepEqual(body.metrics.activeSubscriptions, { status: "available", value: 4 });
  assert.equal(authSignal.aborted, true);
  assert.equal(f.calls.filter(([kind]) => kind === "read").every((call) => call[2] === authSignal), true);
});
