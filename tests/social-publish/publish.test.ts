import { strict as assert } from "node:assert";
import { handleSocialPublishRequest } from "../../supabase/functions/social-publish/handler.ts";
import { publishPost } from "../../supabase/functions/_shared/zernio.ts";
import { account, FakeDb, NOW, post, providerResult } from "./fake-db.ts";

const key = "stable-request-000001";
const request = (patch: Record<string, unknown> = {}, token = "fixture-token") => new Request("https://app.invalid/functions/v1/social-publish", {
  method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  body: JSON.stringify({ clientRequestId: key, content: "PURAMA préparé", ...patch }),
});
const auth = async (token: string) => token === "fixture-token" ? "owner" : null;

Deno.test("history: authenticated GET reads only owner rows without provider access or private provider response", async () => {
  const db = new FakeDb([post({ id: "owned" }), post({ id: "other", user_id: "other-owner" })]);
  let calls = 0;
  const response = await handleSocialPublishRequest(new Request("https://app.invalid/social-publish", { headers: { Authorization: "Bearer fixture-token" } }), {
    db, authenticate: auth, publish: async () => { calls++; return providerResult(); },
  });
  const history = await response.json();
  assert.deepEqual(history.map((row: { id: string }) => row.id), ["owned"]);
  assert.equal("zernio_response" in history[0], false);
  assert.equal("request_hash" in history[0], false);
  assert.equal(calls, 0);
});

