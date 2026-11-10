import { spawn } from "node:child_process";

/** The caller must persist a block and stop this worker instead of retrying. */
export class ChefProcessStopUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChefProcessStopUnconfirmedError";
  }
}

export interface ChefProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  label: string;
  abortMessage: string;
  timeoutMessage: string;
  /** Trusted runtime configuration; never a model-controlled setting. */
  terminationGraceMs?: number;
  terminationConfirmationMs?: number;
}

export interface ChefProcessResult {
  stdout: string;
  stderr: string;
  output: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Owns one dedicated POSIX process group. Completion/rejection is withheld until
 * the direct child is closed and its group no longer exists. This is lifecycle
 * containment for trusted bridges, not a sandbox against code escaping its group.
 */
export async function runChefProcess(options: ChefProcessOptions): Promise<ChefProcessResult> {
  if (options.signal?.aborted) throw new Error(options.abortMessage);
  if (process.platform === "win32") {
    throw new ChefProcessStopUnconfirmedError(
      `${options.label}: confinement du groupe non disponible sur Windows; aucun processus lancé`
    );
  }
  const graceMs = options.terminationGraceMs ?? 2_000;
  const confirmationMs = options.terminationConfirmationMs ?? 2_000;
  for (const value of [options.timeoutMs, graceMs, confirmationMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new Error("Durée de processus CHEF invalide");
    }
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
    throw new Error("Limite de sortie CHEF invalide");
  }

  return await new Promise<ChefProcessResult>((resolve, reject) => {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      // setsid(2): negative-PID signals below can never target the parent's group.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const output: Buffer[] = [];
    let outputBytes = 0;
    let closed = false;
    let settled = false;
    let stopReason: Error | undefined;
    let stopFailure: string | undefined;
    let operationTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let confirmationTimer: NodeJS.Timeout | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let orphanTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(operationTimer);
      clearTimeout(forceTimer);
      clearTimeout(confirmationTimer);
      clearTimeout(orphanTimer);
      clearInterval(pollTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error instanceof ChefProcessStopUnconfirmedError) {
        // Do not leave the caller waiting forever on inherited stdio. The block
        // remains explicit; destroying handles is not claimed as process death.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      reject(error);
    };
    const groupState = (): "gone" | "present" | "unknown" => {
      const pid = child.pid;
      if (pid === undefined) return "gone";
      if (pid <= 1 || pid === process.pid) return "unknown";
      try {
        process.kill(-pid, 0);
        return "present";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
      }
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (pid <= 1 || pid === process.pid) {
        stopFailure = "identifiant du groupe non vérifiable";
        return;
      }
      try {
        // Signal the whole group even if its original leader has already exited.
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          stopFailure = error instanceof Error ? error.message : "signal refusé";
        }
      }
    };
    const checkStopped = () => {
      if (stopReason && closed && groupState() === "gone") fail(stopReason);
    };
    const requestStop = (reason: Error) => {
      if (settled || stopReason) return;
      stopReason = reason;
      clearTimeout(operationTimer);
      clearTimeout(orphanTimer);
      signalGroup("SIGTERM");
      forceTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        checkStopped();
      }, graceMs);
      confirmationTimer = setTimeout(() => {
        checkStopped();
        if (!settled) {
          fail(new ChefProcessStopUnconfirmedError(
            `${options.label}: arrêt du groupe non confirmé (pid=${child.pid ?? "inconnu"}); ` +
            `intervention requise: ${reason.message}${stopFailure ? `; ${stopFailure}` : ""}`
          ));
        }
      }, graceMs + confirmationMs);
      // These timers stay referenced: an unresolved Promise does not keep Node alive.
      pollTimer = setInterval(checkStopped, 25);
      checkStopped();
    };
    const onAbort = () => requestStop(new Error(options.abortMessage));
    const append = (target: Buffer[], chunk: Buffer) => {
      if (settled || stopReason) return;
      if (outputBytes + chunk.length > options.maxOutputBytes) {
        requestStop(new Error(`Sortie ${options.label} trop volumineuse`));
        return;
      }
      outputBytes += chunk.length;
      target.push(chunk);
      output.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.stdin.on("error", (error) => requestStop(error));
    child.on("error", (error) => {
      // Failed spawn: there never was a process group to stop.
      if (child.pid === undefined) fail(error);
      else requestStop(error);
    });
    child.on("exit", () => {
      // A descendant can keep the pipes open after its leader exits. Do not wait
      // for the ordinary work timeout before stopping a leftover group.
      if (!settled && !stopReason) {
        orphanTimer = setTimeout(() => {
          if (!settled && !stopReason && groupState() !== "gone") {
            requestStop(new Error(`${options.label}: descendants encore actifs après la sortie`));
          }
        }, 25);
      }
    });
    child.on("close", (exitCode, signal) => {
      closed = true;
      if (settled) return;
      if (stopReason) {
        checkStopped();
        return;
      }
      if (groupState() !== "gone") {
        requestStop(new Error(`${options.label}: descendants encore actifs après la sortie`));
        return;
      }
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        output: Buffer.concat(output),
        exitCode,
        signal,
      });
    });

    operationTimer = setTimeout(() => requestStop(new Error(options.timeoutMessage)), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Covers an abort occurring between the first check and listener installation.
    if (options.signal?.aborted) onAbort();
    if (!stopReason) child.stdin.end(options.input);
    else child.stdin.destroy();
  });
}
