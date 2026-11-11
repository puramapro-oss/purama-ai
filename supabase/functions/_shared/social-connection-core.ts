import { createSocialCallbackState, hashSocialCallbackState, isOAuthSocialPlatform,
  isSocialUserId, isZernioId, verifySocialCallbackState, type SocialCallbackClaims } from "./social-state.ts";
import { normalizeSocialPlatform, SocialProviderError, type SocialConnectionProvider,
  type VerifiedSocialAccount } from "./social-connection-provider.ts";
import { resolveSocialSchema } from "./social-db.ts";

export class SocialConnectionError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code); this.name = "SocialConnectionError";
  }
}

export interface SocialProfileBinding {
  id: string; userId: string; profileId: string | null;
  externalId: string; profileName: string;
  creationStatus: "pending" | "creating" | "uncertain" | "ready";
}
export interface SocialConnectionIntent extends SocialCallbackClaims {
  stateHash: string; status: "pending" | "bound" | "cancelled" | "superseded"; accountId: string | null;
}
export interface SocialConnectionStore {
  getOrCreateProfile(userId: string): Promise<SocialProfileBinding>;
  claimProfileCreation(bindingId: string): Promise<boolean>;
  recordProfileFailure(bindingId: string, uncertain: boolean): Promise<void>;
  finishProfile(bindingId: string, profileId: string): Promise<void>;
  beginIntent(intent: SocialCallbackClaims & { stateHash: string }): Promise<void>;
  readIntent(stateHash: string): Promise<SocialConnectionIntent | null>;
  cancelIntent(stateHash: string): Promise<boolean>;
  finishIntent(intent: SocialConnectionIntent, account: VerifiedSocialAccount): Promise<"bound" | "already_processed">;
}
export interface SocialConnectionDependencies {
  store: SocialConnectionStore; provider: SocialConnectionProvider; stateSecret: string; now?: () => number;
}

export function socialDatabaseSchema(value: string | undefined): "public" | "purama_ai" {
  try { return resolveSocialSchema(value); }
  catch { throw new SocialConnectionError("social_schema_not_configured", 503); }
}

async function ensureProfile(userId: string, deps: SocialConnectionDependencies): Promise<string> {
  const binding = await deps.store.getOrCreateProfile(userId);
  if (binding.userId !== userId || !isSocialUserId(binding.id)) throw new SocialConnectionError("profile_binding_invalid", 503);
  if (binding.creationStatus === "ready") {
    if (!isZernioId(binding.profileId)) throw new SocialConnectionError("profile_binding_invalid", 503);
    return binding.profileId;
  }
  // Names and externalId are server-generated, stable and reconciled before any
  // create. No second POST after an uncertain outcome or a concurrent claim.
  const existing = await deps.provider.findProfiles({ externalId: binding.externalId, name: binding.profileName });
  if (existing.length === 1) {
    await deps.store.finishProfile(binding.id, existing[0].profileId);
    return existing[0].profileId;
  }
  if (existing.length !== 0) throw new SocialConnectionError("profile_binding_ambiguous", 503);
  if (binding.creationStatus !== "pending" || !await deps.store.claimProfileCreation(binding.id)) {
    throw new SocialConnectionError("profile_creation_reconciliation_required", 503);
  }
  try {
    const created = await deps.provider.createProfile({
      externalId: binding.externalId, name: binding.profileName, idempotencyKey: binding.id,
    });
    await deps.store.finishProfile(binding.id, created.profileId);
    return created.profileId;
  } catch (error) {
    await deps.store.recordProfileFailure(binding.id, !(error instanceof SocialProviderError) || error.uncertain);
    throw error;
  }
}

export async function beginSocialConnection(input: {
  userId: string; platform: unknown; callbackBaseUrl: string;
}, deps: SocialConnectionDependencies): Promise<{ url: string; authUrl: string; expiresAt: string }> {
  if (!isSocialUserId(input.userId)) throw new SocialConnectionError("unauthorized", 401);
  if (!isOAuthSocialPlatform(input.platform)) throw new SocialConnectionError("unsupported_oauth_platform");
  if (deps.stateSecret.length < 32) throw new SocialConnectionError("social_state_not_configured", 503);
  const callback = new URL(input.callbackBaseUrl);
  if (callback.protocol !== "https:" || callback.username || callback.password || callback.search || callback.hash) {
    throw new SocialConnectionError("invalid_callback_configuration", 503);
  }
  const profileId = await ensureProfile(input.userId, deps);
  const issued = await createSocialCallbackState({ userId: input.userId, platform: input.platform, profileId },
    deps.stateSecret, deps.now?.() ?? Date.now());
  await deps.store.beginIntent({ ...issued.claims, stateHash: issued.stateHash });
  callback.searchParams.set("state", issued.state);
  const authUrl = await deps.provider.getConnectUrl({ platform: input.platform, profileId, callbackUrl: callback.href });
  return { url: authUrl, authUrl, expiresAt: new Date(issued.claims.expiresAt * 1000).toISOString() };
}

function oneParameter(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new SocialConnectionError("ambiguous_callback_parameters");
  return values[0] ?? null;
}

