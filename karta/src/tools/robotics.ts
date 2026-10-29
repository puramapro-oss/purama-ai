import type { ToolDefinition } from "../engine/types.js";
import { getRobotTarget, listRobotTargets } from "../robotics/catalog.js";
import { planRobotSession, RobotSessionError } from "../robotics/session.js";
import { RobotSessionSimulator } from "../robotics/simulator.js";

function requireUser(userId: string): void {
  if (!userId?.trim()) throw new RobotSessionError("UNAUTHENTICATED", "Contexte utilisateur KARTA requis.");
}

export const robotCatalogTool: ToolDefinition<Record<string, unknown>> = {
  name: "robot_catalog",
  description: "Consulte les cibles robotiques et interfaces documentées. Aucune marque n'est annoncée raccordée ; aucun contrôle matériel.",
  sensitive: false,
  async execute(params, ctx) {
    requireUser(ctx.userId);
    if (!params || typeof params !== "object" || Array.isArray(params)
      || Object.keys(params).some((key) => key !== "targetId")
      || (params.targetId !== undefined && typeof params.targetId !== "string")) {
      throw new RobotSessionError("INVALID_REQUEST", "Seul targetId optionnel est accepté.");
    }
    const target = typeof params.targetId === "string" ? getRobotTarget(params.targetId) : undefined;
    if (typeof params.targetId === "string" && !target) throw new RobotSessionError("UNKNOWN_TARGET", "Modèle inconnu.");
    return { ok: true, execution: "not_executed", hardwareControlAvailable: false, targets: target ? [target] : listRobotTargets() };
  },
};

export const robotPlanSessionTool: ToolDefinition<Record<string, unknown>> = {
  name: "robot_plan_session",
  description: "Vérifie une séance version 1 (sessionId, targetId, expiresAt, steps). Planifie parole, gestes nommés et pauses ; ne commande jamais un robot.",
  sensitive: false,
  async execute(params, ctx) {
    requireUser(ctx.userId);
    const plan = planRobotSession(params);
    if (!plan.ok) return {
      ok: false, execution: "not_executed", error: plan.blockers.map((b) => b.detail).join(" "), plan,
    };
    return plan;
  },
};

const simulator = new RobotSessionSimulator();

export const robotSimulateSessionTool: ToolDefinition<Record<string, unknown>> = {
  name: "robot_simulate_session",
  description: "Calcule une chronologie simulée sur purama-simulator. Accepte la même séance version 1 que robot_plan_session. Toujours logiciel, même si KARTA est en mode live : aucun son, mouvement ou appel réseau. Le dry-run global KARTA saute cet outil.",
  sensitive: false,
  async execute(params, ctx) {
    return simulator.run(params, ctx);
  },
};
