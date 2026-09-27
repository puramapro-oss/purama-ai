import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40,64}$/i;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
    },
  });
  return stdout.trim();
}

export interface ChefGitStateEvidence {
  kind: "receipt";
  sha256: string;
  payload: {
    profile: "git-state";
    ok: true;
    headSha: string;
    clean: true;
    branch?: string;
    baseSha?: string;
  };
}

/**
 * A write task cannot be VERIFIED_DONE against a SHA reported only by the worker.
 * This independently checks the real repository state and rejects dirty/uncommitted work.
 */
export async function verifyCommittedGitState(input: {
  cwd: string;
  expectedHeadSha: string;
  expectedBranch?: string;
  baseSha?: string;
}): Promise<ChefGitStateEvidence> {
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

  if (input.baseSha) {
    if (!SHA.test(input.baseSha)) throw new Error("Base SHA invalide");
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", input.baseSha, actualHead], {
        cwd: input.cwd,
        timeout: 30_000,
        maxBuffer: 256 * 1024,
      });
    } catch {
      throw new Error("HEAD ne descend pas de la base assignée");
    }
  }

  const payload = {
    profile: "git-state" as const,
    ok: true as const,
    headSha: actualHead,
    clean: true as const,
    ...(branch ? { branch } : {}),
    ...(input.baseSha ? { baseSha: input.baseSha } : {}),
  };
  return {
    kind: "receipt",
    sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    payload,
  };
}
