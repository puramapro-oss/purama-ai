import { supabase } from "../db/supabase.js";
import { hashChefBrief, normalizeChefBrief, type ChefBrief } from "./brief.js";

export interface CreateChefMissionOptions {
  userId: string;
  maxParallel?: number;
  tokenBudget?: number | null;
  costBudgetMicros?: number | null;
}

export async function createChefMission(brief: ChefBrief, options: CreateChefMissionOptions): Promise<{
  missionId: string;
  briefHash: string;
  normalized: ChefBrief;
}> {
  const normalized = normalizeChefBrief(brief);
  const briefHash = hashChefBrief(normalized);
  if (!/^[0-9a-f-]{36}$/i.test(options.userId)) throw new Error("userId CHEF invalide");

  const maxParallel = options.maxParallel ?? 4;
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 64) throw new Error("maxParallel invalide");
  for (const [label, value] of [
    ["tokenBudget", options.tokenBudget],
    ["costBudgetMicros", options.costBudgetMicros],
  ] as const) {
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${label} invalide`);
    }
  }

  const { data, error } = await supabase.rpc("chef_create_mission", {
    p_user_id: options.userId,
    p_brief: normalized,
    p_brief_hash: briefHash,
    p_max_parallel: maxParallel,
    p_token_budget: options.tokenBudget ?? null,
    p_cost_budget_micros: options.costBudgetMicros ?? null,
  });
  if (error) throw new Error(`chef_create_mission: ${error.message}`);
  if (typeof data !== "string" || !/^[0-9a-f-]{36}$/i.test(data)) throw new Error("missionId CHEF invalide");

  return { missionId: data, briefHash, normalized };
}
