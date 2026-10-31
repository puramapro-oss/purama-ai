import type { ToolDefinition } from "../engine/types.js";
import { getRobotTarget, listRobotTargets } from "../robotics/catalog.js";
import { parseCatalogRequest, planRobotSession, RobotSessionError } from "../robotics/session.js";
import { RobotSessionSimulator } from "../robotics/simulator.js";
import { robotCatalogInputSchema, robotSessionInputSchema, robotSimulationInputSchema } from "../robotics/schemas.js";

function requireUser(userId: string): void {
  if (typeof userId !== "string" || !userId.trim()) throw new RobotSessionError("UNAUTHENTICATED", "Contexte utilisateur KARTA requis.");
}

export const robotCatalogTool: ToolDefinition<Record<string, unknown>> = {
  name: "robot_catalog",
  description: "Consulte les cibles robotiques et interfaces documentées. Aucune marque n'est annoncée raccordée ; aucun contrôle matériel.",
  sensitive: false,
  inputSchema: robotCatalogInputSchema,
  async execute(params, ctx) {
    requireUser(ctx.userId);
    const { targetId } = parseCatalogRequest(params);
    const target = targetId === undefined ? undefined : getRobotTarget(targetId);
    if (targetId !== undefined && !target) throw new RobotSessionError("UNKNOWN_TARGET", "Modèle inconnu.");
    return { ok: true, execution: "not_executed", hardwareControlAvailable: false, targets: target ? [target] : listRobotTargets() };
  },
};

export const robotPlanSessionTool: ToolDefinition<Record<string, unknown>> = {
  name: "robot_plan_session",
  description: "Vérifie une séance version 1 (sessionId, targetId, expiresAt, steps). Planifie parole, gestes nommés et pauses ; ne commande jamais un robot.",
  sensitive: false,
  inputSchema: robotSessionInputSchema,
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
  inputSchema: robotSimulationInputSchema,
  async execute(params, ctx) {
    return simulator.run(params, ctx);
  },
};
