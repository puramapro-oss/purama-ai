import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export type ChefObservationModality = "behavior" | "visual" | "audio" | "content" | "metadata";
export interface ChefObservationProfile {
  artifactPath: string;
  maxArtifactBytes?: number;
  checks: { id: string; modality: ChefObservationModality; coverage: "full" | "sample" }[];
}
export interface ChefObservation {
  id: string;
  modality: ChefObservationModality;
  status: "pass" | "fail" | "not_tested";
  coverage: "full" | "sample" | "none";
  method: string;
  summary: string;
  location?: string;
}
export interface ChefArtifactObservation {
  artifactPath: string;
  artifactSha256: string;
  observations: ChefObservation[];
}

const MODALITIES = new Set(["behavior", "visual", "audio", "content", "metadata"]);
const ID = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_REPORT_BYTES = 64 * 1024;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Observation invalide");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error("Texte d'observation invalide");
  }
  return value;
}

/** Trusted configuration fixes the artifact, checks and minimum coverage before generation. */
export function normalizeChefObservationProfile(value: unknown): ChefObservationProfile | undefined {
  if (value === undefined) return undefined;
  const v = record(value);
  const artifactPath = text(v.artifactPath, 1_000);
  if (isAbsolute(artifactPath) || artifactPath.includes("\\") || /[\r\n]/.test(artifactPath)
    || artifactPath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Chemin d'observation invalide");
  }
  const maxArtifactBytes = v.maxArtifactBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxArtifactBytes) || Number(maxArtifactBytes) < 1 || Number(maxArtifactBytes) > 1024 * 1024 * 1024) {
    throw new Error("Budget d'observation invalide");
  }
  if (!Array.isArray(v.checks) || v.checks.length < 1 || v.checks.length > 32) throw new Error("Contrôles d'observation invalides");
  const checks = v.checks.map(value => {
    const c = record(value);
    if (typeof c.id !== "string" || !ID.test(c.id) || !MODALITIES.has(String(c.modality))
      || (c.coverage !== "full" && c.coverage !== "sample")) throw new Error("Contrôle d'observation invalide");
    return { id: c.id, modality: c.modality as ChefObservationModality, coverage: c.coverage as "full" | "sample" };
  });
  if (new Set(checks.map(c => c.id)).size !== checks.length) throw new Error("Contrôle d'observation dupliqué");
  return { artifactPath, maxArtifactBytes: Number(maxArtifactBytes), checks };
}

/** Hash the actual bounded regular file, never a model-supplied path or digest. */
export async function hashChefArtifact(cwd: string, profile: ChefObservationProfile, signal?: AbortSignal): Promise<string> {
  const checkAbort = () => { if (signal?.aborted) throw new Error("Vérification CHEF annulée"); };
  checkAbort();
  const path = resolve(cwd, profile.artifactPath);
  // Reject symlinks at every component. The verifier already canonicalizes cwd.
  if (await realpath(path) !== path || !(await lstat(path)).isFile()) throw new Error("Artefact d'observation non régulier");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    const maximum = profile.maxArtifactBytes ?? 64 * 1024 * 1024;
    if (!before.isFile() || before.size > BigInt(maximum)) throw new Error("Budget de lecture d'artefact dépassé");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let count = 0;
    for (;;) {
      checkAbort();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, count);
      checkAbort();
      if (!bytesRead) break;
      count += bytesRead;
      if (count > maximum) throw new Error("Budget de lecture d'artefact dépassé");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!current.isFile() || await realpath(path) !== path || count !== Number(before.size)
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || current.dev !== before.dev || current.ino !== before.ino || current.mtimeNs !== before.mtimeNs
      || current.ctimeNs !== before.ctimeNs) throw new Error("Artefact modifié pendant sa lecture");
    checkAbort();
    return hash.digest("hex");
  } finally { await handle.close(); }
}

/** Parse only a configured independent observer's JSON, not the generating driver's claims. */
export function parseChefObservationReport(output: string, profile: ChefObservationProfile, artifactSha256: string): ChefArtifactObservation {
  if (Buffer.byteLength(output, "utf8") > MAX_REPORT_BYTES) throw new Error("Rapport d'observation trop volumineux");
  const report = record(JSON.parse(output));
  if (report.schemaVersion !== 1 || report.artifactSha256 !== artifactSha256
    || !Array.isArray(report.observations) || report.observations.length !== profile.checks.length) {
    throw new Error("Rapport d'observation absent, incomplet ou périmé");
  }
  const seen = new Set<string>();
  const observations = report.observations.map(value => {
    const v = record(value);
    const expected = profile.checks.find(c => c.id === v.id);
    if (!expected || seen.has(expected.id) || v.modality !== expected.modality
      || !["pass", "fail", "not_tested"].includes(String(v.status))
      || !["full", "sample", "none"].includes(String(v.coverage))) throw new Error("Contrôle d'observation incohérent");
    seen.add(expected.id);
    return { id: expected.id, modality: expected.modality,
      status: v.status as ChefObservation["status"], coverage: v.coverage as ChefObservation["coverage"],
      method: text(v.method, 200), summary: text(v.summary, 1_000),
      ...(v.location === undefined ? {} : { location: text(v.location, 300) }),
    };
  });
  return { artifactPath: profile.artifactPath, artifactSha256, observations };
}

export function chefObservationPassed(result: ChefArtifactObservation, profile: ChefObservationProfile): boolean {
  return profile.checks.every(expected => {
    const observed = result.observations.find(o => o.id === expected.id);
    return observed?.status === "pass" && (observed.coverage === "full" ||
      (expected.coverage === "sample" && observed.coverage === "sample"));
  });
}