export async function finishSocialConnection(url: URL, deps: SocialConnectionDependencies): Promise<{
  status: "bound" | "already_processed" | "cancelled"; platform: string;
}> {
  const state = oneParameter(url, "state");
  const claims = await verifySocialCallbackState(state, deps.stateSecret, deps.now?.() ?? Date.now());
  if (!state || !claims) throw new SocialConnectionError("invalid_or_expired_social_state");
  const stateHash = await hashSocialCallbackState(state);
  const intent = await deps.store.readIntent(stateHash);
  if (!intent || intent.userId !== claims.userId || intent.profileId !== claims.profileId ||
    intent.platform !== claims.platform || intent.nonce !== claims.nonce ||
    intent.expiresAt !== claims.expiresAt || intent.issuedAt !== claims.issuedAt) {
    throw new SocialConnectionError("social_state_not_registered");
  }
  if (intent.status === "cancelled" || intent.status === "superseded") throw new SocialConnectionError("social_state_already_closed");
  if (oneParameter(url, "error")) {
    if (intent.status !== "pending") throw new SocialConnectionError("social_state_already_closed");
    if (!await deps.store.cancelIntent(stateHash)) throw new SocialConnectionError("social_state_already_closed");
    return { status: "cancelled", platform: claims.platform };
  }
  const accountId = oneParameter(url, "accountId");
  const profileId = oneParameter(url, "profileId");
  const connected = oneParameter(url, "connected");
  if (!isZernioId(accountId) || profileId !== claims.profileId ||
    !connected || normalizeSocialPlatform(connected) !== claims.platform) throw new SocialConnectionError("callback_binding_mismatch");
  if (intent.status === "bound") {
    if (intent.accountId !== accountId) throw new SocialConnectionError("social_state_replay_conflict");
    // A replay must never reactivate a subsequently disconnected account.
    return { status: "already_processed", platform: claims.platform };
  }
  const verified = await deps.provider.verifyAccount({ profileId, accountId, platform: claims.platform });
  if (verified.accountId !== accountId || verified.profileId !== profileId ||
    verified.platform !== claims.platform || !verified.isActive) throw new SocialConnectionError("provider_account_not_publishable", 409);
  return { status: await deps.store.finishIntent(intent, verified), platform: claims.platform };
}

export function socialErrorResponse(error: unknown): { code: string; status: number; message: string } {
  if (error instanceof SocialConnectionError) return {
    code: error.code, status: error.status, message: "La connexion n’a pas été confirmée. Réessayez depuis les réglages sociaux.",
  };
  if (error instanceof SocialProviderError) return {
    code: error.code, status: error.code === "provider_billing_required" ? 402 : 503,
    message: error.code === "provider_billing_required"
      ? "Le fournisseur demande de vérifier les conditions de facturation du compte PURAMA."
      : "Le fournisseur n’a pas confirmé la connexion. Aucune publication n’est autorisée pour ce compte.",
  };
  return { code: "social_connection_unavailable", status: 503, message: "La connexion sociale est temporairement indisponible." };
}

export interface SocialConnectionHttpOptions {
  appUrl: string; callbackBaseUrl: string; allowedOrigin?: string; stateSecret: string;
  getUserId(request: Request): Promise<string | null>;
  getDependencies(): SocialConnectionDependencies;
}
function trustedAppOrigin(options: SocialConnectionHttpOptions): string {
  const url = new URL(options.appUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new SocialConnectionError("invalid_app_configuration", 503);
  return url.origin;
}
function headersFor(options: SocialConnectionHttpOptions): Record<string, string> {
  const origin = options.allowedOrigin ?? trustedAppOrigin(options);
  if (origin === "*" || new URL(origin).origin !== origin || !origin.startsWith("https://")) {
    throw new SocialConnectionError("invalid_cors_configuration", 503);
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", Vary: "Origin",
  };
}
export function createSocialConnectHandler(options: SocialConnectionHttpOptions) {
  return async (request: Request): Promise<Response> => {
    let headers: Record<string, string> = { "Cache-Control": "no-store" };
    try {
      headers = headersFor(options);
      const origin = request.headers.get("Origin");
      if (origin && origin !== headers["Access-Control-Allow-Origin"]) throw new SocialConnectionError("origin_not_allowed", 403);
      if (request.method === "OPTIONS") return new Response(null, { headers });
      if (request.method !== "POST") throw new SocialConnectionError("method_not_allowed", 405);
      const userId = await options.getUserId(request);
      if (!userId) throw new SocialConnectionError("unauthorized", 401);
      const text = await request.text();
      if (text.length > 4096) throw new SocialConnectionError("request_too_large", 413);
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new SocialConnectionError("invalid_json"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new SocialConnectionError("invalid_request");
      const platform = (body as Record<string, unknown>).platform;
      if (!isOAuthSocialPlatform(platform)) throw new SocialConnectionError("unsupported_oauth_platform");
      const result = await beginSocialConnection({ userId, platform, callbackBaseUrl: options.callbackBaseUrl }, options.getDependencies());
      return new Response(JSON.stringify(result), { headers: { ...headers, "Content-Type": "application/json" } });
    } catch (error) {
      const result = socialErrorResponse(error);
      return new Response(JSON.stringify({ error: result.message, code: result.code }), {
        status: result.status, headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  };
}
export function createSocialCallbackHandler(options: SocialConnectionHttpOptions) {
  return async (request: Request): Promise<Response> => {
    let destination: URL, headers: Record<string, string>;
    try {
      destination = new URL("/dashboard/social", trustedAppOrigin(options)); headers = headersFor(options);
    } catch { return new Response("Configuration sociale indisponible", { status: 503 }); }
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method !== "GET") return new Response("Méthode non autorisée", { status: 405, headers });
    try {
      const url = new URL(request.url);
      // Do not construct a privileged database client before the state is valid.
      if (!await verifySocialCallbackState(oneParameter(url, "state"), options.stateSecret)) {
        throw new SocialConnectionError("invalid_or_expired_social_state");
      }
      const result = await finishSocialConnection(url, options.getDependencies());
      if (result.status === "bound") destination.searchParams.set("connected", result.platform);
      else destination.searchParams.set("status", result.status);
    } catch (error) { destination.searchParams.set("error", socialErrorResponse(error).code); }
    return new Response(null, { status: 302, headers: { ...headers, Location: destination.href } });
  };
}
