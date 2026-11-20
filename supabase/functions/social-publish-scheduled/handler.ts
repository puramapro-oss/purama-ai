// A durable claim is never replayed merely because it is old. A timeout,
// process crash or lost DB response can happen after a real publication.
import { executeSocialPublish, type PublishDeps } from "../_shared/social-publish-core.ts";
import {
  createPublishDeps,
  parseSocialPost,
  rowObject,
  type SocialDbClient,
} from "../_shared/social-publish-store.ts";
import { corsHeaders, inspectPost, publishPost } from "../_shared/zernio.ts";
import { reconcileSocialPost, type InspectProviderPost } from "../_shared/social-publish-reconcile.ts";

export const MAX_BATCH = 50;
export const STALLED_PUBLISHING_MS = 5 * 60 * 1000;
export const MAX_RUN_MS = 45_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function handleScheduledConsumerRequest(
  req: Request,
  supabase: SocialDbClient,
  cronSecret: string | undefined,
  publish: PublishDeps["publish"] = publishPost,
  now: () => number = Date.now,
  inspect: InspectProviderPost = inspectPost,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!cronSecret) return jsonResponse({ error: "CRON_SECRET not configured" }, 500);
  if (req.headers.get("Authorization") !== "Bearer " + cronSecret) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  try {
    const startedAt = now();
    const nowIso = new Date(startedAt).toISOString();
    const staleBefore = new Date(startedAt - STALLED_PUBLISHING_MS).toISOString();
    const { data: stalled, error: stalledError } = await supabase.from("social_posts")
      .select("id").eq("status", "publishing").lte("updated_at", staleBefore)
      .order("updated_at", { ascending: true }).limit(MAX_BATCH);
    if (stalledError || !Array.isArray(stalled)) throw new Error("Could not read stalled claims");
    const staleIds = stalled.map((row) => rowObject(row)?.id);
    let quarantined = 0;
    if (staleIds.length) {
      // Recheck the same state and timestamp in the write. Even when this
      // write fails, only scheduled rows can be claimed below.
      const { data, error } = await supabase.from("social_posts").update({
        status: "publish_unconfirmed",
        error_message: "Tentative interrompue ou trop ancienne ; résultat à vérifier, aucun renvoi automatique.",
      }).eq("status", "publishing").lte("updated_at", staleBefore)
        .in("id", staleIds).select("id");
      if (error || !Array.isArray(data)) throw new Error("Could not quarantine stalled claims");
      quarantined = data.length;
    }

    const { data: candidates, error: selectError } = await supabase.from("social_posts")
      .select("id,user_id").eq("status", "scheduled").lte("scheduled_at", nowIso)
      .order("scheduled_at", { ascending: true }).limit(MAX_BATCH);
    if (selectError || !Array.isArray(candidates)) throw new Error("Could not read scheduled posts");

    let processed = 0;
    let published = 0;
    let partial = 0;
    let failed = 0;
    let unconfirmed = 0;
    for (const candidate of candidates) {
      if (now() - startedAt >= MAX_RUN_MS) break;
      const row = rowObject(candidate);
      if (!row || typeof row.id !== "string" || typeof row.user_id !== "string") {
        throw new Error("Invalid scheduled candidate");
      }
      // Claim just before processing, not the whole batch in advance. A
      // bounded invocation leaves later rows scheduled for the next worker.
      const { data, error } = await supabase.from("social_posts")
        .update({ status: "publishing" })
        .eq("id", row.id).eq("user_id", row.user_id)
        .eq("status", "scheduled").lte("scheduled_at", nowIso).select("*");
      if (error || !Array.isArray(data) || data.length > 1) throw new Error("Claim was not confirmed");
      if (!data.length) continue; // Another worker claimed or cancelled it.
      const post = parseSocialPost(data[0]);
      if (post.id !== row.id || post.user_id !== row.user_id) throw new Error("Unexpected claim owner");
      const outcome = await executeSocialPublish(post, createPublishDeps(supabase, publish, now));
      processed++;
      if (outcome.status === "published") published++;
      else if (outcome.status === "partial") partial++;
      else if (outcome.status === "failed") failed++;
      else unconfirmed++;
    }

    let reconciled = 0;
    let reconciledPublished = 0;
    let reconciledPartial = 0;
    let reconciledFailed = 0;
    let reconciliationUnconfirmed = 0;
    if (now() - startedAt < MAX_RUN_MS) {
      const { data: pending, error } = await supabase.from("social_posts")
        .select("*").eq("status", "publish_unconfirmed")
        .not("zernio_post_id", "is", null).not("target_accounts", "is", null)
        .lte("updated_at", staleBefore)
        .order("updated_at", { ascending: true }).limit(MAX_BATCH);
      if (error || !Array.isArray(pending)) throw new Error("Could not read pending confirmations");
      for (const row of pending) {
        if (now() - startedAt >= MAX_RUN_MS) break;
        const post = parseSocialPost(row);
        // No provider ID means manual review, never another POST.
        if (!post.zernio_post_id) continue;
        const result = await reconcileSocialPost(supabase, post, inspect);
        reconciled++;
        if (result.status === "published") reconciledPublished++;
        else if (result.status === "partial") reconciledPartial++;
        else if (result.status === "failed") reconciledFailed++;
        else reconciliationUnconfirmed++;
      }
    }

    return jsonResponse({
      success: failed === 0 && partial === 0 && unconfirmed === 0 && quarantined === 0 && reconciledPartial === 0 && reconciledFailed === 0 && reconciliationUnconfirmed === 0,
      reconciled, reconciled_published: reconciledPublished,
      reconciled_partial: reconciledPartial, reconciled_failed: reconciledFailed,
      reconciliation_unconfirmed: reconciliationUnconfirmed,
      processed, published, partial, failed, unconfirmed, quarantined,
    });
  } catch {
    console.error("[social-publish-scheduled] Database operation not confirmed; no claimed post will be replayed");
    return jsonResponse({ error: "Traitement interrompu ; les publications incertaines ne sont pas renvoyées." }, 503);
  }
}
