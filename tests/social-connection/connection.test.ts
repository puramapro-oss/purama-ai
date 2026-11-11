import assert from "node:assert/strict";
import { beginSocialConnection, finishSocialConnection, createSocialConnectHandler,
  createSocialCallbackHandler, socialDatabaseSchema, type SocialConnectionDependencies,
  type SocialConnectionStore, type SocialConnectionIntent, type SocialProfileBinding } from "../../supabase/functions/_shared/social-connection-core.ts";
import { createSocialCallbackState, verifySocialCallbackState } from "../../supabase/functions/_shared/social-state.ts";
import { createZernioConnectionProvider, SocialProviderError, type SocialConnectionProvider,
  type VerifiedSocialAccount } from "../../supabase/functions/_shared/social-connection-provider.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const otherUser = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";
const profileId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const accountId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const otherId = "cccccccccccccccccccccccc";
const secret = "test-social-state-secret-at-least-thirty-two-characters";
const callbackBaseUrl = "https://database.example/functions/v1/social-callback";

function fixture() {
  const binding: SocialProfileBinding = {
    id: bindingId, userId, profileId: null, externalId: "purama-ai:" + bindingId,
    profileName: "PURAMA " + bindingId, creationStatus: "pending",
  };
  const intents = new Map<string, SocialConnectionIntent>();
  const calls = { create: 0, verify: 0, finish: 0, dependencies: 0, callback: "" };
  const verified: VerifiedSocialAccount = {
    accountId, profileId, platform: "youtube", accountName: "Provider name", accountUsername: "provider-user", isActive: true,
  };
  let existing: { profileId: string; name: string; externalId: string }[] = [];
  const store: SocialConnectionStore = {
    getOrCreateProfile: async () => structuredClone(binding),
    claimProfileCreation: async () => {
      if (binding.creationStatus !== "pending") return false;
      binding.creationStatus = "creating"; return true;
    },
    recordProfileFailure: async (_id, uncertain) => { binding.creationStatus = uncertain ? "uncertain" : "pending"; },
    finishProfile: async (_id, id) => { binding.profileId = id; binding.creationStatus = "ready"; },
    beginIntent: async (intent) => {
      for (const row of intents.values()) if (row.platform === intent.platform && row.status === "pending") row.status = "superseded";
      intents.set(intent.stateHash, { ...intent, status: "pending", accountId: null });
    },
    readIntent: async (hash) => structuredClone(intents.get(hash) ?? null),
    cancelIntent: async (hash) => {
      const row = intents.get(hash);
      if (row?.status !== "pending") return false;
      row.status = "cancelled"; return true;
    },
    finishIntent: async (intent, account) => {
      calls.finish++; const row = intents.get(intent.stateHash)!;
      row.status = "bound"; row.accountId = account.accountId; return "bound";
    },
  };
  const provider: SocialConnectionProvider = {
    findProfiles: async () => existing,
    createProfile: async (input) => {
      calls.create++; assert.equal(input.idempotencyKey, bindingId);
      existing = [{ profileId, name: input.name, externalId: input.externalId }]; return existing[0];
    },
    getConnectUrl: async (input) => { calls.callback = input.callbackUrl; return "https://provider.example/authorize"; },
    listAccounts: async () => [verified],
    verifyAccount: async (input) => { calls.verify++; assert.equal(input.profileId, profileId); return { ...verified }; },
  };
  const deps: SocialConnectionDependencies = { store, provider, stateSecret: secret };
  const http = {
    appUrl: "https://app.example", callbackBaseUrl, stateSecret: secret,
    getUserId: async (request: Request) => request.headers.get("Authorization") === "Bearer valid" ? userId : null,
    getDependencies: () => { calls.dependencies++; return deps; },
  };
  async function begin() {
    return await beginSocialConnection({ userId, platform: "youtube", callbackBaseUrl }, deps);
  }
  function callback() {
    const url = new URL(calls.callback);
    url.searchParams.set("connected", "youtube"); url.searchParams.set("profileId", profileId);
    url.searchParams.set("accountId", accountId); return url;
  }
  return { binding, intents, calls, verified, store, provider, deps, http, begin, callback,
    setExisting: (value: typeof existing) => { existing = value; } };
}

