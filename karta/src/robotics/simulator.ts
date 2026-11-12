import { createHash } from "node:crypto";
import { parseSessionRequest, planRobotSession, RobotSessionError } from "./session.js";

export interface SimulatorContext { userId: string; mode: "simulation" | "live" }
export interface SimulationReceipt {
  ok: boolean;
  execution: "simulation";
  physicalActions: 0;
  status: "simulated" | "cancelled" | "expired";
  sessionId: string;
  targetId: "purama-simulator";
  events: Array<{ stepId: string; kind: string; startsAtMs: number; endsAtMs: number }>;
}

interface CachedRun { hash: string; expiresAt: number; result: Promise<SimulationReceipt> }

/** In-memory replay protection for simulation only; never a distributed robot lease. */
export class RobotSessionSimulator {
  private readonly runs = new Map<string, CachedRun>();
  private readonly owners = new Set<string>();

  constructor(private readonly clock: () => number = Date.now, private readonly capacity = 100) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000) {
      throw new RobotSessionError("INVALID_CAPACITY", "Capacité du simulateur invalide.");
    }
  }

  async run(input: unknown, context: SimulatorContext, signal?: AbortSignal): Promise<SimulationReceipt> {
    // KARTA's global simulation mode skips tools. A live engine call may run this
    // software simulator, but can never turn it into a physical execution path.
    const userId = context?.userId;
    if (typeof userId !== "string" || !userId.trim()
      || !["simulation", "live"].includes(context?.mode)) {
      throw new RobotSessionError("INVALID_CONTEXT", "Contexte utilisateur KARTA requis.");
    }
    const now = this.clock();
    const request = parseSessionRequest(input, now);
    const plan = planRobotSession(request, now);
    if (!plan.ok || request.targetId !== "purama-simulator") {
      throw new RobotSessionError("NO_HARDWARE_ADAPTER", "Aucun adaptateur matériel n'est installé.");
    }
    for (const [key, entry] of this.runs) if (entry.expiresAt <= now) this.runs.delete(key);
    const key = JSON.stringify([userId, request.sessionId]);
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = this.runs.get(key);
    if (existing) {
      if (existing.hash !== hash) throw new RobotSessionError("IDEMPOTENCY_CONFLICT", "Identifiant de séance réutilisé avec un autre contenu.");
      return structuredClone(await existing.result);
    }
    if (this.owners.has(userId)) throw new RobotSessionError("SESSION_BUSY", "Une simulation est déjà active pour cet utilisateur.");
    if (this.runs.size >= this.capacity) throw new RobotSessionError("SIMULATOR_CAPACITY", "Capacité atteinte ; attendre l'expiration des séances.");
    this.owners.add(userId);
    const result = (async (): Promise<SimulationReceipt> => {
      const receipt: SimulationReceipt = {
        ok: true, execution: "simulation", physicalActions: 0, status: "simulated",
        sessionId: request.sessionId, targetId: "purama-simulator", events: [],
      };
      let previousTime = now;
      try {
        for (const step of plan.steps) {
          await Promise.resolve();
          const stepTime = this.clock();
          if (!Number.isSafeInteger(stepTime) || stepTime < previousTime) {
            throw new RobotSessionError("INVALID_CLOCK", "Horloge invalide ou recul pendant la simulation.");
          }
          previousTime = stepTime;
          if (signal?.aborted || stepTime >= request.expiresAt) {
            receipt.ok = false;
            receipt.status = signal?.aborted ? "cancelled" : "expired";
            break;
          }
          // Logical timeline only: no sleeps, SDK calls, audio output, or network requests.
          receipt.events.push({ stepId: step.id, kind: step.kind, startsAtMs: step.startsAtMs, endsAtMs: step.endsAtMs });
        }
        return receipt;
      } finally {
        this.owners.delete(userId);
      }
    })();
    this.runs.set(key, { hash, expiresAt: request.expiresAt, result });
    return structuredClone(await result);
  }
}
