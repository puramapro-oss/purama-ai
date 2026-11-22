import type { AgentContextInput, AgentTrigger } from "../engine/types.js";
import { createSocialStatusTool, type SocialStatusResult } from "../tools/social-status.js";

const reader = createSocialStatusTool();
const LIMITS = { accounts: 14, posts: 10 } as const;
type Resource = keyof typeof LIMITS;
type Page = SocialStatusResult | { status: "unavailable"; resource: Resource };

function page(result: PromiseSettledResult<SocialStatusResult>, resource: Resource): Page {
  return result.status === "fulfilled" && result.value.status === "read"
    ? result.value : { status: "unavailable", resource };
}

/**
 * The single-decision engine needs these reads before inference. Only KARTA's
 * prepared live brief enables them; trigger fields grant no read authority.
 * The existing reader owns projections, tenant checks, schema and deadlines.
 */
export async function buildSocialBriefContext(
  userId: string, _trigger: AgentTrigger, prepared?: AgentContextInput,
): Promise<Record<string, unknown>> {
  const brief = prepared?.pendingBrief;
  const base = brief ? { items: [{ brief }] } : { items: [], reason: "aucun brief en attente" };
  if (!brief || prepared?.executionMode !== "live") return base;

  const context = { userId, agentType: "maitre-des-publicites" as const, mode: "live" as const };
  const results = await Promise.allSettled([
    reader.execute({ resource: "accounts", limit: LIMITS.accounts }, context),
    reader.execute({ resource: "posts", limit: LIMITS.posts }, context),
  ]);
  const accounts = page(results[0], "accounts");
  const posts = page(results[1], "posts");
  const available = Number(accounts.status === "read") + Number(posts.status === "read");
  return {
    ...base,
    socialStatus: {
      source: "stored_social_metadata",
      availability: available === 2 ? "available" : available === 1 ? "partial" : "unavailable",
      coverage: "bounded_first_pages_by_id",
      atomicSnapshot: false,
      limits: { ...LIMITS },
      providerHealth: "not_checked",
      liveProviderCheckPerformed: false,
      publicationPerformed: false,
      accounts, posts,
    },
  };
}
