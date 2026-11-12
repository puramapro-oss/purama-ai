// Cron consumer for `social_posts` rows left in status='scheduled'.
//
// The defect this closes: social-publish (see ../social-publish/index.ts)
// lets a user pick a future scheduledAt, inserts a row with
// status='scheduled', but nothing in this project ever revisited that row
// once scheduled_at was due — no pg_cron job, no worker referenced
// `social_posts` at all (the only existing crons are
// contracts-auto-cancel / contracts-reminders / contracts-weekly-report,
// unrelated). Scheduled posts were silently never published.
//
// This function claims due rows in 2 steps — SELECT id ... LIMIT (candidates)
// then UPDATE ... WHERE status='scheduled' AND id IN (candidates) — never a
// single UPDATE with a trailing `.limit()`. PostgREST only applies `limit`
// (and the `Range`/count-based paging it maps to) to SELECT responses; on an
// UPDATE it is silently ignored by the protocol, so a `.update().limit(50)`
// looked capped in review but actually claimed the ENTIRE backlog of due
// rows on every invocation (contre-audit finding #1). The UPDATE still keeps
// `WHERE status='scheduled'` so a second concurrent invocation racing on the
// same candidate ids matches zero rows once the first has flipped them —
// that half of the atomicity claim was correct, only the "50 at a time" cap
// was not.
//
// Each claimed row is published via the exact same real publish logic used
// by the immediate path (executeSocialPublish / zernio.publishPost), marking
// published/failed/publish_unconfirmed — never silent (see
// _shared/social-publish-core.ts for the 3-way outcome and why a DB write
// failure AFTER a real successful publish must never be marked 'failed').
//
// Before claiming new rows, this also requeues rows stuck in 'publishing'
// for longer than STALLED_PUBLISHING_MS: if a previous invocation crashed
// between claiming a row (status='publishing') and resolving it
// (published/failed/publish_unconfirmed), that row would otherwise stay
// wedged in 'publishing' forever and never get republished (contre-audit
// finding #2). Rows already carrying a non-null error_message are excluded
// from requeue on purpose — that is exactly how a publish_unconfirmed
// anomaly (finding #3) is marked, and it must never be silently re-queued.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, publishPost, type Platform } from "../_shared/zernio.ts";
import {
  executeSocialPublish,
  type SocialPostRow,
} from "../_shared/social-publish-core.ts";

export const MAX_BATCH = 50;

// A publication (Zernio HTTP call + 1 DB write) is fast — 5 minutes is
// already generous slack over any realistic invocation time, chosen
// deliberately shorter than the 15min used by packages/smarana for its
// heavier compress_memory (LLM call) jobs.
export const STALLED_PUBLISHING_MS = 5 * 60 * 1000;

/**
 * Handles a single invocation of the scheduled-posts consumer.
 * Extracted from the `serve()` wrapper so it can be unit-tested against a
 * fake in-memory Supabase-like client, without any real network or the
 * Deno.serve HTTP runtime.
 */
