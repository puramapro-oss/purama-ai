import {
  executeSocialPublish,
  PublishNotStartedError,
  validatePublishAccounts,
  type PublishDeps,
} from "../_shared/social-publish-core.ts";
import {
  accountTargets,
  createPublishDeps,
  parseSocialPost,
  readPublishAccounts,
  rowObject,
  storedOutcome,
  type SocialDbClient,
  type StoredSocialPost,
} from "../_shared/social-publish-store.ts";
import { corsHeaders, SUPPORTED_PLATFORMS } from "../_shared/zernio.ts";

const MAX_BODY_BYTES = 64_000;
const CONTENT_TYPES = ["text", "image", "video", "carousel", "reel"];

interface PublishRequest {
  clientRequestId: string;
  content: string;
  mediaUrls: string[];
  contentType: string;
  agentName: string | null;
  platforms: string[] | null;
  scheduledAt: string | null;
  forceCaption: boolean;
}

class InvalidPublishRequest extends Error {}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function readBody(req: Request): Promise<unknown> {
  if (!req.body) throw new InvalidPublishRequest("Contenu de requête requis.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new InvalidPublishRequest("Requête de publication trop volumineuse.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InvalidPublishRequest("JSON de publication invalide.");
  }
}

function parseRequest(value: unknown, headerKey: string | null): PublishRequest {
  const body = rowObject(value);
  const allowed = new Set([
    "clientRequestId", "content", "mediaUrls", "contentType", "agentName",
    "platforms", "scheduledAt", "forceCaption",
  ]);
  if (!body || Object.keys(body).some((key) => !allowed.has(key))) {
    throw new InvalidPublishRequest("Paramètres de publication invalides.");
  }
  const key = headerKey ?? body.clientRequestId;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(key) ||
    (headerKey && body.clientRequestId !== undefined && body.clientRequestId !== headerKey)) {
    throw new InvalidPublishRequest("Une clé de demande stable est requise pour éviter les doublons.");
  }
  if (body.content !== undefined && typeof body.content !== "string") {
    throw new InvalidPublishRequest("Le texte de publication doit être une chaîne.");
  }
  const content = (body.content as string | undefined) ?? "";
  if (content.length > 20_000) throw new InvalidPublishRequest("Texte de publication trop long.");
  const mediaUrls = body.mediaUrls ?? [];
  if (!Array.isArray(mediaUrls) || mediaUrls.length > 20 || mediaUrls.some((item) =>
    typeof item !== "string" || item.length > 4096
  )) throw new InvalidPublishRequest("Liste de médias invalide.");
  for (const media of mediaUrls) {
    try {
      const url = new URL(media);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    } catch {
      throw new InvalidPublishRequest("Chaque média doit utiliser une URL HTTPS valide.");
    }
  }
  if (!content.trim() && !mediaUrls.length) throw new InvalidPublishRequest("Un texte ou un média est requis.");
  const contentType = body.contentType ?? "text";
  if (typeof contentType !== "string" || !CONTENT_TYPES.includes(contentType)) {
    throw new InvalidPublishRequest("Type de contenu invalide.");
  }
  if (body.agentName !== undefined && (typeof body.agentName !== "string" || body.agentName.length > 128)) {
    throw new InvalidPublishRequest("Nom d'agent invalide.");
  }
  let platforms: string[] | null = null;
  if (body.platforms !== undefined) {
    if (!Array.isArray(body.platforms) || !body.platforms.length ||
      body.platforms.length > SUPPORTED_PLATFORMS.length ||
      body.platforms.some((item) => !SUPPORTED_PLATFORMS.includes(item)) ||
      new Set(body.platforms).size !== body.platforms.length) {
      throw new InvalidPublishRequest("Plateformes ciblées invalides.");
    }
    platforms = [...body.platforms].sort();
  }
  let scheduledAt: string | null = null;
  if (body.scheduledAt !== undefined) {
    if (typeof body.scheduledAt !== "string" ||
      !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(body.scheduledAt) ||
      !Number.isFinite(Date.parse(body.scheduledAt))) {
      throw new InvalidPublishRequest("La date doit inclure un fuseau horaire valide.");
    }
    scheduledAt = new Date(body.scheduledAt).toISOString();
  }
  if (body.forceCaption !== undefined && typeof body.forceCaption !== "boolean") {
    throw new InvalidPublishRequest("Option de légende invalide.");
  }
  return {
    clientRequestId: key,
    content,
    mediaUrls,
    contentType,
    agentName: (body.agentName as string | undefined) ?? null,
    platforms,
    scheduledAt,
    forceCaption: body.forceCaption === true,
  };
}

