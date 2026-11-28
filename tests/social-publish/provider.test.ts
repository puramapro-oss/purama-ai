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

function blockProviderClock(milliseconds: number): void {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) {
    // Deliberately synchronous: timer callbacks cannot run during this work.
  }
}

for (const operation of ["publish", "inspect", "disconnect"] as const) {
  Deno.test("provider: expired synchronous transport cannot confirm " + operation, async () => {
    let calls = 0;
    const fixture = transport(async () => {
      calls++;
      blockProviderClock(50);
      return operation === "disconnect" ? new Response(null, { status: 200 }) : Response.json(body());
    }, 10);
    await assert.rejects(async () => {
      if (operation === "publish") return await publishPost({ postId: "local-post", text: "PURAMA", targets }, fixture);
      if (operation === "inspect") return await inspectPost("external-post", targets, fixture);
      return await disconnectConnectedAccount("account-owner", fixture);
    }, /timeout|deadline/i);
    assert.equal(calls, 1);
  });
}

Deno.test("provider: the same absolute deadline covers synchronous body work", async () => {
  let calls = 0;
  let pulls = 0;
  const bytes = new TextEncoder().encode(JSON.stringify(body()));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      blockProviderClock(50);
      controller.enqueue(bytes);
      controller.close();
    },
  }, { highWaterMark: 0 });
  await assert.rejects(() => inspectPost("external-post", targets, transport(async () => {
    calls++;
    return new Response(stream, { status: 200 });
  }, 10)), /timeout|deadline/i);
  assert.equal(calls, 1);
  assert.equal(pulls, 1);
});

Deno.test("provider: a response arriving after timeout is cancelled without being read", async () => {
  let calls = 0;
  let cancelled = 0;
  let delivered!: (response: Response) => void;
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const pending = new Promise<Response>(resolve => { delivered = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  try {
    const request = publishPost({ postId: "local-post", text: "PURAMA", targets }, transport(() => {
      calls++;
      return pending;
    }, 10));
    await assert.rejects(() => request, /timeout|deadline/i);
    delivered(new Response(stream, { status: 200 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
    assert.equal(stream.locked, false);
  } finally {
    try { streamController.error(new Error("fixture cleanup")); } catch { /* Already closed. */ }
  }
});

Deno.test("provider: an unfinished response body is cancelled after timeout", async () => {
  let cancelled = 0;
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  try {
    await assert.rejects(() => inspectPost("external-post", targets, transport(
      async () => new Response(stream, { status: 200 }), 10,
    )), /timeout|deadline|interrupted/i);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(cancelled, 1);
    assert.equal(stream.locked, false);
  } finally {
    try { streamController.error(new Error("fixture cleanup")); } catch { /* Already closed. */ }
  }
});

for (const status of [200, 404]) {
  Deno.test("provider: disconnect HTTP " + status + " remains confirmed when body cancellation never settles", async () => {
    let calls = 0;
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() { cancelled++; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 });
    await disconnectConnectedAccount("account-owner", transport(async () => {
      calls++;
      return new Response(stream, { status });
    }, 20));
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
    assert.equal(stream.locked, false);
  });
}

Deno.test("provider: a rejected HTTP status does not await an uncooperative body cancellation", async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel() { cancelled++; return new Promise<void>(() => {}); },
  }, { highWaterMark: 0 });
  await assert.rejects(() => inspectPost("external-post", targets, transport(
    async () => new Response(stream, { status: 400 }), 20,
  )), /HTTP 400/);
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});

Deno.test("provider: invalid UTF-8 cannot become a confirmed JSON receipt", async () => {
  const prefix = new TextEncoder().encode('{"ignored":"');
  const suffix = new TextEncoder().encode('","post":' + JSON.stringify(body().post) + "}");
  const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
  bytes.set(prefix);
  bytes[prefix.length] = 0xff;
  bytes.set(suffix, prefix.length + 1);
  await assert.rejects(() => inspectPost("external-post", targets, transport(
    async () => new Response(bytes, { status: 200 }),
  )));
});

Deno.test("provider: the existing decoded byte limit remains exact", async () => {
  const json = JSON.stringify(body());
  const exact = new TextEncoder().encode(json.padEnd(1_000_000, " "));
  const excessive = new Uint8Array(exact.length + 1);
  excessive.set(exact);
  excessive[exact.length] = 0x20;
  const result = await inspectPost("external-post", targets, transport(
    async () => new Response(exact, { status: 200 }),
  ));
  assert.equal(result.status, "published");
  await assert.rejects(() => inspectPost("external-post", targets, transport(
    async () => new Response(excessive, { status: 200 }),
  )), /too large/i);
});

Deno.test("provider: expiry during the parsed-response handoff cannot confirm a result", async () => {
  const originalParse = JSON.parse;
  const responseText = JSON.stringify({ deadlineProbe: "parsed-handoff", ...body() });
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    const value: unknown = originalParse(text, reviver);
    if (value && typeof value === "object" && "deadlineProbe" in value && value.deadlineProbe === "parsed-handoff") {
      queueMicrotask(() => blockProviderClock(50));
    }
    return value;
  }) as typeof JSON.parse;
  try {
    await assert.rejects(() => inspectPost("external-post", targets, transport(
      async () => new Response(responseText, { status: 200 }), 10,
    )), /timeout|deadline/i);
  } finally {
    JSON.parse = originalParse;
  }
});

for (const operation of ["publish", "inspect"] as const) {
  Deno.test("provider: " + operation + " includes final receipt normalization in its deadline", async () => {
    let received = false;
    let normalizations = 0;
    let calls = 0;
    const finalTargets = [{
      ...targets[0],
      get zernio_account_id() {
        // Instrument only normalization; request validation and encoding stay fast.
        if (received) { normalizations++; blockProviderClock(50); }
        return targets[0].zernio_account_id;
      },
    }];
    const fixture = transport(async () => {
      calls++;
      received = true;
      return Response.json(body());
    }, 10);
    await assert.rejects(() => operation === "publish"
      ? publishPost({ postId: "local-post", targets: finalTargets }, fixture)
      : inspectPost("external-post", finalTargets, fixture), /timeout|deadline/i);
    assert.equal(calls, 1);
    assert.equal(normalizations, 1);
  });
}
