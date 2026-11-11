import type {
  ProviderPublishResult,
  PublishDeps,
  PublishOutcome,
  PublishStatus,
  SocialAccountRef,
  SocialAccountTarget,
  SocialPostRow,
} from "./social-publish-core.ts";

export interface SocialDbResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

// The subset of the PostgREST builder used by this flow. Keeping the boundary
// explicit allows tests to run with all network permissions denied.
export interface SocialQuery extends PromiseLike<SocialDbResult> {
  select(columns?: string): SocialQuery;
  insert(values: Record<string, unknown>): SocialQuery;
  update(values: Record<string, unknown>): SocialQuery;
  eq(column: string, value: unknown): SocialQuery;
  in(column: string, values: unknown[]): SocialQuery;
  is(column: string, value: null): SocialQuery;
  not(column: string, operator: "is", value: null): SocialQuery;
  lte(column: string, value: string): SocialQuery;
  limit(value: number): SocialQuery;
  order(column: string, options?: { ascending: boolean }): SocialQuery;
  single(): SocialQuery;
  maybeSingle(): SocialQuery;
}

export interface SocialDbClient {
  from(table: string): SocialQuery;
}

export interface StoredSocialPost extends SocialPostRow {
  status: PublishStatus | "draft" | "scheduled" | "publishing";
  client_request_id: string | null;
  request_hash: string | null;
  scheduled_at: string | null;
  updated_at: string;
  error_message: string | null;
  zernio_post_id: string | null;
  platform_results: unknown;
}

export function rowObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseSocialPost(value: unknown): StoredSocialPost {
  const row = rowObject(value);
  if (!row || typeof row.id !== "string" || typeof row.user_id !== "string" ||
    typeof row.status !== "string" || !Array.isArray(row.target_platforms)) {
    throw new Error("Invalid social post returned by database");
  }
  return row as unknown as StoredSocialPost;
}

export async function readPublishAccounts(
  db: SocialDbClient,
  userId: string,
  platforms?: string[],
): Promise<SocialAccountRef[]> {
  let query = db.from("social_accounts")
    .select("user_id,platform,zernio_account_id,zernio_profile_id,is_active,publishing_verified_at")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (platforms) query = query.in("platform", platforms);
  const { data, error } = await query;
  if (error || !Array.isArray(data)) throw new Error("Could not read connected accounts");
  return data.map((value) => {
    const row = rowObject(value);
    if (!row || row.user_id !== userId || typeof row.platform !== "string" ||
      typeof row.zernio_account_id !== "string" || typeof row.zernio_profile_id !== "string") {
      throw new Error("Invalid connected account returned by database");
    }
    return {
      user_id: userId,
      platform: row.platform,
      zernio_account_id: row.zernio_account_id,
      zernio_profile_id: row.zernio_profile_id,
      is_active: row.is_active === true,
      publishing_verified_at: typeof row.publishing_verified_at === "string"
        ? row.publishing_verified_at
        : null,
    };
  });
}

export function accountTargets(accounts: SocialAccountRef[]): SocialAccountTarget[] {
  return accounts.map(({ platform, zernio_account_id, zernio_profile_id }) => ({
    platform,
    zernio_account_id,
    zernio_profile_id,
  })).sort((a, b) => a.platform.localeCompare(b.platform));
}

export async function updateClaimedPost(
  db: SocialDbClient,
  post: SocialPostRow,
  values: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await db.from("social_posts")
    .update(values)
    .eq("id", post.id)
    .eq("user_id", post.user_id)
    .eq("status", "publishing")
    .select("id");
  if (error || !Array.isArray(data) || data.length !== 1 || rowObject(data[0])?.id !== post.id) {
    throw new Error("Social post state write was not confirmed");
  }
}

export function providerValues(result: ProviderPublishResult): Record<string, unknown> {
  return {
    status: result.status,
    published_at: result.status === "published" ? new Date().toISOString() : null,
    zernio_post_id: result.externalPostId ?? null,
    zernio_response: result.response,
    platform_results: result.platformResults,
    error_message: result.error ?? null,
  };
}

export function createPublishDeps(
  db: SocialDbClient,
  publish: PublishDeps["publish"],
  now?: () => number,
): PublishDeps {
  return {
    now,
    fetchAccounts: (userId, platforms) => readPublishAccounts(db, userId, platforms),
    publish,
    markResult: (post, result) => updateClaimedPost(db, post, providerValues(result)),
    markFailed: (post, message) => updateClaimedPost(db, post, {
      status: "failed",
      error_message: message,
    }),
    markPublishAnomaly: (post, message, result) => updateClaimedPost(db, post, {
      ...(result ? providerValues(result) : {}),
      status: "publish_unconfirmed",
      error_message: message,
      published_at: null,
    }),
  };
}

export function storedOutcome(post: StoredSocialPost): PublishOutcome | { postId: string; status: "scheduled"; retryable: false } {
  if (post.status === "scheduled") return { postId: post.id, status: "scheduled", retryable: false };
  const status = ["published", "partial", "failed"].includes(post.status)
    ? post.status as PublishStatus
    : "publish_unconfirmed";
  return {
    postId: post.id,
    status,
    retryable: false,
    error: post.error_message ?? (status === "publish_unconfirmed"
      ? "Demande déjà enregistrée ; résultat à confirmer, sans nouveau renvoi."
      : undefined),
    externalPostId: post.zernio_post_id ?? undefined,
    platformResults: Array.isArray(post.platform_results) ? post.platform_results : undefined,
  };
}
