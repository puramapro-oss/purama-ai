import type Anthropic from "@anthropic-ai/sdk";
import { ASSISTANT_CORE_POLICY } from "./assistant-policy.js";

export type AnthropicPromptCacheMode = "off" | "5m";

/** Server configuration only. Unknown values must never enable paid cache writes. */
export function parseAnthropicPromptCacheMode(value: unknown): AnthropicPromptCacheMode {
  if (value === undefined || value === "off") return "off";
  if (value === "5m") return "5m";
  throw new Error("KARTA_ANTHROPIC_PROMPT_CACHE invalide : off ou 5m requis");
}

/**
 * Cache only the code-owned public policy. Roles and business context can carry
 * user data and remain after the breakpoint. Anthropic also includes preceding
 * tool definitions in a system-prefix cache, so calls with tools are excluded.
 * Compatible/local endpoints keep their original string-only request contract.
 * Eligibility and actual cache hits remain the provider's decision.
 */
export function applyPublicPromptCache(
  systemPrompt: string,
  mode: AnthropicPromptCacheMode,
  nativeEndpoint: boolean,
  hasTools: boolean,
): string | Anthropic.TextBlockParam[] {
  if (mode === "off" || !nativeEndpoint || hasTools) return systemPrompt;
  const publicPrefix = `${ASSISTANT_CORE_POLICY}\n\n`;
  // A later policy-assembly change must fail closed for caching, without
  // dropping instructions or placing private text before a cache breakpoint.
  if (!systemPrompt.startsWith(publicPrefix) || systemPrompt.length === publicPrefix.length) return systemPrompt;
  return [
    { type: "text", text: publicPrefix, cache_control: { type: "ephemeral", ttl: "5m" } },
    { type: "text", text: systemPrompt.slice(publicPrefix.length) },
  ];
}
