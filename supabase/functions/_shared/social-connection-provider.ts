// Zernio's documented account/profile contracts. No API call occurs at import.
// https://docs.zernio.com/guides/connecting-accounts
// https://github.com/zernio-dev/zernio-dotnet/blob/main/docs/ProfilesApi.md
// https://github.com/zernio-dev/zernio-dotnet/blob/main/docs/AccountsApi.md
import { isOAuthSocialPlatform, isZernioId } from "./social-state.ts";

export interface VerifiedSocialAccount {
  accountId: string;
  profileId: string;
  platform: string;
  accountName: string;
  accountUsername: string;
  isActive: boolean;
}

export interface ZernioSocialProfile {
  profileId: string;
  externalId: string;
  name: string;
}

export class SocialProviderError extends Error {
  constructor(public readonly code: string, public readonly uncertain = false) {
    super(code);
    this.name = "SocialProviderError";
  }
}

export function normalizeSocialPlatform(value: string): string {
  return value === "googlebusiness" ? "google_business" : value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SocialProviderError("provider_response_invalid", true);
  }
  return value as Record<string, unknown>;
}

function profile(value: unknown): ZernioSocialProfile {
  const row = object(value);
  if (!isZernioId(row._id) || typeof row.name !== "string" ||
    typeof row.externalId !== "string") {
    throw new SocialProviderError("provider_profile_invalid", true);
  }
  return { profileId: row._id, name: row.name, externalId: row.externalId };
}

function account(value: unknown, expectedProfile: string): VerifiedSocialAccount {
  const row = object(value);
  const profileValue = typeof row.profileId === "string"
    ? row.profileId : object(row.profileId)._id;
  if (!isZernioId(row._id) || profileValue !== expectedProfile ||
    typeof row.platform !== "string" || typeof row.isActive !== "boolean") {
    throw new SocialProviderError("provider_account_binding_invalid");
  }
  if ((row.username != null && typeof row.username !== "string") ||
    (row.displayName != null && typeof row.displayName !== "string")) {
    throw new SocialProviderError("provider_account_invalid");
  }
  return {
    accountId: row._id, profileId: expectedProfile,
    platform: normalizeSocialPlatform(row.platform),
    accountName: String(row.displayName ?? "").slice(0, 200),
    accountUsername: String(row.username ?? "").slice(0, 200),
    isActive: row.isActive && row.needsReconnection !== true && row.enabled !== false,
  };
}

export interface SocialConnectionProvider {
  findProfiles(input: { externalId: string; name: string }): Promise<ZernioSocialProfile[]>;
  createProfile(input: { externalId: string; name: string; idempotencyKey: string }): Promise<ZernioSocialProfile>;
  getConnectUrl(input: { platform: string; profileId: string; callbackUrl: string }): Promise<string>;
  listAccounts(profileId: string): Promise<VerifiedSocialAccount[]>;
  verifyAccount(input: { profileId: string; accountId: string; platform: string }): Promise<VerifiedSocialAccount>;
}

