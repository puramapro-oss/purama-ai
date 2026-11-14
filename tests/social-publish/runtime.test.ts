import { disconnectConnectedAccount, publishPost } from "../../supabase/functions/_shared/zernio.ts";
import { PublishNotStartedError } from "../../supabase/functions/_shared/social-publish-core.ts";

// Avoid a Node ambient-type download in the SDK's manual npm resolver.
const assert = {
  equal(actual: unknown, expected: unknown) {
    if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  },
  async rejects(action: () => Promise<unknown>, expected: new (message: string) => Error) {
    try { await action(); } catch (error) {
      if (!(error instanceof expected)) throw error;
      return;
    }
    throw new Error("Expected request rejection");
  },
};

// Import the deployed entrypoints with the installed, real Supabase SDK.
// Only Deno.serve registration and fetch are replaced; no socket is opened.
type Handler = (request: Request) => Response | Promise<Response>;
const registered: Handler[] = [];
const actualServe = Deno.serve;
try {
  Deno.serve = ((handler: Handler) => {
    assert.equal(typeof handler, "function");
    registered.push(handler);
    return {};
  }) as unknown as typeof Deno.serve;
  await import("../../supabase/functions/social-publish/index.ts");
  await import("../../supabase/functions/social-publish-scheduled/index.ts");
} finally {
  Deno.serve = actualServe;
}
const [immediate, scheduled] = registered;
const owner = "00000000-0000-4000-8000-000000000001";
for (const [name, value] of Object.entries({
  SUPABASE_URL: "https://db.invalid", SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service", SOCIAL_DB_SCHEMA: "public", CRON_SECRET: "fixture-cron",
  ZERNIO_API_KEY: "fixture-provider-key", ZERNIO_BASE_URL: "https://zernio.com/api/v1",
})) Deno.env.set(name, value);

async function withFetch<T>(stub: typeof fetch, action: () => Promise<T>): Promise<T> {
  const actualFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await action(); } finally { globalThis.fetch = actualFetch; }
}

Deno.test("runtime: both real Edge entrypoints register Deno.serve on module load", () => {
  assert.equal(registered.length, 2);
  assert.equal(typeof immediate, "function");
  assert.equal(typeof scheduled, "function");
});

Deno.test("runtime: alternate provider origin is rejected before publish or disconnect", async () => {
  let calls = 0;
  Deno.env.set("ZERNIO_BASE_URL", "https://another-provider.invalid/api/v1");
  try {
    await withFetch(async () => { calls++; throw new Error("Unexpected outbound request"); }, async () => {
      await assert.rejects(() => publishPost({ postId: "post-id", text: "Prepared", targets: [{ platform: "facebook", zernio_account_id: "account", zernio_profile_id: "profile" }] }), PublishNotStartedError);
      await assert.rejects(() => disconnectConnectedAccount("account"), PublishNotStartedError);
    });
  } finally {
    Deno.env.set("ZERNIO_BASE_URL", "https://zernio.com/api/v1");
  }
  assert.equal(calls, 0);
});

Deno.test("runtime: JWT-authenticated history uses service persistence filtered by owner and configured schema", async () => {
  let authCalls = 0;
  let dbCalls = 0;
  await withFetch(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://db.invalid");
    const headers = new Headers(init?.headers);
    if (url.pathname === "/auth/v1/user") {
      authCalls++;
      assert.equal(headers.get("Authorization"), "Bearer fixture-user-token");
      return Response.json({ id: owner, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} });
    }
    dbCalls++;
    assert.equal(url.pathname, "/rest/v1/social_posts");
    assert.equal(url.searchParams.get("user_id"), "eq." + owner);
    assert.equal(url.searchParams.get("limit"), "50");
    assert.equal(headers.get("Authorization"), "Bearer fixture-service");
    assert.equal(headers.get("Accept-Profile"), "public");
    assert.equal(init?.method, "GET");
    return Response.json([{ id: "owned-post", status: "publish_unconfirmed" }]);
  }, async () => {
    const response = await immediate(new Request("https://app.invalid/social-publish", { headers: { Authorization: "Bearer fixture-user-token" } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json())[0].status, "publish_unconfirmed");
  });
  assert.equal(authCalls, 1);
  assert.equal(dbCalls, 1);
});

Deno.test("runtime: account verification refusal makes zero supplier calls through the real SDK route", async () => {
  let supplierCalls = 0;
  await withFetch(async (input) => {
    const url = new URL(String(input));
    if (url.origin !== "https://db.invalid") {
      supplierCalls++;
      throw new Error("Supplier access must not occur");
    }
    if (url.pathname === "/auth/v1/user") return Response.json({ id: owner, app_metadata: {}, user_metadata: {} });
    if (url.pathname === "/rest/v1/social_posts") return Response.json(null);
    assert.equal(url.pathname, "/rest/v1/social_accounts");
    return Response.json([{ user_id: owner, platform: "facebook", zernio_account_id: "account", zernio_profile_id: "profile", is_active: true, publishing_verified_at: null }]);
  }, async () => {
    const response = await immediate(new Request("https://app.invalid/social-publish", {
      method: "POST", headers: { Authorization: "Bearer fixture-user-token", "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Prepared PURAMA content", clientRequestId: "runtime-intent-000001" }),
    }));
    assert.equal(response.status, 422);
    assert.equal((await response.json()).sent, false);
  });
  assert.equal(supplierCalls, 0);
});

Deno.test("runtime: cron checks its secret and uses the same explicitly configured schema", async () => {
  let reads = 0;
  await withFetch(async (input, init) => {
    reads++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://db.invalid");
    assert.equal(url.pathname, "/rest/v1/social_posts");
    assert.equal(new Headers(init?.headers).get("Accept-Profile"), "public");
    assert.equal(init?.method, "GET");
    return Response.json([]);
  }, async () => {
    const denied = await scheduled(new Request("https://app.invalid/cron", { method: "POST" }));
    assert.equal(denied.status, 401);
    assert.equal(reads, 0);
    const response = await scheduled(new Request("https://app.invalid/cron", { method: "POST", headers: { Authorization: "Bearer fixture-cron" } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).processed, 0);
  });
  assert.equal(reads, 3);
});
