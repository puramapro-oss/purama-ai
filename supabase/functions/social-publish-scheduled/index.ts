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
// This function claims due rows atomically (a single UPDATE ... WHERE
// status='scheduled' AND scheduled_at<=now() RETURNING *, executed by
// supabase-js as one SQL statement — a second concurrent invocation's UPDATE
// simply matches zero rows once the first has flipped them to 'publishing'),
// then publishes each claimed row via the exact same real publish logic used
// by the immediate path (executeSocialPublish / zernio.publishPost), marking
// published/failed with a non-empty error message on failure — never silent.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, publishPost, type Platform } from "../_shared/zernio.ts";
import {
  executeSocialPublish,
  type SocialPostRow,
} from "../_shared/social-publish-core.ts";

const MAX_BATCH = 50;

/**
 * Handles a single invocation of the scheduled-posts consumer.
 * Extracted from the `serve()` wrapper so it can be unit-tested against a
 * fake in-memory Supabase-like client, without any real network or the
 * Deno.serve HTTP runtime.
 */
export async function handleScheduledConsumerRequest(
  req: Request,
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient<any, any, any> | any,
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

    // Atomic claim: one UPDATE statement, WHERE status='scheduled' AND
    // scheduled_at<=now(), transitioning straight to 'publishing'. Never a
    // SELECT followed by a separate UPDATE (that would race two overlapping
    // cron runs into double-publishing the same post).
    const { data: claimed, error: claimError } = await supabase
      .from("social_posts")
      .update({ status: "publishing" })
      .eq("status", "scheduled")
      .lte("scheduled_at", nowIso)
      .select()
      .limit(MAX_BATCH);
    if (claimError) throw claimError;

    const rows = claimed ?? [];
    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ success: true, processed: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let published = 0;
    let failed = 0;

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
        markPublished: async (postId, result) => {
          await supabase
            .from("social_posts")
            .update({
              status: "published",
              published_at: new Date().toISOString(),
              zernio_post_id:
                (result.id as string) || (result.post_id as string) || null,
              zernio_response: result,
            })
            .eq("id", postId);
        },
        markFailed: async (postId, message) => {
          await supabase
            .from("social_posts")
            .update({ status: "failed", error_message: message })
            .eq("id", postId);
        },
      });

      if (outcome.status === "published") published++;
      else failed++;
    }

    return new Response(
      JSON.stringify({ success: true, processed: rows.length, published, failed }),
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
