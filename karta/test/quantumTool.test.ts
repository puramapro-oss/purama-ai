import { describe, expect, it, vi } from "vitest";
import { validateToolParams } from "../src/engine/tool-input.js";
import type { ToolExecutionContext } from "../src/engine/types.js";
import { quantumSimulateTool } from "../src/tools/quantum.js";

describe("quantum_simulate tool", () => {
  it.each(["simulation", "live"] as const)("does real local arithmetic in %s, with honest execution provenance", async mode => {
    const network = vi.spyOn(globalThis, "fetch");
    const result = await quantumSimulateTool.execute({ qubits: 1, gates: [{ gate: "X", target: 0 }] }, {
      userId: "test-user", agentType: "email", mode,
    });
    expect(result).toMatchObject({
      karta_execution_mode: mode,
      execution_kind: "local_simulator",
      backend_kind: "classical_statevector",
      physical_quantum_hardware: false,
      quantum_advantage_demonstrated: false,
      external_api_calls: 0,
      probabilities: [0, 1],
      counts: { "1": 1024 },
    });
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });

  it("exposes a schema compatible with KARTA and protects circuit traces", () => {
    expect(() => validateToolParams(quantumSimulateTool, { qubits: 2, gates: [], shots: 0, seed: 7 })).not.toThrow();
    expect(() => validateToolParams(quantumSimulateTool, { qubits: 2, gates: [], backend: "remote" })).toThrow();
    expect(quantumSimulateTool.sensitive).toBe(false);
    expect(quantumSimulateTool.tracePolicy).toBe("metadata_only");
  });

  it("rejects nested invalid data even though the common schema validator is shallow", async () => {
    await expect(quantumSimulateTool.execute({ qubits: 2, gates: [{ gate: "CX", control: 0, target: 0 }] }, {
      userId: "test-user", agentType: "email", mode: "live",
    })).rejects.toThrow("Circuit quantique invalide");
  });

  it("rejects an invalid KARTA mode", async () => {
    const ctx = { userId: "test-user", agentType: "email", mode: "remote" } as unknown as ToolExecutionContext;
    await expect(quantumSimulateTool.execute({ qubits: 1, gates: [] }, ctx)).rejects.toThrow("Mode d'exécution KARTA invalide");
  });
});
