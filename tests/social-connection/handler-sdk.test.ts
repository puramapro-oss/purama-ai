import { handler } from "../revenue/serve-fixture.ts";

// Keep assertions independent of Node's ambient types: Deno's manual npm
// resolver otherwise tries to fetch an unpinned @types/node for node:assert.
const assert = Object.assign((value: unknown) => {
  if (!value) throw new Error("Assertion failed");
}, {
  equal(actual: unknown, expected: unknown) {
    if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  },
});

// The import map loads the genuine installed Supabase 2.91.0 package. Only HTTP
// transport and the serve listener are injected; no API/database is contacted.
await import("../../supabase/functions/social-connect/index.ts");
const connect = handler();
await import("../../supabase/functions/social-callback/index.ts");
const callback = handler();

const user = "11111111-1111-4111-8111-111111111111";
const bindingId = "33333333-3333-4333-8333-333333333333";
const profile = "aaaaaaaaaaaaaaaaaaaaaaaa";
const account = "bbbbbbbbbbbbbbbbbbbbbbbb";
const serviceKey = "service-role-test-key-at-least-thirty-two-characters";
const env = {
  SUPABASE_URL: "https://database.example", SUPABASE_ANON_KEY: "anonymous-test-key",
  SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  SOCIAL_STATE_SECRET: "separate-test-social-state-secret-at-least-thirty-two-characters",
  APP_URL: "https://app.example", CORS_ALLOWED_ORIGIN: "https://app.example",
  ZERNIO_API_KEY: "provider-test-key", SOCIAL_DB_SCHEMA: "public",
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function fixture(work: (f: {
  calls: string[]; intents: Map<string, Record<string, unknown>>;
  writes: Record<string, unknown>[]; begin(): Promise<Response>; callbackUrl(): URL;
  failBinding(): void; raceCancellation(): void;
}) => Promise<void>) {
  const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [], writes: Record<string, unknown>[] = [];
  const intents = new Map<string, Record<string, unknown>>();
  const row: Record<string, unknown> = {
    id: bindingId, user_id: user, external_id: "purama-ai:" + bindingId,
    profile_name: "PURAMA " + bindingId, creation_status: "pending", zernio_profile_id: null,
  };
  let providerProfile = false, redirect = "", failBinding = false, raceCancellation = false;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    const body = request.method === "GET" ? null : await request.json();
    calls.push(`${request.method} ${url.origin}${url.pathname}`);
    if (url.origin === "https://database.example") {
      if (url.pathname === "/auth/v1/user") {
        assert.equal(request.headers.get("Authorization"), "Bearer valid-user-token");
        return json({ id: user, aud: "authenticated", role: "authenticated", email: "fixture@example.test",
          app_metadata: {}, user_metadata: {}, created_at: "2026-11-10T00:00:00Z" });
      }
      assert.equal(request.headers.get("Authorization"), `Bearer ${serviceKey}`);
      assert.equal(request.headers.get(request.method === "GET" ? "Accept-Profile" : "Content-Profile"), "public");
      const rpc = url.pathname.split("/rpc/")[1];
      if (rpc === "social_get_or_create_profile_binding") { assert.equal(body.p_user_id, user); return json(row); }
      if (rpc === "social_claim_profile_creation") {
        assert.equal(body.p_binding_id, bindingId); row.creation_status = "creating"; return json(true);
      }
      if (rpc === "social_finish_profile_binding") {
        assert.equal(body.p_profile_id, profile); row.zernio_profile_id = profile; row.creation_status = "ready"; return json(null);
      }
      if (rpc === "social_begin_connection") {
        assert.equal(body.p_user_id, user); assert.equal(body.p_profile_id, profile);
        intents.set(body.p_state_hash, {
          state_hash: body.p_state_hash, user_id: body.p_user_id, platform: body.p_platform,
          zernio_profile_id: body.p_profile_id, nonce: body.p_nonce, issued_at: body.p_issued_at,
          expires_at: body.p_expires_at, status: "pending", zernio_account_id: null,
        }); return json(null);
      }
      if (rpc === "social_finish_connection") {
        if (failBinding) return json({ code: "XX000", message: "private database error", details: null, hint: null }, 500);
        writes.push(body); const intent = intents.get(body.p_state_hash)!;
        intent.status = "bound"; intent.zernio_account_id = body.p_account_id;
        return json({ status: "bound" });
      }
      if (url.pathname === "/rest/v1/social_connection_intents") {
        const hash = url.searchParams.get("state_hash")?.replace(/^eq\./, "");
        const intent = hash ? intents.get(hash) : undefined;
        if (request.method === "GET") return json(intent ? [intent] : []);
        if (request.method === "PATCH") {
          assert.equal(url.searchParams.get("status"), "eq.pending");
          assert.equal(url.searchParams.get("select"), "state_hash");
          assert.equal(request.headers.get("Accept"), "application/vnd.pgrst.object+json");
          if (raceCancellation && intent) { intent.status = "bound"; intent.zernio_account_id = account; }
          if (intent?.status !== "pending") return json({ code: "PGRST116", details: "The result contains 0 rows",
            message: "Cannot coerce the result to a single JSON object", hint: null }, 406);
          Object.assign(intent, body); return json({ state_hash: hash });
        }
      }
    }
    if (url.origin === "https://zernio.com") {
      assert.equal(request.headers.get("Authorization"), "Bearer provider-test-key");
      if (url.pathname === "/api/v1/profiles" && request.method === "GET") {
        assert.equal(url.searchParams.get("externalId"), row.external_id);
        return json({ profiles: providerProfile ? [{ _id: profile, name: row.profile_name, externalId: row.external_id }] : [], total: providerProfile ? 1 : 0 });
      }
      if (url.pathname === "/api/v1/profiles" && request.method === "POST") {
        assert.equal(request.headers.get("Idempotency-Key"), bindingId);
        providerProfile = true; return json({ profile: { _id: profile, ...body } }, 201);
      }
      if (url.pathname === "/api/v1/connect/youtube") {
        assert.equal(url.searchParams.get("profileId"), profile);
        redirect = url.searchParams.get("redirect_url")!;
        return json({ authUrl: "https://provider.example/authorize" });
      }
      if (url.pathname === "/api/v1/accounts") {
        assert.equal(url.searchParams.get("profileId"), profile);
        return json({ accounts: [{ _id: account, profileId: { _id: profile }, platform: "youtube",
          isActive: true, displayName: "Verified name", username: "verified-user" }], pagination: { limit: 100, nextCursor: null } });
      }
    }
    throw new Error(`Unexpected injected request ${request.method} ${url.origin}${url.pathname}`);
  };
  try {
    await work({ calls, intents, writes,
      begin: () => Promise.resolve(connect(new Request("https://database.example/functions/v1/social-connect", {
        method: "POST", headers: { Origin: "https://app.example", Authorization: "Bearer valid-user-token" },
        body: JSON.stringify({ platform: "youtube", userId: "forged-client-value", profileId: "forged-profile" }),
      }))),
      callbackUrl: () => {
        const url = new URL(redirect); url.searchParams.set("connected", "youtube");
        url.searchParams.set("profileId", profile); url.searchParams.set("accountId", account);
        return url;
      },
      failBinding: () => { failBinding = true; }, raceCancellation: () => { raceCancellation = true; },
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
    }
  }
}

Deno.test("actual routes plus real Supabase SDK complete a proven connection and keep replay inert", async () => {
  await fixture(async (f) => {
    const begin = await f.begin(); assert.equal(begin.status, 200); assert.equal((await begin.json()).url, "https://provider.example/authorize");
    const url = f.callbackUrl(); url.searchParams.set("account_name", "Forged name");
    const result = await callback(new Request(url));
    assert.equal(result.status, 302); assert.equal(new URL(result.headers.get("Location")!).searchParams.get("connected"), "youtube");
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].p_user_id, user);
    assert.equal(f.writes[0].p_account_name, "Verified name"); assert.equal(f.writes[0].p_account_id, account);
    const providerReads = f.calls.filter((call) => call.endsWith("/api/v1/accounts")).length;
    const replay = await callback(new Request(url));
    assert.equal(new URL(replay.headers.get("Location")!).searchParams.get("status"), "already_processed");
    assert.equal(f.writes.length, 1);
    assert.equal(f.calls.filter((call) => call.endsWith("/api/v1/accounts")).length, providerReads);
  });
});

