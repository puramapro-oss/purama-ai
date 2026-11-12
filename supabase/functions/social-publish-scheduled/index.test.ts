// Proof of the defect + the fix, exercised through the real exported
// handler (handleScheduledConsumerRequest), never a reimplementation of its
// logic. Network calls to Zernio are stubbed via a global fetch replacement
// (no real key, no real HTTP). The Supabase client is a small in-memory fake
// reproducing the exact chain the handler calls (select/eq/lte/limit,
// update/eq/in/select, select/eq/is/lte/limit), so the 2-step claim and the
// requeue step are really exercised.
//
// `limit()` semantics deliberately mirror the REAL PostgREST protocol, not a
// convenient fiction: `limit` only ever bounds the ROWS RETURNED FROM A
// SELECT. Applied after `.update()` it does nothing — PostgREST has no
// concept of a row-capped update. An earlier version of this mock applied
// `limitN` unconditionally regardless of `mode`, which made a buggy
// `update().limit(50)` in the handler look correctly capped in tests when in
// production it claimed the entire backlog every run (contre-audit finding
// #1). If this mock is ever changed back to cap updates, the
// "more than MAX_BATCH due rows" test below will start failing to catch
// that regression, not silently passing.
//
// NOTE: _shared/zernio.ts reads ZERNIO_API_KEY at module-load time (not
// per-call), which happens as soon as this test file's static `import` of
// ./index.ts runs — before any Deno.test body executes. The in-test
// `Deno.env.set("ZERNIO_API_KEY", ...)` calls below are therefore only
// documentation of intent; the value that actually matters must be present
// in the process environment *before* `deno test` starts, e.g.:
//   ZERNIO_API_KEY=test-key deno test --allow-env --allow-net=example.com \
//     supabase/functions/social-publish-scheduled/index.test.ts
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  handleScheduledConsumerRequest,
  MAX_BATCH,
} from "./index.ts";

const CRON_SECRET = "test-cron-secret-123";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous in-memory database rows
type Row = Record<string, any>;

interface FakeDbControls {
  /** When true, the NEXT update that sets status='published' resolves with
   * an error instead of applying — simulates a real supabase-js DB write
   * failure that happens AFTER the external Zernio publish already
   * succeeded (finding #3). Consumed (reset to false) after firing once. */
  failNextPublishedWrite?: boolean;
}

