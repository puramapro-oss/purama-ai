import { parseSessionRequest, planRobotSession, RobotSessionError, type SessionRequest, type SessionStep } from "./session.js";

export type PreviewStatus = "idle" | "running" | "paused" | "stopped" | "completed";
export interface PreviewSnapshot {
  status: PreviewStatus;
  elapsedMs: number;
  totalDurationMs: number;
  activeStep: SessionStep | null;
  error: string | null;
  physicalActions: 0;
}

/** Browser-compatible rehearsal clock. No audio, network, motor or timer dependency. */
export class RobotSessionPreview {
  private session?: SessionRequest;
  private status: PreviewStatus = "idle";
  private elapsedMs = 0;
  private totalDurationMs = 0;
  private lastNow = 0;
  private error: string | null = null;

  start(input: unknown, now = Date.now()): PreviewSnapshot {
    if (this.status === "running" || this.status === "paused") {
      throw new RobotSessionError("SESSION_BUSY", "Arrêtez la séance en cours avant d'en commencer une autre.");
    }
    const session = parseSessionRequest(input, now);
    const plan = planRobotSession(session, now);
    if (!plan.ok || session.targetId !== "purama-simulator") {
      throw new RobotSessionError("CONNECTOR_NOT_IMPLEMENTED", "L'aperçu accepte uniquement le simulateur PURAMA.");
    }
    this.session = session;
    this.status = "running";
    this.elapsedMs = 0;
    this.totalDurationMs = plan.totalDurationMs;
    this.lastNow = now;
    this.error = null;
    return this.snapshot();
  }

  tick(now = Date.now()): PreviewSnapshot {
    if (!this.session || !["running", "paused"].includes(this.status)) return this.snapshot();
    if (!Number.isSafeInteger(now) || now < this.lastNow) {
      this.error = "Horloge invalide : aperçu arrêté.";
      return this.stop();
    }
    const remainingMs = this.totalDurationMs - this.elapsedMs;
    // Settle the earliest event on the visual timeline, even if a render tick is late.
    if (this.status === "running" && remainingMs <= now - this.lastNow
      && remainingMs <= this.session.expiresAt - this.lastNow) {
      this.elapsedMs = this.totalDurationMs;
      this.lastNow = now;
      this.status = "completed";
      return this.snapshot();
    }
    if (now >= this.session.expiresAt) {
      this.error = "Séance expirée : lancez un nouvel aperçu.";
      return this.stop();
    }
    if (this.status === "running") this.elapsedMs = Math.min(this.totalDurationMs, this.elapsedMs + now - this.lastNow);
    this.lastNow = now;
    if (this.elapsedMs === this.totalDurationMs) this.status = "completed";
    return this.snapshot();
  }

  pause(now = Date.now()): PreviewSnapshot {
    this.tick(now);
    if (this.status === "running") this.status = "paused";
    return this.snapshot();
  }

  resume(now = Date.now()): PreviewSnapshot {
    this.tick(now);
    if (this.status === "paused") this.status = "running";
    return this.snapshot();
  }

  stop(): PreviewSnapshot {
    if (this.status !== "idle") this.status = "stopped";
    return this.snapshot();
  }

  reset(): PreviewSnapshot {
    if (this.status === "running" || this.status === "paused") {
      throw new RobotSessionError("SESSION_BUSY", "Arrêtez la séance avant de modifier la routine.");
    }
    this.session = undefined;
    this.status = "idle";
    this.elapsedMs = 0;
    this.totalDurationMs = 0;
    this.lastNow = 0;
    this.error = null;
    return this.snapshot();
  }

  snapshot(): PreviewSnapshot {
    let activeStep: SessionStep | null = null;
    let end = 0;
    if (this.status === "running" || this.status === "paused") {
      for (const step of this.session?.steps ?? []) {
        end += step.durationMs;
        if (this.elapsedMs < end) { activeStep = structuredClone(step); break; }
      }
    }
    return { status: this.status, elapsedMs: this.elapsedMs, totalDurationMs: this.totalDurationMs, activeStep, error: this.error, physicalActions: 0 };
  }
}