export async function handleScheduledConsumerRequest(
  req: Request,
  supabase: SupabaseClient,
  cronSecret: string | undefined,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Fail closed: this function runs with the service role and publishes to
  // real social accounts on behalf of any user — it must never be reachable
  // without the shared cron secret, and must refuse to run if that secret
  // isn't configured (misconfiguration must not silently mean "open").
  if (!cronSecret) {
    console.error("[social-publish-scheduled] CRON_SECRET not configured");
    return new Response(
      JSON.stringify({ error: "CRON_SECRET not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const nowIso = new Date().toISOString();

    // Step 0: requeue rows stuck in 'publishing' past STALLED_PUBLISHING_MS
    // (a crashed previous invocation) back to 'scheduled', so the claim step
    // below can pick them back up. Excludes rows with a non-null
    // error_message — those are publish_unconfirmed anomalies (real publish
    // succeeded, DB write failed) and must never be auto-requeued.
    const stalledThresholdIso = new Date(
      Date.now() - STALLED_PUBLISHING_MS,
    ).toISOString();
    const { data: stalledCandidates, error: stalledSelectError } = await supabase
      .from("social_posts")
      .select("id")
      .eq("status", "publishing")
      .is("error_message", null)
      .lte("updated_at", stalledThresholdIso)
      .limit(MAX_BATCH);
    if (stalledSelectError) throw stalledSelectError;

    const stalledIds = (stalledCandidates ?? []).map((r: { id: string }) => r.id);
    if (stalledIds.length > 0) {
      const { error: requeueError } = await supabase
        .from("social_posts")
        .update({ status: "scheduled" })
        .eq("status", "publishing")
        .in("id", stalledIds);
      if (requeueError) throw requeueError;
    }

    // Step 1: SELECT the ids of due rows, bounded by MAX_BATCH. This is the
    // only place a batch cap can be expressed — see the note atop this file
    // on why `.limit()` on the UPDATE itself would be a no-op.
    const { data: candidates, error: selectError } = await supabase
      .from("social_posts")
      .select("id")
      .eq("status", "scheduled")
      .lte("scheduled_at", nowIso)
      .limit(MAX_BATCH);
    if (selectError) throw selectError;

    const candidateIds = (candidates ?? []).map((r: { id: string }) => r.id);

    let rows: SocialPostRow[] = [];
    if (candidateIds.length > 0) {
      // Step 2: claim exactly those ids, still guarded by
      // WHERE status='scheduled' — a second concurrent invocation racing on
      // the same candidate ids matches zero rows once the first has flipped
      // them to 'publishing', so this stays safe against double-publishing
      // even though the cap is no longer enforced by a single statement.
      const { data: claimed, error: claimError } = await supabase
        .from("social_posts")
        .update({ status: "publishing" })
        .eq("status", "scheduled")
        .in("id", candidateIds)
        .select();
      if (claimError) throw claimError;
      rows = (claimed ?? []) as SocialPostRow[];
    }

    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ success: true, processed: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let published = 0;
    let failed = 0;
    let unconfirmed = 0;

    for (const row of rows) {
      const post: SocialPostRow = {
        id: row.id,
        user_id: row.user_id,
        content_text: row.content_text,
        content_media_urls: row.content_media_urls,
        target_platforms: row.target_platforms || [],
      };

      const outcome = await executeSocialPublish(post, {
        fetchAccounts: async (userId, wantedPlatforms) => {
          const { data: accounts, error: accError } = await supabase
            .from("social_accounts")
            .select("platform, zernio_profile_id")
            .eq("user_id", userId)
            .eq("is_active", true)
            .in("platform", wantedPlatforms);
          if (accError) throw accError;
          return (accounts ?? []).map((a: Record<string, unknown>) => ({
            platform: a.platform as string,
            zernio_profile_id: a.zernio_profile_id as string,
          }));
        },
        publish: (params) =>
          publishPost({ ...params, platforms: params.platforms as Platform[] }),
        markFailed: async (postId, message) => {
          const { error } = await supabase
            .from("social_posts")
            .update({ status: "failed", error_message: message })
            .eq("id", postId);
          if (error) throw error;
        },
        markPublished: async (postId, result) => {
          const { error } = await supabase
            .from("social_posts")
            .update({
              status: "published",
              published_at: new Date().toISOString(),
              zernio_post_id:
                (result.id as string) || (result.post_id as string) || null,
              zernio_response: result,
            })
            .eq("id", postId);
          // Real supabase-js does NOT throw on a DB error, it resolves
          // { error } — must throw explicitly so executeSocialPublish's
          // post-success catch (publish_unconfirmed path) actually runs
          // instead of silently reporting 'published' on a failed write.
          if (error) throw error;
        },
        markPublishAnomaly: async (postId, result, writeError) => {
          // Deliberately does NOT touch `status` (row stays 'publishing',
          // excluded from the requeue-stalled step above because
          // error_message is now non-null) — see finding #3: the real
          // publish already succeeded, so this must never become 'failed'
          // (retryable) nor silently 'scheduled' again (double-post).
          const { error } = await supabase
            .from("social_posts")
            .update({
              error_message:
                `ANOMALIE publish_unconfirmed: publication Zernio reussie ` +
                `(${JSON.stringify(result)}) mais ecriture DB echouee: ${writeError}. ` +
                `Verification manuelle requise — ne pas retenter.`,
            })
            .eq("id", postId);
          if (error) {
            console.error(
              `[social-publish-scheduled] echec ecriture de l'anomalie pour post ${postId}:`,
              error,
            );
          }
        },
      });

      if (outcome.status === "published") published++;
      else if (outcome.status === "publish_unconfirmed") unconfirmed++;
      else failed++;
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed: rows.length,
        published,
        failed,
        unconfirmed,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[social-publish-scheduled]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// Only bind an actual HTTP listener when this module is the entrypoint
// (real Supabase Edge Function runtime). Importing it from a test file must
// not start a server.
if (import.meta.main) {
  serve((req) => {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { db: { schema: "purama_ai" } },
    );
    return handleScheduledConsumerRequest(req, supabase, Deno.env.get("CRON_SECRET"));
  });
}
