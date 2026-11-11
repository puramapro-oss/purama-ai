import { strict as assert } from "node:assert";
import { handleScheduledConsumerRequest, MAX_BATCH, MAX_RUN_MS } from "../../supabase/functions/social-publish-scheduled/handler.ts";
import { inspectPost } from "../../supabase/functions/_shared/zernio.ts";
import { reconcileSocialPost } from "../../supabase/functions/_shared/social-publish-reconcile.ts";
import { account, FakeDb, NOW, post, providerResult } from "./fake-db.ts";

const request = (token = "cron-fixture") => new Request("https://app.invalid/functions/v1/social-publish-scheduled", {
  method: "POST", headers: { Authorization: "Bearer " + token },
});
const noInspect = async () => { throw new Error("Unexpected provider GET"); };

Deno.test("scheduled: two workers racing for one row send exactly one POST", async () => {
  const db = new FakeDb([post()]);
  let calls = 0;
  const publish = async () => { calls++; return providerResult(); };
  const results = await Promise.all([
    handleScheduledConsumerRequest(request(), db, "cron-fixture", publish, () => NOW, noInspect),
    handleScheduledConsumerRequest(request(), db, "cron-fixture", publish, () => NOW, noInspect),
  ]);
  const bodies = await Promise.all(results.map((result) => result.json()));
  assert.equal(calls, 1);
  assert.equal(bodies.reduce((sum, body) => sum + body.published, 0), 1);
  assert.equal(db.tables.social_posts[0].status, "published");
});

Deno.test("scheduled: stale publishing is quarantined, never reset and reposted", async () => {
  const db = new FakeDb([post({ status: "publishing" })]);
  let calls = 0;
  const publish = async () => { calls++; return providerResult(); };
  const response = await handleScheduledConsumerRequest(request(), db, "cron-fixture", publish, () => NOW, noInspect);
  assert.equal((await response.json()).quarantined, 1);
  assert.equal(db.tables.social_posts[0].status, "publish_unconfirmed");
  await handleScheduledConsumerRequest(request(), db, "cron-fixture", publish, () => NOW + 600_000, noInspect);
  assert.equal(calls, 0);
  assert.equal(db.queries.some((query) => query.op === "update" && query.values.status === "scheduled"), false);
});

Deno.test("scheduled: lost response and failed anomaly writes are never automatically retried", async () => {
  const db = new FakeDb([post()]);
  db.faults.push({ when: (query) => query.op === "update" && query.values.status === "publish_unconfirmed", kind: "error" });
  let remotePosts = 0;
  const publish = async () => { remotePosts++; throw new Error("Published remotely, response lost"); };
  const first = await (await handleScheduledConsumerRequest(request(), db, "cron-fixture", publish, () => NOW, noInspect)).json();
  assert.equal(first.unconfirmed, 1);
  assert.equal(db.tables.social_posts[0].status, "publishing");
  db.clock = NOW + 600_000;
  const second = await (await handleScheduledConsumerRequest(request(), db, "cron-fixture", publish, () => db.clock, noInspect)).json();
  assert.equal(second.quarantined, 1);
  assert.equal(db.tables.social_posts[0].status, "publish_unconfirmed");
  assert.equal(remotePosts, 1);
});

Deno.test("scheduled: failed or lost claim writes perform no provider call", async () => {
  for (const kind of ["error", "after_error"] as const) {
    const db = new FakeDb([post()]);
    db.faults.push({ when: (query) => query.op === "update" && query.values.status === "publishing", kind });
    let calls = 0;
    const response = await handleScheduledConsumerRequest(request(), db, "cron-fixture", async () => { calls++; return providerResult(); }, () => NOW, noInspect);
    assert.equal(response.status, 503);
    assert.equal(calls, 0);
  }
});

Deno.test("scheduled: changed, inactive and unverified bindings fail before posting", async () => {
  for (const current of [account({ zernio_account_id: "replacement-account" }), account({ is_active: false }), account({ publishing_verified_at: null })]) {
    const db = new FakeDb([post()], [current]);
    let calls = 0;
    const body = await (await handleScheduledConsumerRequest(request(), db, "cron-fixture", async () => { calls++; return providerResult(); }, () => NOW, noInspect)).json();
    assert.equal(body.failed, 1);
    assert.equal(calls, 0);
    assert.equal(db.tables.social_posts[0].status, "failed");
  }
});

Deno.test("scheduled: a partial provider result remains partial", async () => {
  const db = new FakeDb([post()]);
  const result = await (await handleScheduledConsumerRequest(request(), db, "cron-fixture", async () => providerResult({ status: "partial" }), () => NOW, noInspect)).json();
  assert.equal(result.success, false);
  assert.equal(result.published, 0);
  assert.equal(result.partial, 1);
  assert.equal(db.tables.social_posts[0].status, "partial");
});

Deno.test("scheduled: run deadline leaves rows unclaimed and batch remains bounded", async () => {
  const db = new FakeDb(Array.from({ length: MAX_BATCH + 5 }, (_, i) => post({ id: "post-" + i })));
  let calls = 0;
  const publish = async () => { calls++; return providerResult(); };
  let clockCalls = 0;
  await handleScheduledConsumerRequest(request(), db, "cron-fixture", publish, () => clockCalls++ === 0 ? NOW : NOW + MAX_RUN_MS, noInspect);
  assert.equal(calls, 0);
  assert.equal(db.tables.social_posts.every((row) => row.status === "scheduled"), true);
  await handleScheduledConsumerRequest(request(), db, "cron-fixture", publish, () => NOW, noInspect);
  assert.equal(calls, MAX_BATCH);
  assert.equal(db.tables.social_posts.filter((row) => row.status === "scheduled").length, 5);
});