Deno.test("state binds the user, platform and profile with a random one-use nonce", async () => {
  const a = await createSocialCallbackState({ userId, platform: "youtube", profileId }, secret);
  const b = await createSocialCallbackState({ userId, platform: "youtube", profileId }, secret);
  assert.notEqual(a.claims.nonce, b.claims.nonce); assert.notEqual(a.stateHash, b.stateHash);
  assert.deepEqual(await verifySocialCallbackState(a.state, secret), a.claims);
  for (const altered of [a.state.replace(userId, otherUser), a.state.replace("youtube", "tiktok"),
    a.state.replace(profileId, otherId), "%E0%A4%A", "legacy.10000000000000.signature", "x".repeat(900)]) {
    assert.equal(await verifySocialCallbackState(altered, secret), null);
  }
});

Deno.test("expired/future state and short secrets cannot authorize a callback", async () => {
  const old = await createSocialCallbackState({ userId, platform: "youtube", profileId }, secret, Date.now() - 601_000);
  const future = await createSocialCallbackState({ userId, platform: "youtube", profileId }, secret, Date.now() + 60_000);
  assert.equal(await verifySocialCallbackState(old.state, secret), null);
  assert.equal(await verifySocialCallbackState(future.state, secret), null);
  assert.equal(await verifySocialCallbackState(future.state, "short"), null);
  await assert.rejects(() => createSocialCallbackState({ userId, platform: "youtube", profileId }, "short"));
});

Deno.test("authorized flow creates one stable profile, verifies external identity and binds once", async () => {
  const f = fixture(); const start = await f.begin(); assert.equal(start.url, start.authUrl);
  const url = f.callback(); url.searchParams.set("user_id", otherUser); url.searchParams.set("account_name", "Forged");
  assert.deepEqual(await finishSocialConnection(url, f.deps), { status: "bound", platform: "youtube" });
  assert.equal(f.calls.finish, 1); assert.equal(f.calls.create, 1); assert.equal(f.calls.verify, 1);
  assert.deepEqual(await finishSocialConnection(url, f.deps), { status: "already_processed", platform: "youtube" });
  assert.equal(f.calls.finish, 1); assert.equal(f.calls.verify, 1);
  await f.begin(); assert.equal(f.calls.create, 1);
});

for (const [label, mutate] of [
  ["another profile", (url: URL) => url.searchParams.set("profileId", otherId)],
  ["another platform", (url: URL) => url.searchParams.set("connected", "tiktok")],
  ["missing account", (url: URL) => url.searchParams.delete("accountId")],
  ["duplicate account param", (url: URL) => url.searchParams.append("accountId", accountId)],
] as const) {
  Deno.test(`callback refuses ${label} before provider reads or writes`, async () => {
    const f = fixture(); await f.begin(); const url = f.callback(); mutate(url);
    await assert.rejects(() => finishSocialConnection(url, f.deps));
    assert.equal(f.calls.verify, 0); assert.equal(f.calls.finish, 0);
  });
}

Deno.test("valid HMAC without registered intent does not authorize writes", async () => {
  const f = fixture(); await f.begin(); f.intents.clear();
  await assert.rejects(() => finishSocialConnection(f.callback(), f.deps), /not_registered/);
  assert.equal(f.calls.verify, 0); assert.equal(f.calls.finish, 0);
});

Deno.test("provider account/profile mismatch or disconnected account never binds", async () => {
  for (const change of [{ profileId: otherId }, { accountId: otherId }, { platform: "tiktok" }, { isActive: false }]) {
    const f = fixture(); await f.begin(); Object.assign(f.verified, change);
    await assert.rejects(() => finishSocialConnection(f.callback(), f.deps), /not_publishable/);
    assert.equal(f.calls.finish, 0);
  }
});

Deno.test("a superseded or cancelled intent cannot bind; callback errors are sanitized", async () => {
  const f = fixture(); await f.begin(); const previous = f.callback(); await f.begin();
  await assert.rejects(() => finishSocialConnection(previous, f.deps), /already_closed/);
  const denied = f.callback(); denied.searchParams.set("error", "<script>provider-secret</script>");
  assert.equal((await finishSocialConnection(denied, f.deps)).status, "cancelled");
  await assert.rejects(() => finishSocialConnection(f.callback(), f.deps), /already_closed/);
  assert.equal(f.calls.verify, 0);
});

Deno.test("uncertain creation is reconciled by a read, without a repeated POST", async () => {
  const f = fixture();
  f.provider.createProfile = async () => { f.calls.create++; throw new SocialProviderError("provider_request_uncertain", true); };
  await assert.rejects(f.begin); assert.equal(f.binding.creationStatus, "uncertain");
  await assert.rejects(f.begin, /reconciliation_required/); assert.equal(f.calls.create, 1);
  f.setExisting([{ profileId, name: f.binding.profileName, externalId: f.binding.externalId }]);
  await f.begin(); assert.equal(f.binding.creationStatus, "ready"); assert.equal(f.calls.create, 1);
});

