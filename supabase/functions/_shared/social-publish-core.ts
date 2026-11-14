// One execution path for immediate and scheduled publications. A failed HTTP
// request is not evidence that the remote side effect did not happen.

export type PublishStatus =
  | "published"
  | "partial"
  | "failed"
  | "publish_unconfirmed";

export interface SocialAccountTarget {
  platform: string;
  zernio_account_id: string;
  zernio_profile_id: string;
}

export interface SocialAccountRef extends SocialAccountTarget {
  user_id: string;
  is_active: boolean;
  publishing_verified_at: string | null;
}

export interface SocialPostRow {
  id: string;
  user_id: string;
  content_text: string | null;
  content_media_urls: string[] | null;
  target_platforms: string[];
  // Freeze destinations when publication is requested. Reconnecting an
  // account must not silently redirect an older scheduled publication.
  target_accounts: SocialAccountTarget[] | null;
}

export interface PlatformPublishResult {
  platform: string;
  accountId: string;
  status: string;
  postId?: string;
  postUrl?: string;
}

export interface ProviderPublishResult {
  status: PublishStatus;
  externalPostId?: string;
  platformResults: PlatformPublishResult[];
  response: Record<string, unknown>;
  error?: string;
}

/** Only use for a locally rejected operation, before sending any request. */
export class PublishNotStartedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishNotStartedError";
  }
}

export interface PublishDeps {
  fetchAccounts(userId: string, platforms: string[]): Promise<SocialAccountRef[]>;
  publish(params: {
    postId: string;
    text: string;
    mediaUrls?: string[];
    targets: SocialAccountTarget[];
  }): Promise<ProviderPublishResult>;
  markResult(post: SocialPostRow, result: ProviderPublishResult): Promise<void>;
  markFailed(post: SocialPostRow, message: string): Promise<void>;
  markPublishAnomaly(
    post: SocialPostRow,
    message: string,
    result?: ProviderPublishResult,
  ): Promise<void>;
  now?: () => number;
}

export interface PublishOutcome {
  postId: string;
  status: PublishStatus;
  // This path never authorizes an automatic repost, including a failed one.
  retryable: false;
  error?: string;
  externalPostId?: string;
  platformResults?: PlatformPublishResult[];
}

export function validatePublishAccounts(
  post: SocialPostRow,
  accounts: SocialAccountRef[],
  now = Date.now(),
): SocialAccountTarget[] {
  const platforms = post.target_platforms;
  const targets = post.target_accounts;
  if (
    !Array.isArray(platforms) || !platforms.length ||
    new Set(platforms).size !== platforms.length ||
    !Array.isArray(targets) || targets.length !== platforms.length
  ) {
    throw new PublishNotStartedError(
      "Destinations de publication non vérifiées. Préparez une nouvelle publication.",
    );
  }
  if (platforms.includes("twitter")) {
    // No server-side funding reservation exists in this repository. X can
    // auto-top-up a provider balance; a client flag is not a spending permit.
    throw new PublishNotStartedError(
      "La publication sur X attend un financement vérifié côté serveur. Choisissez les autres réseaux.",
    );
  }
  const seen = new Set<string>();
  for (const target of targets) {
    if (
      !target || !platforms.includes(target.platform) ||
      seen.has(target.platform) ||
      typeof target.zernio_account_id !== "string" || !target.zernio_account_id ||
      typeof target.zernio_profile_id !== "string" || !target.zernio_profile_id
    ) {
      throw new PublishNotStartedError("Destination de publication invalide.");
    }
    seen.add(target.platform);
    const matches = accounts.filter((account) =>
      account.user_id === post.user_id && account.platform === target.platform &&
      account.zernio_account_id === target.zernio_account_id &&
      account.zernio_profile_id === target.zernio_profile_id &&
      account.is_active === true
    );
    const verifiedAt = matches.length === 1 && matches[0].publishing_verified_at
      ? Date.parse(matches[0].publishing_verified_at)
      : Number.NaN;
    if (!Number.isFinite(verifiedAt) || verifiedAt > now) {
      throw new PublishNotStartedError(
        "Un compte ciblé est déconnecté, a changé ou n'a pas encore été vérifié côté serveur.",
      );
    }
  }
  return targets;
}

export async function executeSocialPublish(
  post: SocialPostRow,
  deps: PublishDeps,
): Promise<PublishOutcome> {
  const unconfirmed = async (
    message: string,
    result?: ProviderPublishResult,
  ): Promise<PublishOutcome> => {
    try {
      await deps.markPublishAnomaly(post, message, result);
    } catch {
      // The durable pre-send claim remains publishing. The consumer must
      // never turn that state back into scheduled, even if this write fails.
      console.error("[social-publish] Could not persist uncertain outcome", post.id);
    }
    return {
      postId: post.id,
      status: "publish_unconfirmed",
      retryable: false,
      error: message,
      externalPostId: result?.externalPostId,
      platformResults: result?.platformResults,
    };
  };

  const failedBeforeSend = async (message: string): Promise<PublishOutcome> => {
    try {
      await deps.markFailed(post, message);
    } catch {
      return unconfirmed("Publication non envoyée ; enregistrement de l'échec non confirmé.");
    }
    return { postId: post.id, status: "failed", retryable: false, error: message };
  };

  let targets: SocialAccountTarget[];
  try {
    const accounts = await deps.fetchAccounts(post.user_id, post.target_platforms);
    targets = validatePublishAccounts(post, accounts, deps.now?.() ?? Date.now());
  } catch (error) {
    return failedBeforeSend(
      error instanceof PublishNotStartedError
        ? error.message
        : "Vérification des comptes impossible ; aucune publication envoyée.",
    );
  }

  let result: ProviderPublishResult;
  try {
    result = await deps.publish({
      postId: post.id,
      text: post.content_text || "",
      mediaUrls: post.content_media_urls?.length ? post.content_media_urls : undefined,
      targets,
    });
  } catch (error) {
    if (error instanceof PublishNotStartedError) return failedBeforeSend(error.message);
    return unconfirmed(
      "Réponse du fournisseur non confirmée. Une publication peut avoir eu lieu ; aucun renvoi automatique.",
    );
  }

  try {
    await deps.markResult(post, result);
  } catch {
    return unconfirmed(
      "Résultat fournisseur reçu, mais son enregistrement n'est pas confirmé. Aucun renvoi automatique.",
      result,
    );
  }
  return {
    postId: post.id,
    status: result.status,
    retryable: false,
    error: result.error,
    externalPostId: result.externalPostId,
    platformResults: result.platformResults,
  };
}
