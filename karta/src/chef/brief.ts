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
  /** Repo-relative paths or directories this write task may change. "." explicitly means the whole repo. */
  allowedPaths?: string[];
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
  const clean = (values ?? []).map((value) => {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} invalide`);
    return value.trim();
  });
  const set = new Set(clean);
  if (set.size !== clean.length) throw new Error(`${label} contient un doublon`);
  return clean;
}

function normalizeOwnedPath(value: string): string {
  const clean = value.trim().replace(/\/$/, "") || ".";
  if (
    clean.includes("\0") ||
    clean.includes("\\") ||
    clean.startsWith("/") ||
    clean === ".." ||
    clean.startsWith("../") ||
    clean.endsWith("/..") ||
    clean.includes("/../")
  ) {
    throw new Error(`allowedPath invalide: ${value}`);
  }
  return clean;
}

function ownedPaths(values: string[] | undefined, taskKey: string): string[] {
  const normalized = uniqueStrings(values, `allowedPaths(${taskKey})`).map(normalizeOwnedPath);
  if (new Set(normalized).size !== normalized.length) throw new Error(`allowedPaths(${taskKey}) contient un doublon canonique`);
  return normalized;
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
    const requirementKey = requirement.key.trim();
    if (requirementKeys.has(requirementKey)) throw new Error(`Requirement dupliquée: ${requirementKey}`);
    requirementKeys.add(requirementKey);
  }

  const tasks = new Map<string, ChefBriefTask>();
  for (const task of input.tasks) {
    nonEmpty(task.key, "task.key", 200);
    nonEmpty(task.title, "task.title", 500);
    nonEmpty(task.instructions, "task.instructions", 100_000);
    const taskKey = task.key.trim();
    if (tasks.has(taskKey)) throw new Error(`Task dupliquée: ${taskKey}`);
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
    const dependencies = uniqueStrings(task.dependsOn, `dependsOn(${taskKey})`);
    const linked = uniqueStrings(task.requirementKeys, `requirementKeys(${taskKey})`);
    const verificationProfiles = uniqueStrings(task.verificationProfiles, `verificationProfiles(${taskKey})`);
    const writePaths = ownedPaths(task.allowedPaths, taskKey);
    if (verificationProfiles.length === 0) throw new Error(`Task sans profil de vérification: ${task.key}`);
    if (verificationProfiles.some((profile) => !/^[A-Za-z0-9._:-]{1,120}$/.test(profile))) {
      throw new Error(`Profil de vérification invalide: ${task.key}`);
    }
    const accessMode = task.accessMode ?? "write";
    if (accessMode === "write" && !task.scopeKey?.trim() && !task.worktree?.trim()) {
      throw new Error(`Task write sans scope/worktree: ${taskKey}`);
    }
    if (accessMode === "write" && writePaths.length === 0) {
      throw new Error(`Task write sans allowedPaths: ${taskKey}`);
    }
    if (linked.length === 0) throw new Error(`Task sans requirement: ${taskKey}`);
    // The cycle walk must use the same references as dependency validation.
    tasks.set(taskKey, { ...task, dependsOn: dependencies });
  }

  const covered = new Set<string>();
  for (const task of tasks.values()) {
    const taskKey = task.key.trim();
    for (const requirementKey of uniqueStrings(task.requirementKeys, `requirementKeys(${taskKey})`)) {
      if (!requirementKeys.has(requirementKey)) {
        throw new Error(`Requirement inconnue ${requirementKey} dans ${taskKey}`);
      }
      covered.add(requirementKey);
    }
    for (const dependency of uniqueStrings(task.dependsOn, `dependsOn(${taskKey})`)) {
      if (!tasks.has(dependency)) throw new Error(`Dépendance inconnue ${dependency} dans ${taskKey}`);
      if (dependency === taskKey) throw new Error(`Auto-dépendance: ${taskKey}`);
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
        dependsOn: uniqueStrings(task.dependsOn, `dependsOn(${task.key.trim()})`).sort(),
        requirementKeys: uniqueStrings(task.requirementKeys, `requirementKeys(${task.key.trim()})`).sort(),
        provider: task.provider ?? "auto",
        accessMode: task.accessMode ?? "write",
        ...(task.scopeKey ? { scopeKey: task.scopeKey.trim() } : {}),
        ...(task.worktree ? { worktree: task.worktree.trim() } : {}),
        allowedPaths: ownedPaths(task.allowedPaths, task.key.trim()).sort(),
        priority: task.priority ?? 0,
        maxAttempts: task.maxAttempts ?? 3,
        verificationProfiles: uniqueStrings(task.verificationProfiles, `verificationProfiles(${task.key.trim()})`).sort(),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function hashChefBrief(input: ChefBrief): string {
  const normalized = normalizeChefBrief(input);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
