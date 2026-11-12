import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import type { ChefVerificationProfile } from "./verifier.js";

export const WORKSHOP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WORKSHOP_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
export interface WorkshopProject {
  id: string;
  name: string;
  userIds: string[];
  repo: string;
  workdir: string;
  allowedPaths: string[];
  maxParallel: number;
  tokenBudget: number;
  estimatedTokensPerTask: number;
  costBudgetMicros?: number;
  estimatedCostMicrosPerTask?: number;
  codexCommand: string;
  verificationProfiles: ChefVerificationProfile[];
  implementationProfiles: string[];
  reviewProfiles: string[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration atelier invalide");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error("Texte de configuration atelier invalide");
  }
  return value.trim();
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error("Limite atelier invalide");
  return Number(value);
}
function strings(value: unknown, max = 128): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new Error("Liste atelier invalide");
  const result = value.map(v => text(v, 1000));
  if (new Set(result).size !== result.length) throw new Error("Doublon de configuration atelier");
  return result;
}
export function parseWorkshopProjects(raw = process.env.CHEF_WORKSHOP_PROJECTS_JSON ?? "[]"): WorkshopProject[] {
  if (Buffer.byteLength(raw) > 65_536) throw new Error("Configuration atelier trop volumineuse");
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > 64) throw new Error("Catalogue atelier invalide");
  const projects = values.map(value => {
    const v = object(value);
    const id = text(v.id, 48);
    if (!WORKSHOP_ID.test(id)) throw new Error("Identifiant projet invalide");
    const userIds = strings(v.userIds, 32).map(id => id.toLowerCase());
    if (userIds.some(id => !WORKSHOP_UUID.test(id))) throw new Error("Propriétaire atelier invalide");
    const workdir = text(v.workdir, 1000);
    if (!isAbsolute(workdir) || normalize(workdir) !== workdir || workdir === "/" || workdir.endsWith("/")) throw new Error("Dossier atelier invalide");
    const allowedPaths = strings(v.allowedPaths);
    if (allowedPaths.some(p => p === "." || p.startsWith("/") || p.includes("\\") || p.split("/").some(s => s === ".." || s === "." || !s))) {
      throw new Error("Périmètre de fichiers atelier invalide");
    }
    const tokenBudget = integer(v.tokenBudget, 1, 10_000_000);
    const estimatedTokensPerTask = integer(v.estimatedTokensPerTask, 1, tokenBudget);
    if (estimatedTokensPerTask * 3 > tokenBudget) throw new Error("Budget inférieur aux trois tâches prévues");
    const implementationProfiles = strings(v.implementationProfiles, 16);
    const reviewProfiles = strings(v.reviewProfiles, 16);
    if (!Array.isArray(v.verificationProfiles) || !v.verificationProfiles.length || v.verificationProfiles.length > 32) {
      throw new Error("Vérifications atelier absentes");
    }
    const verificationProfiles = v.verificationProfiles.map(entry => {
      const p = object(entry);
      if (!["test", "build", "typecheck", "lint", "security", "review", "receipt", "runtime"].includes(String(p.kind))) {
        throw new Error("Type de preuve atelier invalide");
      }
      const profile: ChefVerificationProfile = {
        name: text(p.name, 120), kind: p.kind as ChefVerificationProfile["kind"], command: text(p.command, 1000),
        requirementKeys: strings(p.requirementKeys, 16),
      };
      if (p.args !== undefined) {
        if (!Array.isArray(p.args) || p.args.length > 64 || p.args.some(a => typeof a !== "string" || a.length > 4000 || a.includes("\0"))) throw new Error("Arguments atelier invalides");
        profile.args = p.args as string[];
      }
      if (p.timeoutMs !== undefined) profile.timeoutMs = integer(p.timeoutMs, 1000, 1_200_000);
      return profile;
    });
    const names = verificationProfiles.map(p => p.name);
    if (new Set(names).size !== names.length || [...implementationProfiles, ...reviewProfiles].some(n => !names.includes(n))) {
      throw new Error("Profils atelier incohérents");
    }
    for (const key of ["PRODUCT", "QUALITY"]) {
      if (!verificationProfiles.some(p => implementationProfiles.includes(p.name) && p.kind !== "review" && p.requirementKeys?.includes(key)) ||
          !verificationProfiles.some(p => reviewProfiles.includes(p.name) && p.kind === "review" && p.requirementKeys?.includes(key))) {
        throw new Error("Preuve et revue indépendantes requises pour chaque exigence");
      }
    }
    const project: WorkshopProject = {
      id, name: text(v.name, 120), userIds, repo: text(v.repo, 200), workdir, allowedPaths,
      maxParallel: integer(v.maxParallel ?? 2, 1, 4), tokenBudget, estimatedTokensPerTask,
      codexCommand: text(v.codexCommand ?? "codex", 1000),
      verificationProfiles, implementationProfiles, reviewProfiles,
    };
    if (v.costBudgetMicros !== undefined) {
      project.costBudgetMicros = integer(v.costBudgetMicros, 0, 1_000_000_000);
      project.estimatedCostMicrosPerTask = integer(v.estimatedCostMicrosPerTask, 0, project.costBudgetMicros);
      if (project.estimatedCostMicrosPerTask * 3 > project.costBudgetMicros) throw new Error("Budget monétaire insuffisant");
    } else if (v.estimatedCostMicrosPerTask !== undefined) throw new Error("Budget monétaire absent");
    return project;
  });
  if (new Set(projects.map(p => p.id)).size !== projects.length || new Set(projects.map(p => p.workdir)).size !== projects.length) {
    throw new Error("Projets atelier dupliqués");
  }
  return projects;
}
export function workshopProjectHash(project: WorkshopProject): string {
  return createHash("sha256").update(JSON.stringify(project)).digest("hex");
}