Deno.test("a racing successful callback is never reported as cancelled after a zero-row update", async () => {
  const f = fixture(); await f.begin(); const url = f.callback(); url.searchParams.set("error", "cancelled");
  f.store.cancelIntent = async (hash) => {
    const row = f.intents.get(hash)!; row.status = "bound"; row.accountId = accountId;
    return false;
  };
  await assert.rejects(() => finishSocialConnection(url, f.deps), /already_closed/);
  assert.equal([...f.intents.values()][0].status, "bound");
});

Deno.test("concurrent initial requests claim profile creation once", async () => {
  const f = fixture(); const results = await Promise.allSettled([f.begin(), f.begin()]);
  assert(results.some((item) => item.status === "fulfilled")); assert.equal(f.calls.create, 1);
});

Deno.test("database failure does not consume the intent or claim successful binding", async () => {
  const f = fixture(); await f.begin(); const original = f.store.finishIntent;
  f.store.finishIntent = async () => { throw new Error("database unavailable"); };
  await assert.rejects(() => finishSocialConnection(f.callback(), f.deps));
  assert.equal([...f.intents.values()][0].status, "pending");
  f.store.finishIntent = original; assert.equal((await finishSocialConnection(f.callback(), f.deps)).status, "bound");
});

Deno.test("connect HTTP gates method/origin/authentication before privileged dependencies", async () => {
  const f = fixture(); const handle = createSocialConnectHandler(f.http);
  for (const [request, expected] of [
    [new Request("https://database.example/connect"), 405],
    [new Request("https://database.example/connect", { method: "POST", body: "{}" }), 401],
    [new Request("https://database.example/connect", { method: "POST", headers: { Origin: "https://attacker.example", Authorization: "Bearer valid" }, body: "{}" }), 403],
    [new Request("https://database.example/connect", { method: "POST", headers: { Authorization: "Bearer valid" }, body: "bad json" }), 400],
  ] as const) assert.equal((await handle(request)).status, expected);
  assert.equal(f.calls.dependencies, 0);
  const ok = await handle(new Request("https://database.example/connect", { method: "POST", headers: { Authorization: "Bearer valid", Origin: "https://app.example" }, body: JSON.stringify({ platform: "youtube", profileId: otherId, userId: otherUser }) }));
  assert.equal(ok.status, 200); assert.equal((await ok.json()).url, "https://provider.example/authorize");
  assert.equal(f.binding.userId, userId);
});

Deno.test("callback HTTP rejects forged state before privileged client and avoids false success on replay", async () => {
  const f = fixture(); const handle = createSocialCallbackHandler(f.http);
  const bad = await handle(new Request(callbackBaseUrl + "?state=forged&error=secret"));
  assert.equal(bad.status, 302); assert.equal(f.calls.dependencies, 0);
  assert.equal(new URL(bad.headers.get("Location")!).origin, "https://app.example");
  assert(!bad.headers.get("Location")!.includes("secret"));
  await f.begin(); const ok = await handle(new Request(f.callback()));
  assert.equal(new URL(ok.headers.get("Location")!).searchParams.get("connected"), "youtube");
  const replay = await handle(new Request(f.callback()));
  assert.equal(new URL(replay.headers.get("Location")!).searchParams.get("status"), "already_processed");
  assert.equal(replay.headers.get("Referrer-Policy"), "no-referrer");
});

Deno.test("schema selection preserves purama_ai and rejects silent fallbacks", () => {
  assert.equal(socialDatabaseSchema(undefined), "purama_ai"); assert.equal(socialDatabaseSchema("public"), "public");
  assert.throws(() => socialDatabaseSchema("")); assert.throws(() => socialDatabaseSchema("other"));
});

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function accountList(accounts: unknown[]) { return { accounts, pagination: { limit: 100, nextCursor: null } }; }
function providerWith(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return createZernioConnectionProvider({ apiKey: "test-only-key", fetchImpl: (input, init) => Promise.resolve(handler(new URL(String(input)), init ?? {})) });
}
function externalAccount(overrides: Record<string, unknown> = {}) {
  return { _id: accountId, profileId: { _id: profileId }, platform: "youtube", isActive: true, username: null, displayName: "Test", ...overrides };
}