Deno.test("immediate: concurrent identical requests and subsequent retries produce one remote effect", async () => {
  const db = new FakeDb();
  let remotePosts = 0;
  const deps = { db, authenticate: auth, now: () => NOW, publish: async () => { remotePosts++; return providerResult(); } };
  const responses = await Promise.all([handleSocialPublishRequest(request(), deps), handleSocialPublishRequest(request(), deps)]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.equal(remotePosts, 1);
  assert.equal(db.tables.social_posts.length, 1);
  assert.equal(new Set(bodies.map((body) => body.post_id)).size, 1);
  const replay = await (await handleSocialPublishRequest(request(), deps)).json();
  assert.equal(replay.status, "published");
  assert.equal(replay.replayed, true);
  assert.equal(remotePosts, 1);
});

Deno.test("immediate: reusing a key with changed payload is rejected, preserving the first intent", async () => {
  const db = new FakeDb();
  let calls = 0;
  const deps = { db, authenticate: auth, now: () => NOW, publish: async () => { calls++; return providerResult(); } };
  await handleSocialPublishRequest(request(), deps);
  const response = await handleSocialPublishRequest(request({ content: "Different content" }), deps);
  assert.equal(response.status, 409);
  assert.equal(calls, 1);
  assert.equal(db.tables.social_posts[0].content_text, "PURAMA préparé");
});

Deno.test("immediate: lost provider response stays uncertain across retry without repost", async () => {
  const db = new FakeDb();
  let remotePosts = 0;
  const deps = { db, authenticate: auth, now: () => NOW, publish: async () => { remotePosts++; throw new Error("Response lost after provider published"); } };
  const first = await handleSocialPublishRequest(request(), deps);
  assert.equal(first.status, 202);
  assert.equal((await first.json()).status, "publish_unconfirmed");
  assert.equal(db.tables.social_posts[0].status, "publish_unconfirmed");
  const replay = await (await handleSocialPublishRequest(request(), deps)).json();
  assert.equal(replay.status, "publish_unconfirmed");
  assert.equal(replay.retryable, false);
  assert.equal(remotePosts, 1);
});

Deno.test("immediate: insert committed but acknowledgement lost cannot trigger a second POST", async () => {
  const db = new FakeDb();
  db.faults.push({ when: (query) => query.op === "insert", kind: "after_error" });
  let calls = 0;
  const deps = { db, authenticate: auth, now: () => NOW, publish: async () => { calls++; return providerResult(); } };
  assert.equal((await handleSocialPublishRequest(request(), deps)).status, 503);
  assert.equal(db.tables.social_posts.length, 1);
  const replay = await (await handleSocialPublishRequest(request(), deps)).json();
  assert.equal(replay.status, "publish_unconfirmed");
  assert.equal(calls, 0);
});

for (const kind of ["error", "empty", "after_error"] as const) {
  Deno.test("immediate: DB result write " + kind + " cannot be reported as published", async () => {
    const db = new FakeDb();
    db.faults.push({ when: (query) => query.op === "update" && query.values.status === "published", kind });
    let calls = 0;
    const deps = { db, authenticate: auth, now: () => NOW, publish: async () => { calls++; return providerResult(); } };
    const first = await (await handleSocialPublishRequest(request(), deps)).json();
    assert.equal(first.status, "publish_unconfirmed");
    assert.equal(first.success, false);
    await handleSocialPublishRequest(request(), deps);
    assert.equal(calls, 1);
  });
}

Deno.test("immediate: failure of both result writes leaves the durable publishing claim", async () => {
  const db = new FakeDb();
  db.faults.push({ when: (query) => query.op === "update", kind: "error", repeat: true });
  let calls = 0;
  const deps = { db, authenticate: auth, now: () => NOW, publish: async () => { calls++; return providerResult(); } };
  const response = await (await handleSocialPublishRequest(request(), deps)).json();
  assert.equal(response.status, "publish_unconfirmed");
  assert.equal(db.tables.social_posts[0].status, "publishing");
  await handleSocialPublishRequest(request(), deps);
  assert.equal(calls, 1);
});

Deno.test("immediate: actual provider 207 stays partial all the way through HTTP response and DB", async () => {
  const db = new FakeDb([], [account(), account({ platform: "linkedin", zernio_account_id: "account-linkedin" })]);
  let calls = 0;
  const response = await handleSocialPublishRequest(request(), {
    db, authenticate: auth, now: () => NOW,
    publish: (params) => publishPost(params, { apiKey: "fixture", baseUrl: "https://provider.invalid", fetchImpl: async () => {
      calls++;
      return Response.json({ post: { _id: "external-post", status: "partial", platforms: [
        { platform: "facebook", accountId: "account-owner", status: "published" },
        { platform: "linkedin", accountId: "account-linkedin", status: "failed" },
      ] } }, { status: 207 });
    } }),
  });
  const body = await response.json();
  assert.equal(response.status, 207);
  assert.equal(body.success, false);
  assert.equal(body.status, "partial");
  assert.equal(body.platform_results.length, 2);
  assert.equal(db.tables.social_posts[0].status, "partial");
  assert.equal(calls, 1);
});

Deno.test("immediate: unverified, inactive, foreign and X accounts perform no outbound call", async () => {
  for (const value of [account({ publishing_verified_at: null }), account({ is_active: false }), account({ user_id: "someone-else" }), account({ platform: "twitter" })]) {
    const db = new FakeDb([], [value]);
    let calls = 0;
    const response = await handleSocialPublishRequest(request(), { db, authenticate: auth, now: () => NOW, publish: async () => { calls++; return providerResult(); } });
    assert.equal(response.status, 422);
    assert.equal(calls, 0);
    assert.equal(db.tables.social_posts.length, 0);
  }
});

Deno.test("immediate: authentication, missing key and DB read errors fail before provider access", async () => {
  const db = new FakeDb();
  let calls = 0;
  const deps = { db, authenticate: auth, now: () => NOW, publish: async () => { calls++; return providerResult(); } };
  assert.equal((await handleSocialPublishRequest(request({}, "invalid"), deps)).status, 401);
  assert.equal((await handleSocialPublishRequest(request({ clientRequestId: undefined }), deps)).status, 400);
  db.faults.push({ when: (query) => query.op === "select", kind: "error" });
  assert.equal((await handleSocialPublishRequest(request(), deps)).status, 503);
  assert.equal(calls, 0);
});

Deno.test("immediate: scheduling saves prepared content without any provider or caption generation", async () => {
  const db = new FakeDb();
  let calls = 0;
  const response = await handleSocialPublishRequest(request({ scheduledAt: "2026-11-11T12:00:00Z", forceCaption: true }), {
    db, authenticate: auth, now: () => NOW, publish: async () => { calls++; return providerResult(); },
  });
  const body = await response.json();
  assert.equal(body.status, "scheduled");
  assert.equal(body.caption_generated, false);
  assert.equal(db.tables.social_posts[0].content_text, "PURAMA préparé");
  assert.equal(db.tables.social_posts[0].ai_generated, false);
  assert.equal(calls, 0);
});
