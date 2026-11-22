import { supabase } from "../db/supabase.js";
import type { ToolDefinition, ToolExecutionContext } from "../engine/types.js";
import { createProviderDeadline } from "./provider-http.js";

type SocialSchema = "public" | "purama_ai";
type Resource = "accounts" | "posts";
const PLATFORMS = [
  "youtube", "tiktok", "instagram", "facebook", "threads", "linkedin", "twitter",
  "bluesky", "pinterest", "reddit", "telegram", "whatsapp", "snapchat", "google_business",
] as const;
type Platform = typeof PLATFORMS[number];
const POST_STATUSES = ["draft", "scheduled", "publishing", "published", "partial", "failed", "publish_unconfirmed"] as const;
type PostStatus = typeof POST_STATUSES[number];
const ACCOUNT_COLUMNS = "id,user_id,platform,is_active,connected_at,publishing_verified_at,disconnect_pending";
const POST_COLUMNS = "id,user_id,status,target_platforms,scheduled_at,published_at,created_at,updated_at,zernio_post_id";
const UNAVAILABLE = "Lecture de l’état social indisponible.";
const INVALID = "Paramètres de lecture sociale invalides.";
const FORBIDDEN = "Lecture sociale non autorisée.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SocialStatusParams {
  resource: Resource;
  limit?: number;
  afterId?: string;
}

export interface SocialAccountMetadata {
  accountId: string;
  platform: Platform;
  active: boolean | null;
  disconnectPending: boolean;
  connectedAt: string | null;
  /** Recorded by the connection transaction; not a current provider health check. */
  associationRecordedAt: string | null;
}

export interface SocialPostMetadata {
  postId: string;
  status: PostStatus;
  targetPlatforms: Platform[];
  scheduledAt: string | null;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  providerPostId: string | null;
}

export interface SocialStatusResult {
  status: "read" | "simulated";
  source: "stored_social_metadata";
  providerHealth: "not_checked";
  liveProviderCheckPerformed: false;
  publicationPerformed: false;
  observedAt: string | null;
  resource: Resource;
  items: Array<SocialAccountMetadata | SocialPostMetadata>;
  page: { limit: number; hasMore: boolean; nextAfterId: string | null };
}

export interface SocialStatusDbResult { data: unknown; error: unknown }
export interface SocialStatusQuery extends PromiseLike<SocialStatusDbResult> {
  select(columns: string): SocialStatusQuery;
  eq(column: string, value: string): SocialStatusQuery;
  order(column: string, options: { ascending: boolean }): SocialStatusQuery;
  gt(column: string, value: string): SocialStatusQuery;
  limit(value: number): SocialStatusQuery;
  abortSignal(signal: AbortSignal): SocialStatusQuery;
}
export interface SocialStatusDatabase {
  schema(schema: SocialSchema): { from(table: "social_accounts" | "social_posts"): SocialStatusQuery };
}
interface Options {
  database?: SocialStatusDatabase;
  /** Server-owned setting, matching the Edge SOCIAL_DB_SCHEMA contract. */
  schema?: () => unknown;
  now?: () => number;
  timeoutMs?: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID);
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 || !UUID.test(value)) throw new Error(INVALID);
  return value.toLowerCase();
}
function parameters(value: unknown): Required<Pick<SocialStatusParams, "resource" | "limit">> & Pick<SocialStatusParams, "afterId"> {
  const input = object(value);
  if (Object.keys(input).some(key => !["resource", "limit", "afterId"].includes(key)) ||
      !Object.hasOwn(input, "resource") || !["accounts", "posts"].includes(input.resource as string)) throw new Error(INVALID);
  const limit = Object.hasOwn(input, "limit") && input.limit !== undefined ? input.limit : 10;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error(INVALID);
  const afterId = Object.hasOwn(input, "afterId") && input.afterId !== undefined ? uuid(input.afterId) : undefined;
  return { resource: input.resource as Resource, limit, ...(afterId === undefined ? {} : { afterId }) };
}
function owner(context: ToolExecutionContext): string {
  if (!context || context.agentType !== "maitre-des-publicites" || !["live", "simulation"].includes(context.mode)) {
    throw new Error(FORBIDDEN);
  }
  try { return uuid(context.userId); } catch { throw new Error(FORBIDDEN); }
}
function schema(value: unknown): SocialSchema {
  if (value === undefined) return "purama_ai";
  if (value === "public" || value === "purama_ai") return value;
  throw new Error(UNAVAILABLE);
}
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$(?![\s\S])/.test(value) ||
      !Number.isFinite(Date.parse(value))) throw new Error(UNAVAILABLE);
  const year = Number(value.slice(0, 4)); const month = Number(value.slice(5, 7)); const day = Number(value.slice(8, 10));
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(value.slice(11, 13)) > 23) throw new Error(UNAVAILABLE);
  return value;
}
function platform(value: unknown): Platform {
  if (typeof value !== "string" || !PLATFORMS.includes(value as Platform)) throw new Error(UNAVAILABLE);
  return value as Platform;
}
function account(row: Record<string, unknown>, id: string): SocialAccountMetadata {
  if ((typeof row.is_active !== "boolean" && row.is_active !== null) || typeof row.disconnect_pending !== "boolean") {
    throw new Error(UNAVAILABLE);
  }
  return {
    accountId: id, platform: platform(row.platform), active: row.is_active,
    disconnectPending: row.disconnect_pending, connectedAt: timestamp(row.connected_at),
    associationRecordedAt: timestamp(row.publishing_verified_at),
  };
}
function post(row: Record<string, unknown>, id: string): SocialPostMetadata {
  if (typeof row.status !== "string" || !POST_STATUSES.includes(row.status as PostStatus) ||
      !Array.isArray(row.target_platforms) || row.target_platforms.length > PLATFORMS.length) throw new Error(UNAVAILABLE);
  const targetPlatforms = row.target_platforms.map(platform);
  if (new Set(targetPlatforms).size !== targetPlatforms.length) throw new Error(UNAVAILABLE);
  const providerPostId = row.zernio_post_id;
  if (providerPostId !== null && (typeof providerPostId !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$(?![\s\S])/.test(providerPostId))) throw new Error(UNAVAILABLE);
  return {
    postId: id, status: row.status as PostStatus, targetPlatforms, providerPostId,
    scheduledAt: timestamp(row.scheduled_at), publishedAt: timestamp(row.published_at),
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
  };
}

