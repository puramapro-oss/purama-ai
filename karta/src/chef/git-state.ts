import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChefVerificationEvidence } from "./verifier.js";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40,64}$/i;

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: gitEnv(),
  });
  return stdout.trim();
}

export interface ChefGitBaseline {
  headSha: string;
  branch?: string;
}

/** Refuse d'écrire par-dessus un WIP étranger et capture la base réelle juste avant le worker. */
export async function captureCleanGitBaseline(input: {
  cwd: string;
  expectedBranch?: string;
}): Promise<ChefGitBaseline> {
  const headSha = await git(input.cwd, ["rev-parse", "HEAD"]);
  if (!SHA.test(headSha)) throw new Error("HEAD Git initial invalide");

  const status = await git(input.cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length !== 0) throw new Error("Worktree contient déjà du WIP non attribué");

  let branch: string | undefined;
  if (input.expectedBranch) {
    branch = await git(input.cwd, ["branch", "--show-current"]);
    if (branch !== input.expectedBranch) throw new Error("Branche initiale différente de la branche assignée");
  }
  return { headSha, ...(branch ? { branch } : {}) };
}

function isAllowedPath(path: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((allowed) => {
    if (allowed === ".") return true;
    const prefix = allowed.replace(/\/$/, "");
    return path === prefix || path.startsWith(prefix + "/");
  });
}

async function changedPaths(cwd: string, baseSha: string, headSha: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", baseSha, headSha, "--"],
    { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: gitEnv(), encoding: "utf8" }
  );
  return stdout.split("\0").filter(Boolean).sort();
}

/**
 * A write task cannot be VERIFIED_DONE against a SHA reported only by the worker.
 * This independently checks the real repository state, ancestry, cleanliness and file ownership.
 */
export async function verifyCommittedGitState(input: {
  cwd: string;
  expectedHeadSha: string;
  expectedBranch?: string;
  baseSha?: string;
  allowedPaths?: string[];
}): Promise<ChefVerificationEvidence> {
  if (!SHA.test(input.expectedHeadSha)) throw new Error("Expected HEAD invalide");

  const actualHead = await git(input.cwd, ["rev-parse", "HEAD"]);
  if (actualHead.toLowerCase() !== input.expectedHeadSha.toLowerCase()) {
    throw new Error("HEAD réel différent du SHA déclaré par le worker");
  }

  const status = await git(input.cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length !== 0) {
    throw new Error("Worktree non propre après la tâche");
  }

  let branch: string | undefined;
  if (input.expectedBranch) {
    branch = await git(input.cwd, ["branch", "--show-current"]);
    if (branch !== input.expectedBranch) throw new Error("Branche réelle différente de la branche assignée");
  }

  let files: string[] = [];
  if (input.baseSha) {
    if (!SHA.test(input.baseSha)) throw new Error("Base SHA invalide");
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", input.baseSha, actualHead], {
        cwd: input.cwd,
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        env: gitEnv(),
      });
    } catch {
      throw new Error("HEAD ne descend pas de la base assignée");
    }

    files = await changedPaths(input.cwd, input.baseSha, actualHead);
    const allowed = input.allowedPaths ?? [];
    if (allowed.length === 0) throw new Error("Périmètre allowedPaths absent pour une tâche write");
    const escaped = files.filter((path) => !isAllowedPath(path, allowed));
    if (escaped.length > 0) {
      throw new Error(`Diff hors périmètre autorisé: ${escaped.slice(0, 10).join(", ")}`);
    }
  }

  const payload = {
    profile: "git-state" as const,
    ok: true as const,
    headSha: actualHead,
    clean: true as const,
    changedPaths: files,
    ...(branch ? { branch } : {}),
    ...(input.baseSha ? { baseSha: input.baseSha } : {}),
    ...(input.allowedPaths ? { allowedPaths: input.allowedPaths } : {}),
  };
  return {
    kind: "receipt",
    sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    payload,
  };
}
