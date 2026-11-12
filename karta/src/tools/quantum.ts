import type { ToolDefinition, ToolExecutionContext } from "../engine/types.js";
import {
  QUANTUM_LIMITS, simulateQuantumCircuit,
  type QuantumCircuitInput, type QuantumSimulationResult,
} from "../quantum/simulator.js";

export interface QuantumToolResult extends QuantumSimulationResult {
  karta_execution_mode: ToolExecutionContext["mode"];
}

/** Local arithmetic runs in both KARTA modes. Neither mode enables QPU access. */
export const quantumSimulateTool: ToolDefinition<QuantumCircuitInput, QuantumToolResult> = {
  name: "quantum_simulate",
  description: "Simule localement un circuit quantique idéal depuis |0…0>, avec calcul classique borné. " +
    "Aucun processeur quantique physique ni accès réseau. Les probabilités suivent l'index de base " +
    "(q0 bit de poids faible), les counts mesurent tous les qubits en fin de circuit. " +
    "Gates H/X/Y/Z/RX/RY/RZ/CX/CZ ; angles en radians. Ce test ne démontre aucun avantage quantique.",
  sensitive: false,
  tracePolicy: "metadata_only",
  inputSchema: {
    type: "object",
    properties: {
      qubits: { type: "integer", minimum: 1, maximum: QUANTUM_LIMITS.max_qubits },
      gates: {
        type: "array", minItems: 0, maxItems: QUANTUM_LIMITS.max_gates,
        items: {
          type: "object",
          properties: {
            gate: { type: "string", enum: ["H", "X", "Y", "Z", "RX", "RY", "RZ", "CX", "CZ"] },
            target: { type: "integer", minimum: 0, maximum: QUANTUM_LIMITS.max_qubits - 1 },
            control: { type: "integer", minimum: 0, maximum: QUANTUM_LIMITS.max_qubits - 1, description: "Requis uniquement pour CX/CZ ; différent de target." },
            angle: { type: "number", minimum: -QUANTUM_LIMITS.max_abs_angle_radians, maximum: QUANTUM_LIMITS.max_abs_angle_radians, description: "Requis uniquement pour RX/RY/RZ, en radians." },
          },
          required: ["gate", "target"],
          additionalProperties: false,
        },
      },
      shots: { type: "integer", minimum: 0, maximum: QUANTUM_LIMITS.max_shots, description: "Par défaut 1024 ; 0 pour les probabilités sans tirages." },
      seed: { type: "integer", minimum: 0, maximum: 0xffff_ffff, description: "Graine reproductible non cryptographique ; défaut 0." },
    },
    required: ["qubits", "gates"],
    additionalProperties: false,
  },
  async execute(params, ctx) {
    if (ctx.mode !== "simulation" && ctx.mode !== "live") {
      throw new Error("Mode d'exécution KARTA invalide.");
    }
    return { ...simulateQuantumCircuit(params), karta_execution_mode: ctx.mode };
  },
};