function makeFakeSupabase(
  db: { social_posts: Row[]; social_accounts: Row[] },
  controls: FakeDbControls = {},
) {
  function table(name: "social_posts" | "social_accounts") {
    let mode: "select" | "update" = "select";
    let updatePayload: Row | null = null;
    const filters: ((row: Row) => boolean)[] = [];
    let limitN: number | undefined;

    // deno-lint-ignore no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- recursive thenable mock for the Supabase fluent API
    const builder: any = {
      update(payload: Row) {
        mode = "update";
        updatePayload = payload;
        return builder;
      },
      select(_cols?: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((row) => row[col] === val);
        return builder;
      },
      lte(col: string, val: string) {
        filters.push((row) => row[col] != null && row[col] <= val);
        return builder;
      },
      is(col: string, val: null) {
        filters.push((row) => (row[col] ?? null) === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters.push((row) => vals.includes(row[col]));
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      // Thenable: `await` triggers execution, exactly once, like a real
      // PostgREST query builder.
      then(
        resolve: (v: { data: Row[] | null; error: unknown }) => void,
        reject?: (e: unknown) => void,
      ) {
        try {
          if (
            mode === "update" &&
            updatePayload &&
            (updatePayload as Row).status === "published" &&
            controls.failNextPublishedWrite
          ) {
            controls.failNextPublishedWrite = false;
            resolve({ data: null, error: new Error("simulated DB write failure") });
            return Promise.resolve();
          }

          const rows = db[name];
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (mode === "update" && updatePayload) {
            // REAL semantics: `limit` is never applied on an UPDATE, only on
            // a SELECT — see the note atop this file.
            for (const r of matched) Object.assign(r, updatePayload);
          } else if (limitN !== undefined) {
            matched = matched.slice(0, limitN);
          }
          resolve({ data: matched, error: null });
        } catch (e) {
          if (reject) reject(e);
          else resolve({ data: null, error: e });
        }
        return Promise.resolve();
      },
    };
    return builder;
  }
  return { from: table };
}

function makeReq(secret?: string): Request {
  return new Request("https://example.com/social-publish-scheduled", {
    method: "POST",
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  });
}

function nowMinus(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}
function nowPlus(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

Deno.test("rejects with 500 when CRON_SECRET is not configured (fail closed)", async () => {
  const supabase = makeFakeSupabase({ social_posts: [], social_accounts: [] });
  const res = await handleScheduledConsumerRequest(makeReq(CRON_SECRET), supabase, undefined);
  assertEquals(res.status, 500);
});

Deno.test("rejects with 401 when the bearer secret does not match", async () => {
  const supabase = makeFakeSupabase({ social_posts: [], social_accounts: [] });
  const res = await handleScheduledConsumerRequest(makeReq("wrong-secret"), supabase, CRON_SECRET);
  assertEquals(res.status, 401);
});

Deno.test("a due row (scheduled_at in the past) is claimed and published", async () => {
  Deno.env.set("ZERNIO_API_KEY", "test-key");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ id: "zernio-post-1" }), { status: 200 }),
    )) as typeof fetch;

  try {
    const db: { social_posts: Row[]; social_accounts: Row[] } = {
      social_posts: [
        {
          id: "post-due",
          user_id: "user-1",
          content_text: "hello world",
          content_media_urls: [],
          target_platforms: ["instagram"],
          status: "scheduled",
          scheduled_at: nowMinus(5),
        },
      ],
      social_accounts: [
        {
          user_id: "user-1",
          platform: "instagram",
          zernio_profile_id: "profile-1",
          is_active: true,
        },
      ],
    };
    const supabase = makeFakeSupabase(db);
    const res = await handleScheduledConsumerRequest(makeReq(CRON_SECRET), supabase, CRON_SECRET);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.processed, 1);
    assertEquals(body.published, 1);
    assertEquals(body.failed, 0);
    assertEquals(db.social_posts[0].status, "published");
    assertExists(db.social_posts[0].published_at);
    assertEquals(db.social_posts[0].zernio_post_id, "zernio-post-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a future row (scheduled_at not yet due) is not touched", async () => {
  const db: { social_posts: Row[]; social_accounts: Row[] } = {
    social_posts: [
      {
        id: "post-future",
        user_id: "user-1",
        content_text: "later",
        content_media_urls: [],
        target_platforms: ["instagram"],
        status: "scheduled",
        scheduled_at: nowPlus(60),
      },
    ],
    social_accounts: [] as Row[],
  };
  const supabase = makeFakeSupabase(db);
  const res = await handleScheduledConsumerRequest(makeReq(CRON_SECRET), supabase, CRON_SECRET);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.processed, 0);
  assertEquals(db.social_posts[0].status, "scheduled");
});

Deno.test("an already-published row is never re-claimed even if scheduled_at is past", async () => {
  const db: { social_posts: Row[]; social_accounts: Row[] } = {
    social_posts: [
      {
        id: "post-already-published",
        user_id: "user-1",
        content_text: "already out",
        content_media_urls: [],
        target_platforms: ["instagram"],
        status: "published",
        scheduled_at: nowMinus(120),
        published_at: nowMinus(119),
      },
    ],
    social_accounts: [] as Row[],
  };
  const supabase = makeFakeSupabase(db);
  const res = await handleScheduledConsumerRequest(makeReq(CRON_SECRET), supabase, CRON_SECRET);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.processed, 0);
  assertEquals(db.social_posts[0].status, "published");
});

