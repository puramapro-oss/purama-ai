// Proof of the defect + the fix, exercised through the real exported
// handler (handleScheduledConsumerRequest), never a reimplementation of its
// logic. Network calls to Zernio are stubbed via a global fetch replacement
// (no real key, no real HTTP). The Supabase client is a small in-memory fake
// reproducing the exact chain the handler calls (update/eq/lte/select/limit,
// select/eq/in), so the atomic "claim" UPDATE is really exercised.
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
import { handleScheduledConsumerRequest } from "./index.ts";

const CRON_SECRET = "test-cron-secret-123";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function makeFakeSupabase(db: { social_posts: Row[]; social_accounts: Row[] }) {
  function table(name: "social_posts" | "social_accounts") {
    let mode: "select" | "update" = "select";
    let updatePayload: Row | null = null;
    const filters: ((row: Row) => boolean)[] = [];
    let limitN: number | undefined;

    // deno-lint-ignore no-explicit-any
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
      in(col: string, vals: unknown[]) {
        filters.push((row) => vals.includes(row[col]));
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      // Thenable: `await` triggers execution, exactly once, like a real
      // PostgREST query builder. This is where the "atomic claim" UPDATE
      // actually runs against the in-memory rows.
      then(
        resolve: (v: { data: Row[] | null; error: unknown }) => void,
        reject?: (e: unknown) => void,
      ) {
        try {
          const rows = db[name];
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (mode === "update" && updatePayload) {
            for (const r of matched) Object.assign(r, updatePayload);
          }
          if (limitN !== undefined) matched = matched.slice(0, limitN);
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