Deno.test("real provider adapter verifies identity from authenticated account response", async () => {
  const p = providerWith((url, init) => {
    assert.equal(url.origin, "https://zernio.com"); assert.equal(url.pathname, "/api/v1/accounts");
    assert.equal(url.searchParams.get("profileId"), profileId);
    assert.equal(url.searchParams.get("includeOverLimit"), "true");
    assert.equal(url.searchParams.get("excludeHidden"), "false");
    assert.equal(url.searchParams.get("adAccountRows"), "true");
    assert.equal(url.searchParams.get("includeSandbox"), "false");
    assert.equal(url.searchParams.has("status"), false);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-only-key");
    return json(accountList([externalAccount()]));
  });
  const result = await p.verifyAccount({ profileId, accountId, platform: "youtube" });
  assert.equal(result.accountName, "Test"); assert.equal(result.accountUsername, ""); assert.equal(result.isActive, true);
});

Deno.test("provider refuses foreign profiles, duplicate IDs and incomplete cursor pages", async () => {
  for (const body of [
    accountList([externalAccount({ profileId: { _id: otherId } })]),
    accountList([externalAccount(), externalAccount()]),
    { accounts: [], warning: "truncated" },
    { accounts: [], pagination: { total: 5 } },
  ]) await assert.rejects(() => providerWith(() => json(body)).listAccounts(profileId));
});

Deno.test("absence is returned only after an explicit complete final cursor page", async () => {
  assert.deepEqual(await providerWith(() => json(accountList([]))).listAccounts(profileId), []);
  for (const body of [{ accounts: [] }, { accounts: [], pagination: { limit: 100 } },
    { accounts: [], pagination: { nextCursor: "" } }, { ...accountList([]), warning: "truncated" }]) {
    await assert.rejects(() => providerWith(() => json(body)).listAccounts(profileId));
  }
  await assert.rejects(() => providerWith(() => new Response(JSON.stringify(accountList([])), {
    headers: { "X-Result-Truncated": "true" },
  })).listAccounts(profileId));
});

Deno.test("provider follows bounded cursor pagination and normalizes platform names", async () => {
  const p = providerWith((url) => url.searchParams.has("cursor")
    ? json({ accounts: [externalAccount({ platform: "googlebusiness" })], pagination: { nextCursor: null } })
    : json({ accounts: [], pagination: { nextCursor: "page-2" } }));
  assert.equal((await p.verifyAccount({ profileId, accountId, platform: "google_business" })).platform, "google_business");
});

Deno.test("account reconnect and enable flags are reflected in publishability", async () => {
  for (const change of [{ isActive: false }, { needsReconnection: true }, { enabled: false }]) {
    const p = providerWith(() => json(accountList([externalAccount(change)])));
    assert.equal((await p.verifyAccount({ profileId, accountId, platform: "youtube" })).isActive, false);
  }
});

Deno.test("profile POST uses stable idempotency and rejects contradictory profile evidence", async () => {
  const input = { externalId: "purama-ai:" + bindingId, name: "PURAMA " + bindingId, idempotencyKey: bindingId };
  const p = providerWith((url, init) => {
    assert.equal(url.pathname, "/api/v1/profiles"); assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Idempotency-Key"), bindingId);
    assert.deepEqual(JSON.parse(String(init.body)), { name: input.name, externalId: input.externalId });
    return json({ profile: { _id: profileId, name: input.name, externalId: input.externalId } }, 201);
  });
  assert.equal((await p.createProfile(input)).profileId, profileId);
  await assert.rejects(() => providerWith(() => json({ profile: { _id: profileId, name: "wrong", externalId: input.externalId } }, 201)).createProfile(input));
});

Deno.test("OAuth URL uses documented camelCase profileId and redirect_url; insecure URLs fail", async () => {
  const p = providerWith((url) => {
    assert.equal(url.pathname, "/api/v1/connect/googlebusiness");
    assert.equal(url.searchParams.get("profileId"), profileId);
    assert.equal(url.searchParams.get("redirect_url"), callbackBaseUrl);
    return json({ authUrl: "https://accounts.google.com/o/oauth2/auth" });
  });
  assert((await p.getConnectUrl({ platform: "google_business", profileId, callbackUrl: callbackBaseUrl })).startsWith("https://"));
  await assert.rejects(() => providerWith(() => json({ authUrl: "javascript:alert(1)" })).getConnectUrl({ platform: "youtube", profileId, callbackUrl: callbackBaseUrl }));
});
