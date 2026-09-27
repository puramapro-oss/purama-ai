import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { assertAllowedCwd } from "./driver.js";

export type ChefEvidenceKind = "test" | "build" | "typecheck" | "lint" | "security" | "review" | "receipt" | "runtime" | "other";

export interface ChefVerificationProfile {
  name: string;
  kind: ChefEvidenceKind;
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
      this.profiles.set(profile.name, profile);
    }
  }

  async verify(cwdInput: string, profileNames: string[], signal?: AbortSignal): Promise<ChefVerificationResult> {
    const cwd = assertAllowedCwd(cwdInput, this.allowedRoots);
    if (profileNames.length === 0) return { ok: false, evidence: [], error: "Aucun profil de vérification" };
    if (new Set(profileNames).size !== profileNames.length) return { ok: false, evidence: [], error: "Profil de vérification dupliqué" };

    const evidence: ChefVerificationEvidence[] = [];
    for (const name of profileNames) {
      const profile = this.profiles.get(name);
      if (!profile) return { ok: false, evidence, error: `Profil inconnu: ${name}` };
      const result = await this.runProfile(cwd, profile, signal);
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

    return await new Promise<ChefVerificationEvidence>((resolvePromise, rejectPromise) => {
      const child = spawn(profile.command, profile.args ?? [], {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: safeEnv(profile.envAllowList ?? ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"], profile.env ?? {}),
      });
      let output = "";
      let settled = false;
      const terminate = () => {
        if (!child.killed) child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 2_000).unref();
      };
      const append = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output, "utf8") > maxOutput) {
          terminate();
          throw new Error(`Sortie de vérification trop volumineuse: ${profile.name}`);
        }
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      };
      const timer = setTimeout(() => {
        terminate();
        fail(new Error(`Vérification expirée: ${profile.name}`));
      }, timeoutMs);
      timer.unref();
      const onAbort = () => {
        terminate();
        fail(new Error(`Vérification annulée: ${profile.name}`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      child.stdout.on("data", (chunk: Buffer) => { try { append(chunk); } catch (e) { fail(e as Error); } });
      child.stderr.on("data", (chunk: Buffer) => { try { append(chunk); } catch (e) { fail(e as Error); } });
      child.on("error", fail);
      child.on("close", (code, signalName) => {
        if (settled) return;
        settled = true;
        cleanup();
        const ok = code === 0;
        const digest = createHash("sha256").update(output).digest("hex");
        resolvePromise({
          kind: profile.kind,
          sha256: digest,
          payload: {
            profile: profile.name,
            ok,
            exitCode: code,
            signal: signalName,
            outputBytes: Buffer.byteLength(output, "utf8"),
          },
        });
      });
    });
  }
}
