import { parseQuantumCircuit } from "./simulator.js";

/**
 * Portable OpenQASM 2 circuit, including final computational-basis measurement.
 * Export is text only: no provider/account is contacted and no job is submitted.
 */
export function exportQuantumCircuitOpenQasm(value: unknown): string {
  const input = parseQuantumCircuit(value);
  const lines = [
    "OPENQASM 2.0;",
    'include "qelib1.inc";',
    `qreg q[${input.qubits}];`,
    `creg c[${input.qubits}];`,
  ];
  for (const gate of input.gates) {
    const name = gate.gate.toLowerCase();
    if ("angle" in gate) {
      // OQ2 real-number grammar requires a decimal point before an exponent.
      const angle = String(gate.angle).replace(/^(-?\d+)(e[+-]?\d+)$/i, "$1.0$2");
      lines.push(`${name}(${angle}) q[${gate.target}];`);
    } else if ("control" in gate) {
      lines.push(`${name} q[${gate.control}],q[${gate.target}];`);
    } else lines.push(`${name} q[${gate.target}];`);
  }
  lines.push("measure q -> c;");
  return lines.join("\n") + "\n";
}
