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
}

export interface PublishOutcome {
  postId: string;
  status: "published" | "failed";
  error?: string;
}

/**
 * Executes the real publish for a single social_posts row and persists the
 * final state (published or failed). Never throws — always resolves with the
 * outcome, and never leaves the row silently unresolved.
 */
export async function executeSocialPublish(
  post: SocialPostRow,
  deps: PublishDeps,
): Promise<PublishOutcome> {
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

    const result = await deps.publish({
      text: post.content_text || "",
      mediaUrls:
        post.content_media_urls && post.content_media_urls.length
          ? post.content_media_urls
          : undefined,
      platforms,
      profileIds,
    });

    await deps.markPublished(post.id, result);
    return { postId: post.id, status: "published" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await deps.markFailed(post.id, message);
    return { postId: post.id, status: "failed", error: message };
  }
}
