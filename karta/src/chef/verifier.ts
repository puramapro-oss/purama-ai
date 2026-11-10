import { createHash } from "node:crypto";
import { runChefProcess } from "./process.js";
import { assertAllowedCwd } from "./driver.js";

export type ChefEvidenceKind = "test" | "build" | "typecheck" | "lint" | "security" | "review" | "receipt" | "runtime" | "other";

export interface ChefVerificationProfile {
  name: string;
  kind: ChefEvidenceKind;
  /** Explicit requirements checked by this trusted profile; omitted means task-only. */
  requirementKeys?: string[];
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  envAllowList?: string[];
  env?: Record<string, string>;
}

export interface ChefVerificationEvidence {
  kind: ChefEvidenceKind;
  sha256: string;
  /** Set by the trusted verifier, never inferred from command or model output. */
  requirementKeys?: string[];
  payload: {
    profile: string;
    ok: boolean;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    outputBytes?: number;
    [key: string]: unknown;
  };
}

export interface ChefVerificationResult {
  ok: boolean;
  evidence: ChefVerificationEvidence[];
  error?: string;
}

export interface ChefVerifier {
  verify(cwd: string, profileNames: string[], signal?: AbortSignal): Promise<ChefVerificationResult>;
}

export function normalizeChefRequirementKeys(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Portée des exigences invalide");
  const keys = value.map((key: unknown) => {
    if (typeof key !== "string" || key.trim().length === 0 || key.length > 200) {
      throw new Error("Clé d'exigence invalide");
    }
    return key.trim();
  });
  return [...new Set(keys)].sort();
}

function safeEnv(allow: string[], extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of allow) if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, extra);
  return env;
}

/**
 * Deterministic verifier. Profiles are trusted configuration, never arbitrary commands
 * supplied by the model or by a repository file.
 */
export class CommandChefVerifier implements ChefVerifier {
  private readonly profiles: Map<string, ChefVerificationProfile>;

  constructor(profiles: ChefVerificationProfile[], private readonly allowedRoots: string[]) {
    this.profiles = new Map();
    for (const profile of profiles) {
      if (!/^[A-Za-z0-9._:-]{1,120}$/.test(profile.name)) throw new Error("Nom de profil invalide");
      if (this.profiles.has(profile.name)) throw new Error(`Profil de vérification dupliqué: ${profile.name}`);
      if (!profile.command) throw new Error("Commande de vérification absente");
      this.profiles.set(profile.name, {
        ...profile,
        requirementKeys: normalizeChefRequirementKeys(profile.requirementKeys),
      });
    }
  }

  async verify(cwdInput: string, profileNames: string[], signal?: AbortSignal): Promise<ChefVerificationResult> {
    if (signal?.aborted) throw new Error("Vérification CHEF annulée");
    const cwd = assertAllowedCwd(cwdInput, this.allowedRoots);
    if (profileNames.length === 0) return { ok: false, evidence: [], error: "Aucun profil de vérification" };
    if (new Set(profileNames).size !== profileNames.length) return { ok: false, evidence: [], error: "Profil de vérification dupliqué" };

    const evidence: ChefVerificationEvidence[] = [];
    for (const name of profileNames) {
      const profile = this.profiles.get(name);
      if (!profile) return { ok: false, evidence, error: `Profil inconnu: ${name}` };
      const result = await this.runProfile(cwd, profile, signal);
      if (signal?.aborted) throw new Error("Vérification CHEF annulée");
      evidence.push(result);
      if (!result.payload.ok) {
        return { ok: false, evidence, error: `Vérification échouée: ${name}` };
      }
    }
    return { ok: true, evidence };
  }

  private async runProfile(cwd: string, profile: ChefVerificationProfile, signal?: AbortSignal): Promise<ChefVerificationEvidence> {
    const maxOutput = profile.maxOutputBytes ?? 2 * 1024 * 1024;
    const timeoutMs = profile.timeoutMs ?? 20 * 60 * 1000;

    const result = await runChefProcess({
      command: profile.command,
      args: profile.args,
      cwd,
      env: safeEnv(profile.envAllowList ?? ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"], profile.env ?? {}),
      signal,
      timeoutMs,
      maxOutputBytes: maxOutput,
      label: `vérification ${profile.name}`,
      abortMessage: `Vérification annulée: ${profile.name}`,
      timeoutMessage: `Vérification expirée: ${profile.name}`,
    });
    return {
      kind: profile.kind,
      sha256: createHash("sha256").update(result.output).digest("hex"),
      requirementKeys: [...(profile.requirementKeys ?? [])],
      payload: {
        profile: profile.name,
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        signal: result.signal,
        outputBytes: result.output.length,
      },
    };
  }
}
