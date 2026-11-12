import { describe, expect, it, vi } from "vitest";
import { exportQuantumCircuitOpenQasm } from "../src/quantum/openqasm.js";
import {
  QUANTUM_LIMITS, parseQuantumCircuit, simulateQuantumCircuit,
  type QuantumCircuitInput, type QuantumGate,
} from "../src/quantum/simulator.js";

function run(qubits: number, gates: QuantumGate[], shots = 0) {
  return simulateQuantumCircuit({ qubits, gates, shots, seed: 42 });
}

function close(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 12));
}

describe("local quantum statevector: analytic reference circuits", () => {
  it("starts in |0> and uses q0 as the least significant bit", () => {
    close(run(3, []).probabilities, [1, 0, 0, 0, 0, 0, 0, 0]);
    close(run(3, [{ gate: "X", target: 0 }]).probabilities, [0, 1, 0, 0, 0, 0, 0, 0]);
    close(run(3, [{ gate: "X", target: 2 }]).probabilities, [0, 0, 0, 0, 1, 0, 0, 0]);
  });

  it("prepares Bell entanglement with correlated final measurements", () => {
    const bell = run(2, [{ gate: "H", target: 0 }, { gate: "CX", control: 0, target: 1 }], 4096);
    close(bell.probabilities, [0.5, 0, 0, 0.5]);
    expect(Object.keys(bell.counts).sort()).toEqual(["00", "11"]);
    expect(bell.counts["00"] + bell.counts["11"]).toBe(4096);
    expect(bell.counts["00"] / 4096).toBeGreaterThan(0.47);
    expect(bell.counts["00"] / 4096).toBeLessThan(0.53);
  });

  it("prepares a GHZ state and handles control above target", () => {
    const ghz = run(4, [
      { gate: "H", target: 3 }, { gate: "CX", control: 3, target: 2 },
      { gate: "CX", control: 2, target: 1 }, { gate: "CX", control: 1, target: 0 },
    ]);
    close(ghz.probabilities, [0.5, ...Array<number>(14).fill(0), 0.5]);
  });

  it.each(["H", "X", "Y", "Z"] as const)("conserves probability through %s and its inverse", gate => {
    close(run(1, [{ gate, target: 0 }, { gate, target: 0 }]).probabilities, [1, 0]);
  });

  it("turns Z phase into observable destructive interference", () => {
    close(run(1, [{ gate: "H", target: 0 }, { gate: "Z", target: 0 }, { gate: "H", target: 0 }]).probabilities, [0, 1]);
  });

  it("handles Y's imaginary amplitudes in an interference circuit", () => {
    // RY(pi/2)|0> is |+>; Y rotates it to |- > up to global phase.
    close(run(1, [
      { gate: "RY", target: 0, angle: Math.PI / 2 }, { gate: "Y", target: 0 }, { gate: "H", target: 0 },
    ]).probabilities, [0, 1]);
  });

  it.each(["RX", "RY"] as const)("matches the analytical %s probabilities", gate => {
    close(run(1, [{ gate, target: 0, angle: Math.PI / 3 }]).probabilities, [0.75, 0.25]);
    close(run(1, [{ gate, target: 0, angle: Math.PI }]).probabilities, [0, 1]);
  });

  it("makes a relative RZ phase observable through Hadamards", () => {
    close(run(1, [
      { gate: "H", target: 0 }, { gate: "RZ", target: 0, angle: Math.PI / 3 }, { gate: "H", target: 0 },
    ]).probabilities, [0.75, 0.25]);
  });

  it.each(["RX", "RY", "RZ"] as const)("cancels an arbitrary %s rotation with its inverse", gate => {
    close(run(1, [
      { gate: "H", target: 0 }, { gate, target: 0, angle: 1.2345 },
      { gate, target: 0, angle: -1.2345 }, { gate: "H", target: 0 },
    ]).probabilities, [1, 0]);
  });

  it("CZ plus target Hadamards implements controlled X", () => {
    close(run(2, [
      { gate: "X", target: 0 }, { gate: "H", target: 1 },
      { gate: "CZ", control: 0, target: 1 }, { gate: "H", target: 1 },
    ]).probabilities, [0, 0, 0, 1]);
    close(run(2, [
      { gate: "H", target: 1 }, { gate: "CZ", control: 0, target: 1 }, { gate: "H", target: 1 },
    ]).probabilities, [1, 0, 0, 0]);
  });

  it("supports the full bounded workload, preserving norm and sample total", () => {
    const gates: QuantumGate[] = Array.from({ length: QUANTUM_LIMITS.max_gates }, (_, index) => ({
      gate: "RY", target: index % QUANTUM_LIMITS.max_qubits, angle: index / 13,
    }));
    const result = run(QUANTUM_LIMITS.max_qubits, gates, QUANTUM_LIMITS.max_shots);
    expect(result.probabilities).toHaveLength(1 << QUANTUM_LIMITS.max_qubits);
    expect(result.state_norm_squared).toBeCloseTo(1, 12);
    expect(result.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(Object.values(result.counts).reduce((a, b) => a + b, 0)).toBe(QUANTUM_LIMITS.max_shots);
    expect(result.probabilities.every(p => p >= 0 && p <= 1)).toBe(true);
  });

  it("records deterministic sampling and a canonical input fingerprint", () => {
    const a = simulateQuantumCircuit({ qubits: 2, gates: [{ gate: "H", target: 0 }], shots: 1000, seed: 31 });
    const b = simulateQuantumCircuit({ seed: 31, gates: [{ target: 0, gate: "H" }], shots: 1000, qubits: 2 });
    const c = simulateQuantumCircuit({ qubits: 2, gates: [{ gate: "H", target: 0 }], shots: 1000, seed: 32 });
    expect(a).toEqual(b);
    expect(a.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.input_sha256).not.toBe(a.input_sha256);
    expect(c.counts).not.toEqual(a.counts);
    expect(c.probabilities).toEqual(a.probabilities);
    expect(a.provenance.sampling).toBe("mulberry32_noncryptographic");
  });

  it("provides probabilities alone when shots is zero and reproducible defaults", () => {
    expect(run(1, [{ gate: "H", target: 0 }]).counts).toEqual({});
    const defaults = simulateQuantumCircuit({ qubits: 1, gates: [] });
    expect(defaults.shots).toBe(1024);
    expect(defaults.seed).toBe(0);
    expect(defaults.counts).toEqual({ "0": 1024 });
    expect(defaults.input_sha256).toBe(simulateQuantumCircuit({ qubits: 1, gates: [], shots: 1024, seed: 0 }).input_sha256);
  });
});

describe("strict circuit validation", () => {
  const valid = { qubits: 2, gates: [] };
  it.each([
    null, undefined, true, "circuit", [], 12,
    {}, { qubits: 2 }, { gates: [] },
    { ...valid, qubits: "2" }, { ...valid, qubits: NaN }, { ...valid, qubits: Infinity },
    { ...valid, qubits: 0 }, { ...valid, qubits: QUANTUM_LIMITS.max_qubits + 1 }, { ...valid, qubits: 2.5 },
    { ...valid, gates: {} }, { ...valid, gates: null },
    { ...valid, gates: Array(QUANTUM_LIMITS.max_gates + 1).fill({ gate: "H", target: 0 }) },
    { ...valid, shots: -1 }, { ...valid, shots: NaN }, { ...valid, shots: Infinity },
    { ...valid, shots: QUANTUM_LIMITS.max_shots + 1 }, { ...valid, shots: 0.5 },
    { ...valid, shots: null }, { ...valid, shots: undefined },
    { ...valid, seed: -1 }, { ...valid, seed: 0x1_0000_0000 }, { ...valid, seed: 0.2 },
    { ...valid, seed: undefined }, { ...valid, seed: "1" },
    { ...valid, backend: "ibm" }, { ...valid, arbitrary: "private-value-never-echoed" },
    JSON.parse('{"qubits":2,"gates":[],"__proto__":{"polluted":true}}') as unknown,
  ])("rejects malformed or excessive top-level parameters without echoing them", input => {
    expect(() => simulateQuantumCircuit(input)).toThrow("Circuit quantique invalide");
    expect(() => simulateQuantumCircuit(input)).not.toThrow("private-value-never-echoed");
  });

  it.each([
    null, undefined, [], "H", {},
    { gate: "S", target: 0 }, { gate: "h", target: 0 }, { gate: "H", target: "0" },
    { gate: "H", target: -1 }, { gate: "H", target: 2 }, { gate: "H", target: 0.1 },
    { gate: "H", target: 0, angle: 0 }, { gate: "X", target: 0, control: undefined },
    { gate: "RX", target: 0 }, { gate: "RY", target: 0, angle: NaN },
    { gate: "RZ", target: 0, angle: Infinity }, { gate: "RZ", target: 0, angle: "1" },
    { gate: "RX", target: 0, angle: QUANTUM_LIMITS.max_abs_angle_radians + 1 },
    { gate: "RX", target: 0, angle: -QUANTUM_LIMITS.max_abs_angle_radians - 1 },
    { gate: "RY", target: 0, angle: 1, control: 1 },
    { gate: "CX", target: 0, control: 0 }, { gate: "CZ", target: 0, control: 2 },
    { gate: "CX", target: 0 }, { gate: "CZ", target: 0, control: 1, angle: 0 },
    { gate: "H", target: 0, extra: true },
  ])("rejects invalid gate variants and repeated control/target indices", gate => {
    expect(() => run(2, [gate as QuantumGate])).toThrow("Circuit quantique invalide");
  });

  it("accepts finite angle, uint32 seed and workload boundaries", () => {
    const result = simulateQuantumCircuit({
      qubits: 1, gates: [{ gate: "RY", target: 0, angle: QUANTUM_LIMITS.max_abs_angle_radians }],
      seed: 0xffff_ffff, shots: 1,
    });
    expect(result.state_norm_squared).toBeCloseTo(1, 12);
  });

  it("rejects getters at every level without invoking them", () => {
    const getter = vi.fn(() => { throw new Error("private-getter-secret"); });
    const top = { ...valid };
    Object.defineProperty(top, "qubits", { enumerable: true, get: getter });
    const gate = { gate: "H" };
    Object.defineProperty(gate, "target", { enumerable: true, get: getter });
    const gates: unknown[] = [];
    Object.defineProperty(gates, "0", { enumerable: true, get: getter });
    for (const input of [top, { ...valid, gates: [gate] }, { ...valid, gates }]) {
      expect(() => simulateQuantumCircuit(input)).toThrow("Circuit quantique invalide");
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects proxies, including revoked proxies, before their traps can execute", () => {
    const trap = vi.fn(() => { throw new Error("private-proxy-secret"); });
    const proxy = new Proxy(valid, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    const nested = new Proxy([], { get: trap, getPrototypeOf: trap, ownKeys: trap });
    const revoked = Proxy.revocable(valid, {});
    revoked.revoke();
    for (const input of [proxy, revoked.proxy, { ...valid, gates: nested }]) {
      expect(() => simulateQuantumCircuit(input)).toThrow("Circuit quantique invalide");
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it("rejects prototype, symbol, hidden property, sparse and decorated-array tricks", () => {
    const sparse = new Array(1);
    const decorated = Object.assign([], { extra: 1 });
    const hidden = Object.defineProperty({ ...valid }, "hidden", { value: 1 });
    const gateArray = [{ gate: "H", target: 0 }];
    Object.defineProperty(gateArray, Symbol.iterator, { value: () => { throw new Error("not called"); } });
    class CustomArray extends Array {}
    for (const input of [
      Object.create(valid) as unknown,
      { ...valid, [Symbol("extra")]: 1 }, hidden,
      { ...valid, gates: sparse }, { ...valid, gates: decorated }, { ...valid, gates: new CustomArray() },
      { ...valid, gates: gateArray }, { ...valid, gates: [Object.create({ gate: "H", target: 0 })] },
    ]) expect(() => simulateQuantumCircuit(input)).toThrow("Circuit quantique invalide");
  });

  it("snapshots valid plain data, including null-prototype maps", () => {
    const input: QuantumCircuitInput = { qubits: 1, gates: [{ gate: "X", target: 0 }] };
    const parsed = parseQuantumCircuit(input);
    input.gates[0].target = 3;
    input.gates.push({ gate: "Z", target: 0 });
    expect(parsed.gates).toEqual([{ gate: "X", target: 0 }]);
    const data = Object.assign(Object.create(null) as Record<string, unknown>, { qubits: 1, gates: [] });
    expect(simulateQuantumCircuit(data).counts).toEqual({ "0": 1024 });
  });
});

describe("OpenQASM portability", () => {
  it("exports bounded circuits with explicit register ordering and final measurement", () => {
    expect(exportQuantumCircuitOpenQasm({ qubits: 2, gates: [
      { gate: "H", target: 0 }, { gate: "CX", control: 0, target: 1 },
      { gate: "RZ", target: 1, angle: 1e-8 },
    ] })).toBe('OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[2];\ncreg c[2];\nh q[0];\ncx q[0],q[1];\nrz(1.0e-8) q[1];\nmeasure q -> c;\n');
  });

  it("applies the same validation before exporting", () => {
    expect(() => exportQuantumCircuitOpenQasm({ qubits: 2, gates: [{ gate: 'h; include "secret";', target: 0 }] })).toThrow("Circuit quantique invalide");
  });
});