export function createZernioConnectionProvider(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): SocialConnectionProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!options.apiKey || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new SocialProviderError("social_provider_not_configured");
  }

  async function request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(`https://zernio.com/api/v1${path}`, {
        ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${options.apiKey}`, Accept: "application/json",
          "Content-Type": "application/json", ...init.headers,
        },
      });
    } catch {
      throw new SocialProviderError("provider_request_uncertain", true);
    }
    if (!response.ok) {
      // Never reflect provider bodies, tokens, URLs or billing URLs to the browser.
      throw new SocialProviderError(
        response.status === 402 ? "provider_billing_required" : "provider_request_rejected",
        response.status >= 500 || response.status === 409,
      );
    }
    try {
      const text = await response.text();
      if (text.length > 1_048_576) throw new Error("response too large");
      const body = object(JSON.parse(text));
      if (path.startsWith("/accounts?") && response.headers.get("X-Result-Truncated")?.toLowerCase() === "true") {
        const pagination = object(body.pagination);
        if (typeof pagination.nextCursor !== "string" || !pagination.nextCursor) throw new Error("truncated accounts");
      }
      return body;
    } catch {
      throw new SocialProviderError("provider_response_invalid", true);
    }
  }

  async function listAccounts(profileId: string): Promise<VerifiedSocialAccount[]> {
    if (!isZernioId(profileId)) throw new SocialProviderError("invalid_provider_profile");
    const result: VerifiedSocialAccount[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      // The default API listing omits over-limit profiles. Absence is used for
      // disconnect reconciliation, so include disabled/over-limit accounts and
      // every ads row, without adding the shared sandbox outside this profile.
      const query = new URLSearchParams({ profileId, limit: "100", includeOverLimit: "true",
        excludeHidden: "false", adAccountRows: "true", includeSandbox: "false" });
      if (cursor) query.set("cursor", cursor);
      const body = await request(`/accounts?${query}`);
      if (!Array.isArray(body.accounts)) throw new SocialProviderError("provider_accounts_invalid");
      for (const item of body.accounts) {
        const parsed = account(item, profileId);
        if (ids.has(parsed.accountId)) throw new SocialProviderError("provider_accounts_ambiguous");
        ids.add(parsed.accountId);
        result.push(parsed);
      }
      // limit requests cursor paging; the documented final page explicitly
      // carries nextCursor:null. A missing page marker cannot prove absence.
      const pagination = object(body.pagination);
      const next = pagination.nextCursor;
      if (next === null) {
        if (body.warning ||
          (typeof pagination.total === "number" && pagination.total > result.length)) {
          throw new SocialProviderError("provider_accounts_incomplete");
        }
        return result;
      }
      if (typeof next !== "string" || !next || next.length > 2_000 || cursors.has(next)) {
        throw new SocialProviderError("provider_accounts_incomplete");
      }
      cursors.add(next);
      cursor = next;
    }
    throw new SocialProviderError("provider_accounts_incomplete");
  }

  return {
    async findProfiles({ externalId, name }) {
      const query = new URLSearchParams({ externalId, name, limit: "2", skip: "0", includeOverLimit: "true" });
      const body = await request(`/profiles?${query}`);
      if (!Array.isArray(body.profiles) || body.profiles.length > 1 ||
        (typeof body.total === "number" && body.total !== body.profiles.length)) {
        throw new SocialProviderError("provider_profiles_ambiguous");
      }
      return body.profiles.map((item) => {
        const parsed = profile(item);
        if (parsed.externalId !== externalId || parsed.name !== name) {
          throw new SocialProviderError("provider_profile_binding_invalid");
        }
        return parsed;
      });
    },
    async createProfile({ externalId, name, idempotencyKey }) {
      const body = await request("/profiles", {
        method: "POST", headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ name, externalId }),
      });
      const created = profile(body.profile);
      if (created.externalId !== externalId || created.name !== name) {
        throw new SocialProviderError("provider_profile_binding_invalid", true);
      }
      return created;
    },
    async getConnectUrl({ platform, profileId, callbackUrl }) {
      if (!isOAuthSocialPlatform(platform) || !isZernioId(profileId)) {
        throw new SocialProviderError("unsupported_oauth_platform");
      }
      const redirect = new URL(callbackUrl);
      if (redirect.protocol !== "https:" || redirect.username || redirect.password) {
        throw new SocialProviderError("invalid_callback_url");
      }
      const providerPlatform = platform === "google_business" ? "googlebusiness" : platform;
      const query = new URLSearchParams({ profileId, redirect_url: callbackUrl });
      const body = await request(`/connect/${providerPlatform}?${query}`);
      if (typeof body.authUrl !== "string") throw new SocialProviderError("provider_connect_url_invalid");
      let authUrl: URL;
      try { authUrl = new URL(body.authUrl); } catch { throw new SocialProviderError("provider_connect_url_invalid"); }
      if (authUrl.protocol !== "https:" || authUrl.username || authUrl.password) {
        throw new SocialProviderError("provider_connect_url_invalid");
      }
      return authUrl.href;
    },
    listAccounts,
    async verifyAccount({ profileId, accountId, platform }) {
      if (!isZernioId(accountId)) throw new SocialProviderError("invalid_provider_account");
      const matches = (await listAccounts(profileId)).filter((item) =>
        item.accountId === accountId && item.platform === normalizeSocialPlatform(platform)
      );
      if (matches.length !== 1) throw new SocialProviderError("provider_account_binding_invalid");
      return matches[0];
    },
  };
}