Deno.test("a simulated network failure marks the row failed with a non-empty error", async () => {
  Deno.env.set("ZERNIO_API_KEY", "test-key");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(new TypeError("network error: connection reset"))) as typeof fetch;

  try {
    const db: { social_posts: Row[]; social_accounts: Row[] } = {
      social_posts: [
        {
          id: "post-due-fails",
          user_id: "user-1",
          content_text: "will fail",
          content_media_urls: [],
          target_platforms: ["instagram"],
          status: "scheduled",
          scheduled_at: nowMinus(1),
        },
      ],
      social_accounts: [
        {
          user_id: "user-1",
          platform: "instagram",
          zernio_profile_id: "profile-1",
          is_active: true,
        },
      ],
    };
    const supabase = makeFakeSupabase(db);
    const res = await handleScheduledConsumerRequest(makeReq(CRON_SECRET), supabase, CRON_SECRET);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.processed, 1);
    assertEquals(body.published, 0);
    assertEquals(body.failed, 1);
    assertEquals(db.social_posts[0].status, "failed");
    assertExists(db.social_posts[0].error_message);
    assertEquals((db.social_posts[0].error_message as string).length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Contre-audit finding #1: `.limit()` on an UPDATE is a no-op on real
// PostgREST — a single `update().limit(MAX_BATCH)` therefore claims the
// ENTIRE due backlog, not just MAX_BATCH rows. This test seeds more than
// MAX_BATCH due rows and proves only MAX_BATCH get claimed+published, the
// rest staying untouched in 'scheduled' for the next invocation.
Deno.test("more than MAX_BATCH due rows: only MAX_BATCH are claimed and published, the rest stay 'scheduled'", async () => {
  Deno.env.set("ZERNIO_API_KEY", "test-key");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ id: "zernio-post-batch" }), { status: 200 }),
    )) as typeof fetch;

  try {
    const total = MAX_BATCH + 5;
    const posts: Row[] = [];
    for (let i = 0; i < total; i++) {
      posts.push({
        id: `post-due-${i}`,
        user_id: "user-1",
        content_text: `post ${i}`,
        content_media_urls: [],
        target_platforms: ["instagram"],
        status: "scheduled",
        scheduled_at: nowMinus(5),
      });
    }
    const db: { social_posts: Row[]; social_accounts: Row[] } = {
      social_posts: posts,
      social_accounts: [
        {
          user_id: "user-1",
          platform: "instagram",
          zernio_profile_id: "profile-1",
          is_active: true,
        },
      ],
    };
    const supabase = makeFakeSupabase(db);
    const res = await handleScheduledConsumerRequest(makeReq(CRON_SECRET), supabase, CRON_SECRET);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.processed, MAX_BATCH);
    assertEquals(body.published, MAX_BATCH);

    const stillScheduled = db.social_posts.filter((r) => r.status === "scheduled").length;
    const nowPublished = db.social_posts.filter((r) => r.status === "published").length;
    assertEquals(stillScheduled, total - MAX_BATCH);
    assertEquals(nowPublished, MAX_BATCH);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Contre-audit finding #2: a row left in 'publishing' by a previous
