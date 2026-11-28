import type { ProviderPublishResult, PublishOutcome, SocialAccountTarget } from "./social-publish-core.ts";
import { providerValues, rowObject, type SocialDbClient, type StoredSocialPost } from "./social-publish-store.ts";

export type InspectProviderPost = (
  externalPostId: string,
  targets: SocialAccountTarget[],
) => Promise<ProviderPublishResult>;

/** Read-only provider reconciliation. No path in this function can publish. */
export async function reconcileSocialPost(
  db: SocialDbClient,
  post: StoredSocialPost,
  inspect: InspectProviderPost,
): Promise<PublishOutcome> {
  const unresolved = async (error: string): Promise<PublishOutcome> => {
    if (post.status === "publish_unconfirmed" && post.zernio_post_id && post.target_accounts) {
      try {
        // Record a read attempt so repeatedly unavailable older provider IDs
        // do not monopolize the bounded queue. Never change the remote ID or
        // overwrite another worker's confirmed state.
        const { data, error: writeError } = await db.from("social_posts").update({ error_message: error })
          .eq("id", post.id).eq("user_id", post.user_id)
          .eq("status", "publish_unconfirmed").eq("zernio_post_id", post.zernio_post_id)
          .select("id");
        if (writeError || !Array.isArray(data) || data.length !== 1 || rowObject(data[0])?.id !== post.id) {
          console.warn("[social-publish] Reconciliation attempt write not confirmed", post.id);
        }
      } catch {
        console.warn("[social-publish] Reconciliation attempt write unavailable", post.id);
      }
    }
    return { postId: post.id, status: "publish_unconfirmed", retryable: false, error };
  };
  const targets = post.target_accounts;
  if (post.status !== "publish_unconfirmed" || !post.zernio_post_id ||
    !Array.isArray(targets) || !targets.length || targets.length !== post.target_platforms.length ||
    new Set(post.target_platforms).size !== targets.length ||
    targets.some((target) => !target || !post.target_platforms.includes(target.platform) ||
      typeof target.zernio_account_id !== "string" || !target.zernio_account_id ||
      typeof target.zernio_profile_id !== "string" || !target.zernio_profile_id) ||
    new Set(targets.map((target) => target.platform)).size !== targets.length) {
    return unresolved("Identité fournisseur ou destinations absentes ; vérification manuelle requise.");
  }
  try {
    const result = await inspect(post.zernio_post_id, targets);
    if (result.externalPostId !== post.zernio_post_id) {
      return unresolved("La réponse ne correspond pas à la publication enregistrée.");
    }
    const { data, error } = await db.from("social_posts").update(providerValues(result))
      .eq("id", post.id).eq("user_id", post.user_id)
      .eq("status", "publish_unconfirmed").eq("zernio_post_id", post.zernio_post_id)
      .select("id");
    if (error || !Array.isArray(data) || data.length !== 1 || rowObject(data[0])?.id !== post.id) {
      return unresolved("Réconciliation reçue, mais enregistrement non confirmé.");
    }
    return {
      postId: post.id, status: result.status, retryable: false,
      externalPostId: result.externalPostId, platformResults: result.platformResults,
      error: result.error,
    };
  } catch {
    return unresolved("Vérification du fournisseur indisponible ; aucun renvoi automatique.");
  }
}
