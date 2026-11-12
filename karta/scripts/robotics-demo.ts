import { planRobotSession } from "../src/robotics/session.js";
import { RobotSessionSimulator } from "../src/robotics/simulator.js";

// Original PURAMA reflection script, not a quotation or claim of spiritual authority.
const session = {
  version: 1, sessionId: "presence-demo", targetId: "purama-simulator", expiresAt: Date.now() + 60_000,
  steps: [
    { id: "welcome", kind: "speech", text: "Bienvenue. Vous pouvez interrompre cette séance à tout moment.", durationMs: 5_000 },
    { id: "greeting", kind: "gesture", gesture: "greeting", durationMs: 2_000 },
    { id: "reflection", kind: "speech", text: "Prenez un instant pour observer ce qui vous entoure, sans chercher de résultat particulier.", durationMs: 7_000 },
    { id: "silence", kind: "pause", durationMs: 10_000 },
  ],
};

console.log(JSON.stringify({
  notice: "SIMULATION UNIQUEMENT — aucun robot connecté, aucun son émis.",
  optimus: planRobotSession({ ...session, targetId: "tesla-optimus" }),
  simulation: await new RobotSessionSimulator().run(session, { userId: "demo", mode: "simulation" }),
}, null, 2));
