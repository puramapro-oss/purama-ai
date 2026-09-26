// Shared publish execution logic used by both:
//  - social-publish (immediate publish at request time)
//  - social-publish-scheduled (cron consumer for posts whose scheduled_at is due)
//
// Isolated from Deno/Supabase client wiring so it can be unit-tested with
// plain in-memory stubs (no real network, no real Supabase client).

export interface SocialPostRow {
  id: string;
  user_id: string;
  content_text: string | null;
  content_media_urls: string[] | null;
  target_platforms: string[];
}

export interface SocialAccountRef {
  platform: string;
  zernio_profile_id: string;
}

export interface PublishDeps {
  /** Loads the user's active connected accounts for the given platforms. */
  fetchAccounts: (
    userId: string,
    platforms: string[],
  ) => Promise<SocialAccountRef[]>;
  /** Performs the real publish call against the social platform aggregator. */
  publish: (params: {
    text: string;
    mediaUrls?: string[];
    platforms: string[];
    profileIds: string[];
  }) => Promise<Record<string, unknown>>;
  markPublished: (
    postId: string,
    result: Record<string, unknown>,
  ) => Promise<void>;
  markFailed: (postId: string, message: string) => Promise<void>;
  /**
   * Called when the external publish (Zernio) call genuinely SUCCEEDED but
   * the follow-up DB write (markPublished) then failed. This must never
   * result in status='failed' — a future retry would re-publish a post that
   * is already live on the real platform (double-post). Optional so callers
   * that don't need the distinction (none should exist in production) still
   * type-check; when omitted the anomaly is only logged.
   */
  markPublishAnomaly?: (
    postId: string,
    result: Record<string, unknown>,
    writeError: string,
  ) => Promise<void>;
}

export interface PublishOutcome {
  postId: string;
  status: "published" | "failed" | "publish_unconfirmed";
  error?: string;
}

/**
 * Executes the real publish for a single social_posts row and persists the
 * final state. Never throws — always resolves with the outcome, and never
 * leaves the row silently unresolved.
 *
 * Two distinct failure classes are handled on purpose (contre-audit finding):
 *  - failure BEFORE/DURING the external publish call: nothing was actually
 *    posted, so status='failed' (safe to retry later) is correct.
 *  - failure AFTER the external publish call succeeded (i.e. the DB write in
 *    markPublished itself throws): the post IS live on the real platform.
 *    Marking 'failed' here would let a future retry re-publish it. This path
 *    never calls markFailed and returns 'publish_unconfirmed' instead.
 */
export async function executeSocialPublish(
  post: SocialPostRow,
  deps: PublishDeps,
): Promise<PublishOutcome> {
  let result: Record<string, unknown>;
  try {
    const accounts = await deps.fetchAccounts(
      post.user_id,
      post.target_platforms,
    );
    if (!accounts.length) {
      throw new Error(
        "Aucun compte social actif pour les plateformes ciblées",
      );
    }

    const profileIds = accounts.map((a) => a.zernio_profile_id);
    const platforms = accounts.map((a) => a.platform);

    result = await deps.publish({
      text: post.content_text || "",
      mediaUrls:
        post.content_media_urls && post.content_media_urls.length
          ? post.content_media_urls
          : undefined,
      platforms,
      profileIds,
    });
  } catch (e) {
    // Nothing was published (or the publish call itself failed) — safe to
    // mark failed, a future retry cannot double-post.
    const message = e instanceof Error ? e.message : String(e);
    await deps.markFailed(post.id, message);
    return { postId: post.id, status: "failed", error: message };
  }

  try {
    await deps.markPublished(post.id, result);
    return { postId: post.id, status: "published" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[social-publish-core] ANOMALIE post-succes: publication Zernio reussie pour post ${post.id} mais l'ecriture DB 'published' a echoue (${message}). NE PAS retenter automatiquement (risque de double-post) — verification manuelle requise.`,
    );
    if (deps.markPublishAnomaly) {
      try {
        await deps.markPublishAnomaly(post.id, result, message);
      } catch (anomalyError) {
        const anomalyMessage =
          anomalyError instanceof Error ? anomalyError.message : String(anomalyError);
        console.error(
          `[social-publish-core] ANOMALIE post-succes: l'ecriture de l'anomalie elle-meme a echoue pour post ${post.id} (${anomalyMessage}). La ligne reste en 'publishing' — verification manuelle requise.`,
        );
      }
    }
    return { postId: post.id, status: "publish_unconfirmed", error: message };
  }
}