// invocation that crashed before resolving it must eventually be requeued,
// never wedged forever. A stale 'publishing' row (updated_at older than
// STALLED_PUBLISHING_MS, error_message null, scheduled_at in the past) is
// requeued to 'scheduled' and reclaimed within the SAME invocation.
Deno.test("a stalled 'publishing' row (crashed previous run) is requeued and republished", async () => {
  Deno.env.set("ZERNIO_API_KEY", "test-key");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ id: "zernio-post-recovered" }), { status: 200 }),
    )) as typeof fetch;

  try {
    const db: { social_posts: Row[]; social_accounts: Row[] } = {
      social_posts: [
        {
          id: "post-stalled",
          user_id: "user-1",
          content_text: "stuck since a crashed run",
          content_media_urls: [],
          target_platforms: ["instagram"],
          status: "publishing",
          error_message: null,
          scheduled_at: nowMinus(30),
          updated_at: nowMinus(10), // older than the 5min stall threshold
        },
      ],
      social_accounts: [
        {
          user_id: "user-1",
          platform: "instagram",
          zernio_profile_id: "profile-1",
          is_active: true,
        },
      ],
    };
    const supabase = makeFakeSupabase(db);
    const res = await handleScheduledConsumerRequest(makeReq(CRON_SECRET), supabase, CRON_SECRET);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.processed, 1);
    assertEquals(body.published, 1);
    assertEquals(db.social_posts[0].status, "published");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- A 'publishing' row that is still FRESH (well within the stall
// threshold) must be left alone — it might just be a normal invocation
// still in flight (or, in this synchronous-loop implementation, simply
// proves the requeue step doesn't touch rows that aren't actually stale).
Deno.test("a fresh 'publishing' row (within the stall threshold) is not requeued", async () => {
  const db: { social_posts: Row[]; social_accounts: Row[] } = {
    social_posts: [
      {
        id: "post-in-flight",
        user_id: "user-1",
        content_text: "still being processed",
        content_media_urls: [],
        target_platforms: ["instagram"],
        status: "publishing",
        error_message: null,
        scheduled_at: nowMinus(1),
        updated_at: nowMinus(1), // well under the 5min stall threshold
      },
    ],
    social_accounts: [] as Row[],
  };
  const supabase = makeFakeSupabase(db);
  const res = await handleScheduledConsumerRequest(makeReq(CRON_SECRET), supabase, CRON_SECRET);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.processed, 0);
  assertEquals(db.social_posts[0].status, "publishing");
});

// --- Contre-audit finding #3: the external Zernio publish call genuinely
// succeeds, but the follow-up DB write (markPublished) then fails. A retry
// must NEVER be allowed to re-publish an already-live post, so this must
// never end up in status='failed' (that status IS retried by nothing today,
// but "failed" reads as "safe to retry" and future code must not be allowed
// to assume that). The row must stay out of 'scheduled'/'publishing' churn:
// here it stays 'publishing' with a non-null error_message, which also
// keeps it excluded from the requeue-stalled step (see the "is('error_message', null)" guard).
Deno.test("Zernio publish succeeds but the DB write fails: never marked 'failed', never silently requeued", async () => {
  Deno.env.set("ZERNIO_API_KEY", "test-key");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ id: "zernio-post-real-success" }), { status: 200 }),
    )) as typeof fetch;

  try {
    const db: { social_posts: Row[]; social_accounts: Row[] } = {
      social_posts: [
        {
          id: "post-write-fails-after-success",
          user_id: "user-1",
          content_text: "real publish succeeds, DB write does not",
          content_media_urls: [],
          target_platforms: ["instagram"],
          status: "scheduled",
          scheduled_at: nowMinus(1),
        },
      ],
      social_accounts: [
        {
          user_id: "user-1",
          platform: "instagram",
          zernio_profile_id: "profile-1",
          is_active: true,
        },
      ],
    };
    const controls: { failNextPublishedWrite?: boolean } = { failNextPublishedWrite: true };
    const supabase = makeFakeSupabase(db, controls);
    const res = await handleScheduledConsumerRequest(makeReq(CRON_SECRET), supabase, CRON_SECRET);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.processed, 1);
    assertEquals(body.published, 0);
    assertEquals(body.failed, 0);
    assertEquals(body.unconfirmed, 1);

    // Never 'failed' (would authorize a dangerous retry) and never silently
    // back to 'scheduled'/'published' either — it must have stayed exactly
    // where the atomic claim left it.
    assertEquals(db.social_posts[0].status, "publishing");
    assertExists(db.social_posts[0].error_message);
    assertEquals(
      (db.social_posts[0].error_message as string).includes("publish_unconfirmed"),
      true,
    );

    // And it must be excluded from a future requeue-stalled pass: rerun the
    // handler immediately (still within the stall threshold, but even a
    // requeue query filtering on error_message IS NULL would already skip
    // it) and confirm nothing changes.
    const res2 = await handleScheduledConsumerRequest(makeReq(CRON_SECRET), supabase, CRON_SECRET);
    const body2 = await res2.json();
    assertEquals(body2.processed, 0);
    assertEquals(db.social_posts[0].status, "publishing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
