export type ChefWorkerProvider = "codex" | "claude" | "glm";
export type ChefWorkerState = "offline" | "idle" | "claimed" | "running" | "verifying" | "blocked" | "failed";

export interface ChefWorkerReport {
  schemaVersion: 1;
  workerId: string;
  provider: ChefWorkerProvider;
  state: ChefWorkerState;
  sequence: number;
  timestamp: string;
  taskId?: string;
  fencingToken?: number;
  headSha?: string;
  progress?: {
    phase: string;
    completed: number;
    total?: number;
  };
  evidenceRefs?: string[];
  error?: string;
}

const SHA = /^[0-9a-f]{40,64}$/i;

export function validateWorkerReport(report: ChefWorkerReport): void {
  if (!report || typeof report !== "object" || report.schemaVersion !== 1) throw new Error("Worker report invalide");
  if (typeof report.workerId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(report.workerId)) throw new Error("workerId invalide");
  if (!["codex", "claude", "glm"].includes(report.provider)) throw new Error("provider invalide");
  if (!["offline", "idle", "claimed", "running", "verifying", "blocked", "failed"].includes(report.state)) throw new Error("state invalide");
  if (!Number.isSafeInteger(report.sequence) || report.sequence < 0) throw new Error("sequence invalide");
  if (!Number.isFinite(Date.parse(report.timestamp))) throw new Error("timestamp invalide");
  if (report.fencingToken !== undefined && (!Number.isSafeInteger(report.fencingToken) || report.fencingToken < 0)) {
    throw new Error("fencingToken invalide");
  }
  if (report.headSha !== undefined && !SHA.test(report.headSha)) throw new Error("headSha invalide");

  const active = ["claimed", "running", "verifying"].includes(report.state);
  if (active && (!report.taskId || report.fencingToken === undefined)) {
    throw new Error("Un worker actif doit fournir taskId et fencingToken");
  }

  if (report.progress) {
    if (typeof report.progress.phase !== "string" || report.progress.phase.length === 0) throw new Error("phase invalide");
    if (!Number.isSafeInteger(report.progress.completed) || report.progress.completed < 0) throw new Error("progress invalide");
    if (
      report.progress.total !== undefined &&
      (!Number.isSafeInteger(report.progress.total) ||
        report.progress.total < 0 ||
        report.progress.completed > report.progress.total)
    ) throw new Error("progress.total invalide");
  }
}

export function acceptWorkerReport(previousSequence: number | null, report: ChefWorkerReport): void {
  validateWorkerReport(report);
  if (previousSequence !== null && report.sequence <= previousSequence) {
    throw new Error("Rapport worker dupliqué ou arrivé dans le désordre");
  }
}