Deno.test("scheduled: rejected cron credentials never touch DB or provider", async () => {
  const db = new FakeDb([post()]);
  let calls = 0;
  const publish = async () => { calls++; return providerResult(); };
  assert.equal((await handleScheduledConsumerRequest(request(), db, undefined, publish)).status, 500);
  assert.equal((await handleScheduledConsumerRequest(request("wrong"), db, "cron-fixture", publish)).status, 401);
  assert.equal(calls, 0);
  assert.equal(db.queries.length, 0);
});

Deno.test("reconciliation: actual GET transitions pending to published without a POST", async () => {
  const pending = post({ status: "publish_unconfirmed", zernio_post_id: "external-post" });
  const db = new FakeDb([pending]);
  let gets = 0;
  let posts = 0;
  const inspect = (id: string, targets: NonNullable<typeof pending.target_accounts>) => inspectPost(id, targets, {
    apiKey: "fixture", baseUrl: "https://provider.invalid", fetchImpl: async (input, init) => {
      gets++;
      assert.equal(init?.method, "GET");
      assert.equal(input, "https://provider.invalid/posts/external-post");
      return Response.json({ post: { _id: "external-post", status: gets === 1 ? "scheduled" : "published", platforms: [
        { platform: "facebook", accountId: "account-owner", status: gets === 1 ? "pending" : "published" },
      ] } });
    },
  });
  const publish = async () => { posts++; return providerResult(); };
  const first = await (await handleScheduledConsumerRequest(request(), db, "cron-fixture", publish, () => NOW, inspect)).json();
  assert.equal(first.reconciliation_unconfirmed, 1);
  assert.equal(db.tables.social_posts[0].status, "publish_unconfirmed");
  db.clock = NOW + 600_000;
  const second = await (await handleScheduledConsumerRequest(request(), db, "cron-fixture", publish, () => db.clock, inspect)).json();
  assert.equal(second.reconciled_published, 1);
  assert.equal(db.tables.social_posts[0].status, "published");
  assert.equal(gets, 2);
  assert.equal(posts, 0);
});

Deno.test("reconciliation: foreign post ID, account and missing ID never confirm", async () => {
  const pending = post({ status: "publish_unconfirmed", zernio_post_id: "external-post" });
  for (const which of ["foreign-id", "foreign-account", "missing-id"]) {
    const row = which === "missing-id" ? { ...pending, zernio_post_id: null } : pending;
    const db = new FakeDb([row]);
    let calls = 0;
    const outcome = await reconcileSocialPost(db, row, (id, targets) => inspectPost(id, targets, {
      apiKey: "fixture", baseUrl: "https://provider.invalid", fetchImpl: async () => {
        calls++;
        return Response.json({ post: { _id: which === "foreign-id" ? "other-post" : "external-post", status: "published", platforms: [
          { platform: "facebook", accountId: which === "foreign-account" ? "other-account" : "account-owner", status: "published" },
        ] } });
      },
    }));
    assert.equal(outcome.status, "publish_unconfirmed");
    assert.equal(db.tables.social_posts[0].status, "publish_unconfirmed");
    if (which === "missing-id") assert.equal(calls, 0);
  }
});

Deno.test("reconciliation: rows without server-owned destinations or provider ID cannot starve eligible reads", async () => {
  const invalid = Array.from({ length: MAX_BATCH + 5 }, (_, index) => post({ id: "missing-" + index, status: "publish_unconfirmed" }));
  invalid.push(post({ id: "legacy-provider-id", status: "publish_unconfirmed", zernio_post_id: "untrusted-legacy-id", target_accounts: null }));
  const ready = post({ id: "ready", status: "publish_unconfirmed", zernio_post_id: "external-post" });
  const db = new FakeDb([...invalid, ready]);
  let reads = 0;
  const response = await handleScheduledConsumerRequest(request(), db, "cron-fixture", async () => { throw new Error("No POST permitted"); }, () => NOW, async () => { reads++; return providerResult(); });
  assert.equal((await response.json()).reconciled_published, 1);
  assert.equal(reads, 1);
});

Deno.test("reconciliation: an unavailable provider ID is deferred without starving later pending posts", async () => {
  const pending = post({ status: "publish_unconfirmed", zernio_post_id: "external-post" });
  const db = new FakeDb([pending]);
  const result = await reconcileSocialPost(db, pending, async () => { throw new Error("Read timeout"); });
  assert.equal(result.status, "publish_unconfirmed");
  assert.equal(db.tables.social_posts[0].status, "publish_unconfirmed");
  assert.equal(db.tables.social_posts[0].updated_at, new Date(NOW).toISOString());
});

Deno.test("reconciliation: DB error or concurrent status change cannot produce a false confirmation", async () => {
  for (const kind of ["error", "empty"] as const) {
    const pending = post({ status: "publish_unconfirmed", zernio_post_id: "external-post" });
    const db = new FakeDb([pending]);
    db.faults.push({ when: (query) => query.op === "update", kind });
    const outcome = await reconcileSocialPost(db, pending, async () => providerResult());
    assert.equal(outcome.status, "publish_unconfirmed");
    assert.equal(db.tables.social_posts[0].status, "publish_unconfirmed");
  }
  const pending = post({ status: "publish_unconfirmed", zernio_post_id: "external-post" });
  const db = new FakeDb([pending]);
  const outcome = await reconcileSocialPost(db, pending, async () => {
    db.tables.social_posts[0].zernio_post_id = "changed-id";
    return providerResult();
  });
  assert.equal(outcome.status, "publish_unconfirmed");
  assert.equal(db.tables.social_posts[0].status, "publish_unconfirmed");
});