export async function hashPublishRequest(body: PublishRequest): Promise<string> {
  const { clientRequestId: _key, ...intent } = body;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(intent)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function existingRequest(db: SocialDbClient, userId: string, key: string): Promise<StoredSocialPost | null> {
  const { data, error } = await db.from("social_posts")
    .select("*").eq("user_id", userId).eq("client_request_id", key).maybeSingle();
  if (error) throw new Error("Could not read request identity");
  return data === null ? null : parseSocialPost(data);
}

function outcomeResponse(
  outcome: ReturnType<typeof storedOutcome>,
  body: PublishRequest,
  replayed = false,
): Response {
  const httpStatus = outcome.status === "publish_unconfirmed" || outcome.status === "scheduled"
    ? 202
    : outcome.status === "partial" ? 207 : 200;
  return response({
    success: outcome.status === "published" || outcome.status === "scheduled",
    post_id: outcome.postId,
    status: outcome.status,
    retryable: false,
    replayed,
    error: "error" in outcome ? outcome.error : undefined,
    platform_results: "platformResults" in outcome ? outcome.platformResults : undefined,
    caption_generated: false,
    caption_notice: body.forceCaption
      ? "Le texte préparé est conservé ; aucune génération payante n'est déclenchée ici."
      : undefined,
  }, httpStatus);
}

export interface ImmediatePublishDeps {
  db: SocialDbClient;
  authenticate(token: string): Promise<string | null>;
  publish: PublishDeps["publish"];
  now?: () => number;
}

export async function handleSocialPublishRequest(req: Request, deps: ImmediatePublishDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") return response({ error: "Method not allowed" }, 405);
  const token = /^Bearer ([^\s]+)$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!token) return response({ error: "Unauthorized" }, 401);
  try {
    const userId = await deps.authenticate(token);
    if (!userId) return response({ error: "Unauthorized" }, 401);
    if (req.method === "GET") {
      const { data, error } = await deps.db.from("social_posts")
        .select("id,content_text,target_platforms,status,scheduled_at,published_at,created_at,error_message,platform_results")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(50);
      if (error || !Array.isArray(data)) throw new Error("Could not read publication history");
      return response(data);
    }
    const body = parseRequest(await readBody(req), req.headers.get("Idempotency-Key"));
    const requestHash = await hashPublishRequest(body);
    const replay = (post: StoredSocialPost) => post.request_hash === requestHash
      ? outcomeResponse(storedOutcome(post), body, true)
      : response({ error: "Cette clé de demande correspond déjà à un autre contenu." }, 409);
    const existing = await existingRequest(deps.db, userId, body.clientRequestId);
    if (existing) return replay(existing);

    const accounts = await readPublishAccounts(deps.db, userId, body.platforms ?? undefined);
    const targets = accountTargets(accounts);
    const platforms = body.platforms ?? targets.map((target) => target.platform);
    const now = deps.now?.() ?? Date.now();
    validatePublishAccounts({
      id: "preflight", user_id: userId, content_text: body.content,
      content_media_urls: body.mediaUrls, target_platforms: platforms, target_accounts: targets,
    }, accounts, now);
    const future = body.scheduledAt !== null && Date.parse(body.scheduledAt) > now;
    const { data, error } = await deps.db.from("social_posts").insert({
      user_id: userId,
      client_request_id: body.clientRequestId,
      request_hash: requestHash,
      content_text: body.content,
      content_media_urls: body.mediaUrls,
      content_type: body.contentType,
      agent_name: body.agentName,
      target_platforms: platforms,
      target_accounts: targets,
      status: future ? "scheduled" : "publishing",
      scheduled_at: body.scheduledAt,
      ai_generated: false,
      ai_caption: null,
      ai_hashtags: [],
    }).select("*").single();
    if (error?.code === "23505") {
      const winner = await existingRequest(deps.db, userId, body.clientRequestId);
      if (!winner) throw new Error("Concurrent request could not be read");
      return replay(winner);
    }
    if (error) throw new Error("Request insertion was not confirmed");
    const post = parseSocialPost(data);
    if (post.user_id !== userId || post.client_request_id !== body.clientRequestId || post.request_hash !== requestHash) {
      throw new Error("Unexpected inserted request identity");
    }
    if (future) return outcomeResponse(storedOutcome(post), body);
    const outcome = await executeSocialPublish(post, createPublishDeps(deps.db, deps.publish, deps.now));
    return outcomeResponse(outcome, body);
  } catch (error) {
    if (error instanceof InvalidPublishRequest) return response({ error: error.message }, 400);
    if (error instanceof PublishNotStartedError) return response({ error: error.message, sent: false }, 422);
    if (req.method === "GET") return response({ error: "Historique des publications indisponible." }, 503);
    console.error("[social-publish] Request could not be completed; reuse the same request key");
    return response({
      error: "Enregistrement non confirmé. Conservez la même clé de demande pour vérifier son résultat.",
      retryable: false,
    }, 503);
  }
}
