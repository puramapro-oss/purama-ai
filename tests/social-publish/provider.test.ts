import { strict as assert } from "node:assert";
import { disconnectConnectedAccount, inspectPost, normalizeZernioPublishResult, publishPost } from "../../supabase/functions/_shared/zernio.ts";
import { PublishNotStartedError } from "../../supabase/functions/_shared/social-publish-core.ts";
import { post } from "./fake-db.ts";

const targets = post().target_accounts!;
const body = (status = "published", platformStatus = "published", accountId = "account-owner", id = "external-post") => ({
  post: { _id: id, status, platforms: [{ platform: "facebook", accountId, status: platformStatus, platformPostId: "native-post" }] },
});
const transport = (fetchImpl: typeof fetch, timeoutMs = 1000) => ({ apiKey: "fixture-key", baseUrl: "https://provider.invalid/api/v1", fetchImpl, timeoutMs });

Deno.test("provider: actual contract, frozen account ID and stable idempotency header", async () => {
  let calls = 0;
  const result = await publishPost({ postId: "local-post", text: "PURAMA", mediaUrls: ["https://media.invalid/asset.mp4"], targets }, transport(async (input, init) => {
    calls++;
    assert.equal(input, "https://provider.invalid/api/v1/posts");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "purama-social-local-post");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      content: "PURAMA", mediaItems: [{ url: "https://media.invalid/asset.mp4" }],
      platforms: [{ platform: "facebook", accountId: "account-owner" }], publishNow: true,
      metadata: { puramaPostId: "local-post" },
    });
    return Response.json(body());
  }));
  assert.equal(calls, 1);
  assert.equal(result.status, "published");
  assert.equal(result.platformResults[0].postId, "native-post");
});

Deno.test("provider: HTTP 207 preserves a partial result per platform", async () => {
  const both = [...targets, { platform: "linkedin", zernio_account_id: "account-linkedin", zernio_profile_id: "profile-owner" }];
  const response = body("partial");
  response.post.platforms.push({ platform: "linkedin", accountId: "account-linkedin", status: "failed", platformPostId: "" });
  const result = await publishPost({ postId: "local-post", targets: both }, transport(async () => Response.json(response, { status: 207 })));
  assert.equal(result.status, "partial");
  assert.deepEqual(result.platformResults.map((item) => item.status), ["published", "failed"]);
});

Deno.test("provider: pending, malformed, wrong account, missing ID and misleading 207 never confirm publication", () => {
  for (const value of [body("scheduled", "pending"), { post: { status: "published" } }, body("published", "published", "foreign-account"), body("published", "published", "account-owner", ""), {}]) {
    assert.equal(normalizeZernioPublishResult(value, targets, 200).status, "publish_unconfirmed");
  }
  assert.equal(normalizeZernioPublishResult(body(), targets, 207).status, "publish_unconfirmed");
  assert.equal(normalizeZernioPublishResult(body(), targets, 202).status, "publish_unconfirmed");
});

Deno.test("provider: timeout after a remote side effect performs exactly one POST", async () => {
  let remotePosts = 0;
  await assert.rejects(() => publishPost({ postId: "local-post", targets }, transport(async () => {
    remotePosts++;
    return await new Promise<Response>(() => {}); // Deliberately ignores abort.
  }, 10)), /timeout/);
  assert.equal(remotePosts, 1);
});

Deno.test("provider: X, invalid media and absent credentials perform zero outbound calls", async () => {
  let calls = 0;
  const fake = transport(async () => { calls++; return Response.json(body()); });
  for (const params of [
    { postId: "local-post", targets: [{ ...targets[0], platform: "twitter" }] },
    { postId: "local-post", targets, mediaUrls: ["invalid-url"] },
    { postId: "local-post", targets, mediaUrls: ["http://media.invalid/image.png"] },
  ]) await assert.rejects(() => publishPost(params, fake), PublishNotStartedError);
  await assert.rejects(() => publishPost({ postId: "local-post", targets }, { ...fake, apiKey: "" }), PublishNotStartedError);
  await assert.rejects(() => publishPost({ postId: "local-post", targets }, { apiKey: "fixture", baseUrl: "https://provider.invalid" }), PublishNotStartedError);
  assert.equal(calls, 0);
});

Deno.test("provider: reconciliation uses GET for the recorded ID only", async () => {
  const result = await inspectPost("external-post", targets, transport(async (input, init) => {
    assert.equal(input, "https://provider.invalid/api/v1/posts/external-post");
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    return Response.json(body());
  }));
  assert.equal(result.status, "published");
});

Deno.test("provider: disconnect targets the account, confirms 200/404 and rejects 202", async () => {
  for (const status of [200, 404, 202]) {
    let calls = 0;
    const promise = disconnectConnectedAccount("account-owner", transport(async (input, init) => {
      calls++;
      assert.equal(input, "https://provider.invalid/api/v1/accounts/account-owner");
      assert.equal(init?.method, "DELETE");
      return Response.json({ success: status === 200 }, { status });
    }));
    if (status === 202) await assert.rejects(() => promise, /non confirmée/);
    else await promise;
    assert.equal(calls, 1);
  }
  await disconnectConnectedAccount("account-owner", transport(async () => new Response(null, { status: 200 })));
});
