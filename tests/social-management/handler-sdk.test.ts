import { handler } from "../revenue/serve-fixture.ts";

// Uses tests/social-connection/deno.json and the real installed Supabase SDK.
// Only serve and HTTP transport are injected; production handlers are imported.
await import("../../supabase/functions/social-accounts/index.ts");
const accountsHandler = handler();
await import("../../supabase/functions/social-autopilot-config/index.ts");
const configHandler = handler();

function equal(actual: unknown, expected: unknown) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
}
function check(value: unknown, message: string) { if (!value) throw new Error(message); }
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

const userId = "11111111-1111-4111-8111-111111111111";
const otherUser = "22222222-2222-4222-8222-222222222222";
const accountRowId = "33333333-3333-4333-8333-333333333333";
const providerProfile = "aaaaaaaaaaaaaaaaaaaaaaaa";
const providerAccount = "bbbbbbbbbbbbbbbbbbbbbbbb";
const serviceKey = "management-sdk-service-role-test-key";
const previousTime = "2026-11-09T10:00:00.000Z";
const savedTime = "2026-11-10T10:00:00.000Z";
const env = {
  SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  SOCIAL_DB_SCHEMA: "public", ZERNIO_API_KEY: "provider-test-key",
  ZERNIO_BASE_URL: "https://zernio.com/api/v1",
};
interface Call { method: string; url: URL; body: Record<string, unknown> | null }
interface Options { pending?: boolean; ready?: boolean; providerKey?: boolean; configConflict?: boolean }

async function fixture(options: Options, work: (f: {
  calls: Call[]; account: Record<string, unknown>; config: Record<string, unknown>;
}) => Promise<void>) {
  const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  if (!options.providerKey) Deno.env.delete("ZERNIO_API_KEY");
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  const account: Record<string, unknown> = {
    id: accountRowId, user_id: userId, platform: "youtube",
    zernio_account_id: providerAccount, zernio_profile_id: providerProfile,
    publishing_verified_at: previousTime, is_active: !options.pending,
    disconnect_pending: options.pending ?? false,
    disconnect_reconcile_ready: options.ready ?? false,
    connected_at: previousTime,
  };
  const config: Record<string, unknown> = {
    user_id: userId, autopilot_enabled: false, auto_caption: true, auto_hashtags: true,
    default_platforms: ["youtube"], timezone: "Europe/Paris", updated_at: previousTime,
  };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    const rawBody = ["GET", "HEAD"].includes(request.method) ? "" : await request.text();
    const body = rawBody ? JSON.parse(rawBody) : null;
    calls.push({ method: request.method, url, body });
    if (url.origin === "https://database.example") {
      if (url.pathname === "/auth/v1/user") {
        equal(request.headers.get("Authorization"), "Bearer valid-user-token");
        return json({ id: userId, aud: "authenticated", role: "authenticated", email: "fixture@example.test",
          app_metadata: {}, user_metadata: {}, created_at: previousTime });
      }
      equal(request.headers.get("Authorization"), `Bearer ${serviceKey}`);
      equal(request.headers.get(request.method === "GET" ? "Accept-Profile" : "Content-Profile"), "public");
      equal(url.searchParams.get("user_id"), "eq." + userId);
      if (url.pathname === "/rest/v1/social_accounts") {
        if (request.method === "GET") {
          if (url.searchParams.has("platform")) equal(url.searchParams.get("platform"), "eq.youtube");
          return json([account]);
        }
        if (request.method === "PATCH") {
          equal(url.searchParams.get("id"), "eq." + accountRowId);
          equal(url.searchParams.get("platform"), "eq.youtube");
          equal(url.searchParams.get("zernio_account_id"), "eq." + providerAccount);
          equal(url.searchParams.get("zernio_profile_id"), "eq." + providerProfile);
          equal(url.searchParams.get("publishing_verified_at"), "eq." + previousTime);
          equal(url.searchParams.get("is_active"), "eq.false");
          equal(url.searchParams.get("disconnect_pending"), "eq.true");
          equal(url.searchParams.get("select"), "id");
          equal(body.disconnect_pending, false); equal(body.disconnect_reconcile_ready, false);
          equal(Object.keys(body).length, 2);
          Object.assign(account, body);
          return json([{ id: accountRowId }]);
        }
      }
      if (url.pathname === "/rest/v1/social_profile_bindings" && request.method === "GET") {
        return json([{ user_id: userId, zernio_profile_id: providerProfile, creation_status: "ready" }]);
      }
      if (url.pathname === "/rest/v1/social_autopilot_config") {
        if (request.method === "GET") return json([config]);
        if (request.method === "PATCH") {
          equal(url.searchParams.get("updated_at"), "eq." + previousTime);
          equal(request.headers.get("Accept"), "application/vnd.pgrst.object+json");
          equal(body.user_id, userId); equal(body.auto_caption, false); equal(body.auto_hashtags, false);
          if (options.configConflict) return json({ code: "PGRST116", details: "The result contains 0 rows",
            message: "Cannot coerce the result to a single JSON object", hint: null }, 406);
          Object.assign(config, body, { updated_at: savedTime });
          return json(config);
        }
      }
    }
    if (url.origin === "https://zernio.com") {
      equal(request.method, "GET"); equal(url.pathname, "/api/v1/accounts");
      equal(request.headers.get("Authorization"), "Bearer provider-test-key");
      equal(url.searchParams.get("profileId"), providerProfile);
      equal(url.searchParams.get("includeOverLimit"), "true");
      equal(url.searchParams.get("excludeHidden"), "false");
      equal(url.searchParams.has("status"), false);
      return json({ accounts: [], pagination: { limit: 100, nextCursor: null } });
    }
    throw new Error(`Unexpected injected request ${request.method} ${url.origin}${url.pathname}`);
  };
  try { await work({ calls, account, config }); }
  finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
    }
  }
}

