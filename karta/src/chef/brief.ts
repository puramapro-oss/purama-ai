import { createHash } from "node:crypto";

export type ChefProvider = "auto" | "codex" | "claude" | "glm";
export type ChefAccessMode = "read" | "write";

export interface ChefBriefRequirement {
  key: string;
  description: string;
  critical?: boolean;
}

export interface ChefBriefTask {
  key: string;
  title: string;
  instructions: string;
  dependsOn?: string[];
  requirementKeys: string[];
  provider?: ChefProvider;
  accessMode?: ChefAccessMode;
  scopeKey?: string;
  worktree?: string;
  priority?: number;
  maxAttempts?: number;
  verificationProfiles?: string[];
}

export interface ChefBrief {
  briefId: string;
  version: number;
  goal: string;
  repo: string;
  requirements: ChefBriefRequirement[];
  tasks: ChefBriefTask[];
}

function nonEmpty(value: unknown, label: string, max = 20_000): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(`${label} invalide`);
  }
}

function uniqueStrings(values: string[] | undefined, label: string): string[] {
  const clean = values ?? [];
  if (clean.some(value => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error(`${label} invalide`);
  }
  const set = new Set(clean);
  if (set.size !== clean.length) throw new Error(`${label} contient un doublon`);
  return clean;
}

export function validateChefBrief(input: ChefBrief): void {
  if (!input || typeof input !== "object") throw new Error("Brief absent");
  nonEmpty(input.briefId, "briefId", 200);
  nonEmpty(input.goal, "goal", 50_000);
  nonEmpty(input.repo, "repo", 500);
  if (!Number.isInteger(input.version) || input.version < 1) throw new Error("version invalide");
  if (!Array.isArray(input.requirements) || input.requirements.length === 0) throw new Error("requirements vide");
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new Error("tasks vide");

  const requirementKeys = new Set<string>();
  for (const requirement of input.requirements) {
    nonEmpty(requirement.key, "requirement.key", 200);
    nonEmpty(requirement.description, "requirement.description", 20_000);
    if (requirementKeys.has(requirement.key)) throw new Error(`Requirement dupliquée: ${requirement.key}`);
    requirementKeys.add(requirement.key);
  }

  const tasks = new Map<string, ChefBriefTask>();
  for (const task of input.tasks) {
    nonEmpty(task.key, "task.key", 200);
    nonEmpty(task.title, "task.title", 500);
    nonEmpty(task.instructions, "task.instructions", 100_000);
    if (tasks.has(task.key)) throw new Error(`Task dupliquée: ${task.key}`);
    if (task.provider && !["auto", "codex", "claude", "glm"].includes(task.provider)) {
      throw new Error(`Provider invalide: ${task.provider}`);
    }
    if (task.accessMode && !["read", "write"].includes(task.accessMode)) {
      throw new Error(`accessMode invalide: ${task.accessMode}`);
    }
    if (task.priority !== undefined && !Number.isInteger(task.priority)) throw new Error("priority invalide");
    if (task.maxAttempts !== undefined && (!Number.isInteger(task.maxAttempts) || task.maxAttempts < 1 || task.maxAttempts > 20)) {
      throw new Error("maxAttempts invalide");
    }
    uniqueStrings(task.dependsOn, `dependsOn(${task.key})`);
    const linked = uniqueStrings(task.requirementKeys, `requirementKeys(${task.key})`);
    const verificationProfiles = uniqueStrings(task.verificationProfiles, `verificationProfiles(${task.key})`);
    if (verificationProfiles.length === 0) throw new Error(`Task sans profil de vérification: ${task.key}`);
    if (verificationProfiles.some((profile) => !/^[A-Za-z0-9._:-]{1,120}$/.test(profile))) {
      throw new Error(`Profil de vérification invalide: ${task.key}`);
    }
    const accessMode = task.accessMode ?? "write";
    if (accessMode === "write" && !task.scopeKey?.trim() && !task.worktree?.trim()) {
      throw new Error(`Task write sans scope/worktree: ${task.key}`);
    }
    if (linked.length === 0) throw new Error(`Task sans requirement: ${task.key}`);
    tasks.set(task.key, task);
  }

  const covered = new Set<string>();
  for (const task of tasks.values()) {
    for (const requirementKey of task.requirementKeys) {
      if (!requirementKeys.has(requirementKey)) {
        throw new Error(`Requirement inconnue ${requirementKey} dans ${task.key}`);
      }
      covered.add(requirementKey);
    }
    for (const dependency of task.dependsOn ?? []) {
      if (!tasks.has(dependency)) throw new Error(`Dépendance inconnue ${dependency} dans ${task.key}`);
      if (dependency === task.key) throw new Error(`Auto-dépendance: ${task.key}`);
    }
  }

  for (const requirementKey of requirementKeys) {
    if (!covered.has(requirementKey)) throw new Error(`Requirement sans tâche: ${requirementKey}`);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new Error(`Cycle de dépendances détecté autour de ${key}`);
    visiting.add(key);
    for (const dependency of tasks.get(key)?.dependsOn ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of tasks.keys()) visit(key);
}

export function normalizeChefBrief(input: ChefBrief): ChefBrief {
  validateChefBrief(input);
  return {
    briefId: input.briefId.trim(),
    version: input.version,
    goal: input.goal.trim(),
    repo: input.repo.trim(),
    requirements: [...input.requirements]
      .map(r => ({ key: r.key.trim(), description: r.description.trim(), critical: r.critical ?? true }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    tasks: [...input.tasks]
      .map(task => ({
        key: task.key.trim(),
        title: task.title.trim(),
        instructions: task.instructions.trim(),
        dependsOn: [...(task.dependsOn ?? [])].sort(),
        requirementKeys: [...task.requirementKeys].sort(),
        provider: task.provider ?? "auto",
        accessMode: task.accessMode ?? "write",
        ...(task.scopeKey ? { scopeKey: task.scopeKey.trim() } : {}),
        ...(task.worktree ? { worktree: task.worktree.trim() } : {}),
        priority: task.priority ?? 0,
        maxAttempts: task.maxAttempts ?? 3,
        verificationProfiles: [...(task.verificationProfiles ?? [])].sort(),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function hashChefBrief(input: ChefBrief): string {
  const normalized = normalizeChefBrief(input);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