/** Read the existing social store only. No provider call, write or schema fallback. */
export function createSocialStatusTool(options: Options = {}): ToolDefinition<SocialStatusParams, SocialStatusResult> {
  // The existing SDK client remains the only database authority. The narrow
  // boundary describes only the read methods used by this tool and its fixtures.
  const database = options.database ?? supabase as unknown as SocialStatusDatabase;
  const readSchema = options.schema ?? (() => process.env.SOCIAL_DB_SCHEMA);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    name: "social_status",
    description: "Consulte uniquement les métadonnées sociales déjà enregistrées pour ce compte : associations locales ou états et références de publications. " +
      "Aucun contenu, secret, appel fournisseur ni publication. Une association enregistrée ne prouve pas la santé actuelle du compte ; " +
      "un état publié est un reçu stocké, sans nouvelle vérification du réseau. Pagination par identifiant, sans instantané global. " +
      "Cet outil ne donne jamais l’autorisation de republier un résultat incertain.",
    sensitive: false,
    tracePolicy: "metadata_only",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", enum: ["accounts", "posts"] },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Taille de page ; 10 par défaut." },
        afterId: { type: "string", minLength: 36, maxLength: 36, description: "Curseur UUID nextAfterId de la page précédente." },
      },
      required: ["resource"],
      additionalProperties: false,
    },
    async execute(params, ctx) {
      const userId = owner(ctx);
      const input = parameters(params);
      const base = {
        source: "stored_social_metadata" as const, providerHealth: "not_checked" as const,
        liveProviderCheckPerformed: false as const, publicationPerformed: false as const,
        resource: input.resource,
      };
      if (ctx.mode === "simulation") return {
        ...base, status: "simulated", observedAt: null, items: [],
        page: { limit: input.limit, hasMore: false, nextAfterId: null },
      };
      let deadline: ReturnType<typeof createProviderDeadline> | undefined;
      try {
        const selectedSchema = schema(readSchema());
        deadline = createProviderDeadline(timeoutMs, UNAVAILABLE);
        const budget = deadline;
        const result = await budget.wait(() => {
          let query = database.schema(selectedSchema)
            .from(input.resource === "accounts" ? "social_accounts" : "social_posts")
            .select(input.resource === "accounts" ? ACCOUNT_COLUMNS : POST_COLUMNS)
            .eq("user_id", userId).order("id", { ascending: true });
          if (input.afterId) query = query.gt("id", input.afterId);
          return query.limit(input.limit + 1).abortSignal(budget.signal);
        });
        if (!result || result.error !== null || !Array.isArray(result.data) || result.data.length > input.limit + 1) throw new Error(UNAVAILABLE);
        let previousId = input.afterId;
        const accountPlatforms = new Set<Platform>();
        // Validate the sentinel too: a foreign or malformed row must not leak
        // through hasMore, nextAfterId or a silently filtered partial page.
        const items = result.data.map(value => {
          const row = object(value); const id = uuid(row.id);
          if (uuid(row.user_id) !== userId || (previousId !== undefined && id <= previousId)) throw new Error(UNAVAILABLE);
          previousId = id;
          if (input.resource === "posts") return post(row, id);
          const item = account(row, id);
          if (accountPlatforms.has(item.platform)) throw new Error(UNAVAILABLE);
          accountPlatforms.add(item.platform); return item;
        });
        const hasMore = items.length > input.limit;
        const pageItems = items.slice(0, input.limit);
        const last = pageItems.at(-1);
        const observedAt = new Date(now()).toISOString();
        budget.check();
        return {
          ...base, status: "read", observedAt, items: pageItems,
          page: { limit: input.limit, hasMore, nextAfterId: hasMore && last ? ("accountId" in last ? last.accountId : last.postId) : null },
        };
      } catch { throw new Error(UNAVAILABLE); }
      finally { deadline?.close(); }
    },
  };
}

export const socialStatusTool = createSocialStatusTool();