function request(route: string, method = "GET", body?: unknown, authenticated = true) {
  return new Request(`https://database.example/functions/v1/${route}`, {
    method, headers: authenticated ? { Authorization: "Bearer valid-user-token" } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const providerCalls = (calls: Call[]) => calls.filter((call) => call.url.origin === "https://zernio.com");
const patches = (calls: Call[]) => calls.filter((call) => call.method === "PATCH");

Deno.test("actual management GET routes use authenticated ownership without a provider key", async () => {
  await fixture({}, async (f) => {
    equal((await accountsHandler(request("social-accounts", "GET", undefined, false))).status, 401);
    equal((await configHandler(request("social-autopilot-config", "GET", undefined, false))).status, 401);
    equal(f.calls.length, 0);
    const accounts = await accountsHandler(request("social-accounts?user_id=" + otherUser));
    equal(accounts.status, 200); const rows = await accounts.json();
    equal(rows.length, 1); equal(rows[0].user_id, userId);
    const config = await configHandler(request("social-autopilot-config?user_id=" + otherUser));
    equal(config.status, 200); const value = await config.json();
    equal(value.user_id, userId); equal(value.auto_caption, false); equal(value.auto_hashtags, false);
    equal(providerCalls(f.calls).length, 0); equal(patches(f.calls).length, 0);
  });
});

Deno.test("actual pending-ready retry confirms complete provider absence with GET then clears both flags by conditional PATCH", async () => {
  await fixture({ pending: true, ready: true, providerKey: true }, async (f) => {
    const response = await accountsHandler(request("social-accounts?platform=youtube", "DELETE"));
    equal(response.status, 200); const value = await response.json();
    equal(value.success, true); equal(value.provider_disconnected, true);
    equal(providerCalls(f.calls).length, 1); equal(providerCalls(f.calls)[0].method, "GET");
    equal(patches(f.calls).length, 1); equal(f.account.disconnect_pending, false);
    equal(f.account.disconnect_reconcile_ready, false); equal(f.account.is_active, false);
    const providerIndex = f.calls.indexOf(providerCalls(f.calls)[0]);
    check(f.calls.indexOf(patches(f.calls)[0]) > providerIndex, "The conditional release must follow provider evidence");
    equal(f.calls.filter((call) => call.method === "DELETE").length, 0);
  });
});

Deno.test("actual pending-not-ready retry performs no provider GET, DELETE or release PATCH", async () => {
  await fixture({ pending: true, ready: false, providerKey: true }, async (f) => {
    const response = await accountsHandler(request("social-accounts?platform=youtube", "DELETE"));
    equal(response.status, 202); const value = await response.json();
    equal(value.success, false); equal(value.provider_disconnected, false);
    equal(providerCalls(f.calls).length, 0); equal(patches(f.calls).length, 0);
    equal(f.account.disconnect_pending, true); equal(f.account.disconnect_reconcile_ready, false);
  });
});

Deno.test("actual configuration CAS filters owner and observed timestamp; zero-row PostgREST result becomes 409", async () => {
  await fixture({ configConflict: true }, async (f) => {
    const response = await configHandler(request("social-autopilot-config", "POST", { timezone: "UTC" }));
    equal(response.status, 409); const value = await response.json();
    check(typeof value.error === "string", "A configuration conflict must return a user-facing error");
    equal(patches(f.calls).length, 1); equal(f.config.timezone, "Europe/Paris");
    equal(f.calls.filter((call) => call.method === "POST").length, 0);
    equal(providerCalls(f.calls).length, 0);
  });
});

Deno.test("actual configuration CAS returns the saved server row after a conditional SDK PATCH", async () => {
  await fixture({}, async (f) => {
    const response = await configHandler(request("social-autopilot-config", "PUT", { timezone: "UTC" }));
    equal(response.status, 200); const value = await response.json();
    equal(value.user_id, userId); equal(value.timezone, "UTC"); equal(value.updated_at, savedTime);
    equal(value.auto_caption, false); equal(value.auto_hashtags, false);
    equal(patches(f.calls).length, 1); equal(providerCalls(f.calls).length, 0);
  });
});