Deno.test("actual callback never claims success when the database rejects finalization", async () => {
  await fixture(async (f) => {
    assert.equal((await f.begin()).status, 200); f.failBinding();
    const result = await callback(new Request(f.callbackUrl())); const redirect = new URL(result.headers.get("Location")!);
    assert.equal(redirect.searchParams.get("connected"), null); assert.equal(redirect.searchParams.get("error"), "social_storage_unavailable");
    assert(!redirect.href.includes("private")); assert.equal(f.writes.length, 0);
    assert.equal([...f.intents.values()][0].status, "pending");
  });
});

Deno.test("actual cancellation checks UPDATE RETURNING and does not hide a racing successful binding", async () => {
  for (const race of [false, true]) await fixture(async (f) => {
    assert.equal((await f.begin()).status, 200); if (race) f.raceCancellation();
    const url = f.callbackUrl(); url.searchParams.set("error", "access_denied");
    const response = await callback(new Request(url)); const redirect = new URL(response.headers.get("Location")!);
    if (race) {
      assert.equal(redirect.searchParams.get("status"), null); assert.equal(redirect.searchParams.get("error"), "social_state_already_closed");
      assert.equal([...f.intents.values()][0].status, "bound");
    } else {
      assert.equal(redirect.searchParams.get("status"), "cancelled"); assert.equal([...f.intents.values()][0].status, "cancelled");
    }
    assert.equal(f.writes.length, 0);
  });
});

Deno.test("actual routes reject missing auth and invalid state without network or provider reads", async () => {
  await fixture(async (f) => {
    const noAuth = await connect(new Request("https://database.example/functions/v1/social-connect", { method: "POST", body: "{}" }));
    assert.equal(noAuth.status, 401);
    const forged = await callback(new Request("https://database.example/functions/v1/social-callback?state=forged"));
    assert.equal(new URL(forged.headers.get("Location")!).searchParams.get("error"), "invalid_or_expired_social_state");
    assert.equal(f.calls.length, 0);
  });
});
