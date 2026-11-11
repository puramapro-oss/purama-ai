// Shared Zernio transport. A timeout never authorizes a second side effect.
import {
  PublishNotStartedError,
  type PlatformPublishResult,
  type ProviderPublishResult,
  type SocialAccountTarget,
} from "./social-publish-core.ts";

export type Platform =
  | "youtube" | "tiktok" | "instagram" | "facebook" | "threads"
  | "linkedin" | "twitter" | "bluesky" | "pinterest" | "reddit"
  | "telegram" | "whatsapp" | "snapchat" | "google_business";

export const SUPPORTED_PLATFORMS: Platform[] = [
  "youtube", "tiktok", "instagram", "facebook", "threads", "linkedin",
  "twitter", "bluesky", "pinterest", "reddit", "telegram", "whatsapp",
  "snapchat", "google_business",
];

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, idempotency-key, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

export interface ZernioTransportOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const ZERNIO_TIMEOUT_MS = 30_000;
const ZERNIO_CANONICAL_BASE_URL = "https://zernio.com/api/v1";
const MAX_RESPONSE_BYTES = 1_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0 && value.length <= 256) return value;
  const obj = record(value);
  if (obj) {
    const id = obj._id ?? obj.id;
    if (typeof id === "string" && id.length > 0 && id.length <= 256) return id;
  }
  return undefined;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty provider response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Provider response is too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function requestZernioJson(
  path: string,
  options: RequestInit,
  transport: ZernioTransportOptions = {},
  acceptNotFound = false,
): Promise<{ httpStatus: number; data: unknown }> {
  const apiKey = transport.apiKey ?? Deno.env.get("ZERNIO_API_KEY") ?? "";
  if (!apiKey) throw new PublishNotStartedError("Connexion au fournisseur non configurée.");
  let base: string;
  if (transport.baseUrl !== undefined) {
    // Alternate origins are test fixtures and require an injected transport.
    if (!transport.fetchImpl) throw new PublishNotStartedError("Transport fournisseur de test incomplet.");
    base = transport.baseUrl;
  } else {
    const configuredBase = Deno.env.get("ZERNIO_BASE_URL");
    if (configuredBase !== undefined && configuredBase !== ZERNIO_CANONICAL_BASE_URL) {
      throw new PublishNotStartedError("La vérification et la publication doivent utiliser le même fournisseur Zernio.");
    }
    base = ZERNIO_CANONICAL_BASE_URL;
  }
  let url: URL;
  try { url = new URL(base); } catch {
    throw new PublishNotStartedError("Configuration du fournisseur invalide.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new PublishNotStartedError("Configuration du fournisseur invalide.");
  }
  const timeoutMs = transport.timeoutMs ?? ZERNIO_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ZERNIO_TIMEOUT_MS) {
    throw new PublishNotStartedError("Délai fournisseur invalide.");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Provider outcome unknown after timeout"));
    }, timeoutMs);
  });
  const request = async () => {
    const res = await (transport.fetchImpl ?? fetch)(
      base.replace(/\/$/, "") + path,
      {
        ...options,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      },
    );
    if (acceptNotFound && (res.status === 200 || res.status === 404)) {
      // Account DELETE is confirmed by these documented HTTP statuses; a
      // missing JSON body must not turn a confirmed disconnect into a retry.
      await res.body?.cancel();
      return { httpStatus: res.status, data: {} };
    }
    if (!res.ok) {
      // Never disclose the upstream body or retry a failed write implicitly.
      await res.body?.cancel();
      throw new Error("Provider request not confirmed (HTTP " + res.status + ")");
    }
    return { httpStatus: res.status, data: await readBoundedJson(res) };
  };
  try {
    return await Promise.race([request(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function normalizeZernioPublishResult(
  value: unknown,
  targets: SocialAccountTarget[],
  httpStatus: number,
): ProviderPublishResult {
  const response = record(value) ?? {};
  const post = record(response.post);
  const externalPostId = identifier(post?._id ?? post?.id);
  const source = post && Array.isArray(post.platforms) ? post.platforms : [];
  const platformResults: PlatformPublishResult[] = source.flatMap((item) => {
    const entry = record(item);
    if (!entry || typeof entry.platform !== "string") return [];
    const accountId = identifier(entry.accountId);
    if (!accountId || typeof entry.status !== "string") return [];
    return [{
      platform: entry.platform === "googlebusiness" ? "google_business" : entry.platform,
      accountId,
      status: entry.status,
      postId: identifier(entry.platformPostId),
      postUrl: typeof entry.platformPostUrl === "string" ? entry.platformPostUrl : undefined,
    }];
  });
  const base = { externalPostId, platformResults, response };
  const completeTargets = targets.length > 0 &&
    source.length === targets.length && platformResults.length === targets.length &&
    targets.every((target) => platformResults.filter((item) =>
      item.platform === target.platform && item.accountId === target.zernio_account_id
    ).length === 1);
  if (!externalPostId || !completeTargets || ![200, 201, 207].includes(httpStatus)) {
    return {
      ...base,
      status: "publish_unconfirmed",
      error: "Le fournisseur n'a pas confirmé le résultat pour toutes les destinations.",
    };
  }
  const published = platformResults.filter((item) => item.status === "published").length;
  const failed = platformResults.filter((item) => item.status === "failed").length;
  if (post?.status === "published" && published === targets.length && httpStatus !== 207) {
    return { ...base, status: "published" };
  }
  if (post?.status === "partial" && published > 0 && published < targets.length) {
    return { ...base, status: "partial", error: "Certaines destinations seulement sont publiées." };
  }
  if (post?.status === "failed" && failed === targets.length) {
    return { ...base, status: "failed", error: "Le fournisseur a confirmé l'échec de cette publication." };
  }
  return {
    ...base,
    status: "publish_unconfirmed",
    error: "Publication en attente ou résultat fournisseur incomplet ; aucun renvoi automatique.",
  };
}

/**
 * Contract checked against the official Zernio SDK:
 * https://github.com/zernio-dev/zernio-dotnet/blob/main/docs/CreatePostRequest.md
 * https://github.com/zernio-dev/zernio-dotnet/blob/main/docs/PostsApi.md
 * Idempotency-Key protects matching provider retries for 24 hours only.
 * This application does not automatically repost uncertain requests.
 */
export async function publishPost(params: {
  postId: string;
  text?: string;
  mediaUrls?: string[];
  targets: SocialAccountTarget[];
}, transport: ZernioTransportOptions = {}): Promise<ProviderPublishResult> {
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(params.postId) ||
    !params.targets.length || params.targets.some((target) =>
      !target.zernio_account_id || !SUPPORTED_PLATFORMS.includes(target.platform as Platform)
    )
  ) throw new PublishNotStartedError("Paramètres de publication invalides.");
  // Keep this second check at the transport boundary as well as in the core.
  if (params.targets.some((target) => target.platform === "twitter")) {
    throw new PublishNotStartedError("Financement de publication X non vérifié côté serveur.");
  }
  const mediaItems = (params.mediaUrls ?? []).map((value) => {
    let url: URL;
    try { url = new URL(value); } catch {
      throw new PublishNotStartedError("Les médias doivent utiliser des URL HTTPS publiques.");
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new PublishNotStartedError("Les médias doivent utiliser des URL HTTPS publiques.");
    }
    return { url: value };
  });
  const result = await requestZernioJson("/posts", {
    method: "POST",
    headers: { "Idempotency-Key": "purama-social-" + params.postId },
    body: JSON.stringify({
      content: params.text ?? "",
      mediaItems,
      platforms: params.targets.map((target) => ({
        platform: target.platform === "google_business" ? "googlebusiness" : target.platform,
        accountId: target.zernio_account_id,
      })),
      publishNow: true,
      metadata: { puramaPostId: params.postId },
    }),
  }, transport);
  return normalizeZernioPublishResult(result.data, params.targets, result.httpStatus);
}

/** Retrieve a previously recorded provider ID; this never creates a post. */
export async function inspectPost(
  externalPostId: string,
  targets: SocialAccountTarget[],
  transport: ZernioTransportOptions = {},
): Promise<ProviderPublishResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(externalPostId)) {
    throw new PublishNotStartedError("Identifiant de publication invalide.");
  }
  const result = await requestZernioJson("/posts/" + encodeURIComponent(externalPostId), {
    method: "GET",
  }, transport);
  return normalizeZernioPublishResult(result.data, targets, result.httpStatus);
}

/** Disconnect one account; never delete its entire provider profile. */
export async function disconnectConnectedAccount(
  accountId: string,
  transport: ZernioTransportOptions = {},
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) {
    throw new PublishNotStartedError("Identifiant de compte invalide.");
  }
  const result = await requestZernioJson(
    "/accounts/" + encodeURIComponent(accountId),
    { method: "DELETE" },
    transport,
    true,
  );
  if (result.httpStatus !== 200 && result.httpStatus !== 404) {
    throw new Error("Déconnexion fournisseur non confirmée.");
  }
}
