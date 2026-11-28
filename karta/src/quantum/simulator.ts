import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

/** Deliberately small: this tool runs inside KARTA's process, not a worker/QPU. */
export const QUANTUM_LIMITS = Object.freeze({
  max_qubits: 10,
  max_gates: 128,
  max_shots: 8192,
  max_abs_angle_radians: 1_000_000,
});

export type QuantumGate =
  | { gate: "H" | "X" | "Y" | "Z"; target: number }
  | { gate: "RX" | "RY" | "RZ"; target: number; angle: number }
  | { gate: "CX" | "CZ"; target: number; control: number };

export interface QuantumCircuitInput {
  qubits: number;
  gates: QuantumGate[];
  /** 0 returns exact statevector probabilities without sampled counts. */
  shots?: number;
  /** Reproducible uint32 seed, default 0. Never use this RNG for security. */
  seed?: number;
}

interface ValidatedCircuit {
  qubits: number;
  gates: QuantumGate[];
  shots: number;
  seed: number;
}

export interface QuantumSimulationResult {
  execution_kind: "local_simulator";
  backend_kind: "classical_statevector";
  physical_quantum_hardware: false;
  quantum_advantage_demonstrated: false;
  external_api_calls: 0;
  qubits: number;
  gate_count: number;
  shots: number;
  seed: number;
  /** Ascending basis index. Qubit 0 is the least significant bit. */
  probabilities: number[];
  /** Final computational-basis samples; bitstrings are q[n-1]...q[0]. */
  counts: Record<string, number>;
  state_norm_squared: number;
  input_sha256: string;
  provenance: {
    implementation: "purama-karta-statevector";
    implementation_version: "1";
    arithmetic: "float64_complex";
    initial_state: "all_zero";
    bit_order: "q0_least_significant";
    measurement: "final_computational_basis";
    sampling: "mulberry32_noncryptographic";
    input_hash_format: "sha256_canonical_validated_json_v1";
    limits: typeof QUANTUM_LIMITS;
  };
}

const INVALID_INPUT = "Circuit quantique invalide : paramètres ou limites non respectés.";

/** Read descriptors rather than properties. Accessors and proxies are not JSON. */
function plainData(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value) || Array.isArray(value)) {
    throw new Error(INVALID_INPUT);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new Error(INVALID_INPUT);
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new Error(INVALID_INPUT);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error(INVALID_INPUT);
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function denseGateArray(value: unknown): unknown[] {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value) ||
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(INVALID_INPUT);
  }
  const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length > QUANTUM_LIMITS.max_gates ||
    Reflect.ownKeys(value).length !== length + 1) throw new Error(INVALID_INPUT);
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error(INVALID_INPUT);
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(INVALID_INPUT);
  }
  return value;
}

/** Snapshot the complete input before arithmetic or hashing; do not coerce data. */
export function parseQuantumCircuit(value: unknown): ValidatedCircuit {
  try {
    const input = plainData(value, ["qubits", "gates", "shots", "seed"]);
    const qubits = integer(input.qubits, 1, QUANTUM_LIMITS.max_qubits);
    const gates = denseGateArray(input.gates).map((raw): QuantumGate => {
      const gate = plainData(raw, ["gate", "target", "control", "angle"]);
      const target = integer(gate.target, 0, qubits - 1);
      switch (gate.gate) {
        case "H": case "X": case "Y": case "Z":
          if (Object.hasOwn(gate, "angle") || Object.hasOwn(gate, "control")) throw new Error(INVALID_INPUT);
          return { gate: gate.gate, target };
        case "RX": case "RY": case "RZ": {
          if (Object.hasOwn(gate, "control") || typeof gate.angle !== "number" ||
            !Number.isFinite(gate.angle) || Math.abs(gate.angle) > QUANTUM_LIMITS.max_abs_angle_radians) {
            throw new Error(INVALID_INPUT);
          }
          return { gate: gate.gate, target, angle: gate.angle };
        }
        case "CX": case "CZ": {
          const control = integer(gate.control, 0, qubits - 1);
          if (control === target || Object.hasOwn(gate, "angle")) throw new Error(INVALID_INPUT);
          return { gate: gate.gate, target, control };
        }
        default: throw new Error(INVALID_INPUT);
      }
    });
    return {
      qubits,
      gates,
      shots: Object.hasOwn(input, "shots") ? integer(input.shots, 0, QUANTUM_LIMITS.max_shots) : 1024,
      seed: Object.hasOwn(input, "seed") ? integer(input.seed, 0, 0xffff_ffff) : 0,
    };
  } catch {
    // Never copy an untrusted value, getter error or credential into tool traces.
    throw new Error(INVALID_INPUT);
  }
}

/** [re00, im00, re01, im01, re10, im10, re11, im11], row-major. */
type Matrix = readonly [number, number, number, number, number, number, number, number];

function oneQubitMatrix(gate: Exclude<QuantumGate, { control: number }>): Matrix {
  switch (gate.gate) {
    case "H": return [Math.SQRT1_2, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0, -Math.SQRT1_2, 0];
    case "X": return [0, 0, 1, 0, 1, 0, 0, 0];
    case "Y": return [0, 0, 0, -1, 0, 1, 0, 0];
    case "Z": return [1, 0, 0, 0, 0, 0, -1, 0];
    case "RX": {
      const c = Math.cos(gate.angle / 2), s = Math.sin(gate.angle / 2);
      return [c, 0, 0, -s, 0, -s, c, 0];
    }
    case "RY": {
      const c = Math.cos(gate.angle / 2), s = Math.sin(gate.angle / 2);
      return [c, 0, -s, 0, s, 0, c, 0];
    }
    case "RZ": {
      const c = Math.cos(gate.angle / 2), s = Math.sin(gate.angle / 2);
      return [c, -s, 0, 0, 0, 0, c, s];
    }
  }
}

function applyMatrix(real: Float64Array, imag: Float64Array, target: number, matrix: Matrix): void {
  const mask = 1 << target;
  const [a, b, c, d, e, f, g, h] = matrix;
  for (let zero = 0; zero < real.length; zero++) {
    if ((zero & mask) !== 0) continue;
    const one = zero | mask;
    const r0 = real[zero], i0 = imag[zero], r1 = real[one], i1 = imag[one];
    real[zero] = a * r0 - b * i0 + c * r1 - d * i1;
    imag[zero] = a * i0 + b * r0 + c * i1 + d * r1;
    real[one] = e * r0 - f * i0 + g * r1 - h * i1;
    imag[one] = e * i0 + f * r0 + g * i1 + h * r1;
  }
}

function applyControlled(real: Float64Array, imag: Float64Array, gate: Extract<QuantumGate, { control: number }>): void {
  const controlMask = 1 << gate.control, targetMask = 1 << gate.target;
  for (let index = 0; index < real.length; index++) {
    if ((index & controlMask) === 0) continue;
    if (gate.gate === "CZ") {
      if ((index & targetMask) !== 0) { real[index] *= -1; imag[index] *= -1; }
    } else if ((index & targetMask) === 0) {
      const other = index | targetMask;
      [real[index], real[other]] = [real[other], real[index]];
      [imag[index], imag[other]] = [imag[other], imag[index]];
    }
  }
}

/** Mulberry32: deterministic sampling only, explicitly not cryptographic. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function sampleCounts(probabilities: number[], qubits: number, shots: number, seed: number): Record<string, number> {
  const counts: Record<string, number> = {};
  const cumulative: number[] = [];
  let sum = 0;
  for (const probability of probabilities) { sum += probability; cumulative.push(sum); }
  cumulative[cumulative.length - 1] = 1;
  const random = seededRandom(seed);
  for (let shot = 0; shot < shots; shot++) {
    const draw = random();
    let low = 0, high = cumulative.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (draw < cumulative[middle]) high = middle;
      else low = middle + 1;
    }
    const bits = low.toString(2).padStart(qubits, "0");
    counts[bits] = (counts[bits] ?? 0) + 1;
  }
  return counts;
}

/**
 * Pure-state, noiseless circuit simulation from |0...0>. "Exact" describes the
 * statevector method: floating-point rounding still exists. Final measurement
 * only; no arbitrary initial amplitudes, resets, mid-circuit measurement or QPU.
 */
export function simulateQuantumCircuit(value: unknown): QuantumSimulationResult {
  const input = parseQuantumCircuit(value);
  const dimension = 1 << input.qubits;
  const real = new Float64Array(dimension), imag = new Float64Array(dimension);
  real[0] = 1;
  for (const gate of input.gates) {
    if ("control" in gate) applyControlled(real, imag, gate);
    else applyMatrix(real, imag, gate.target, oneQubitMatrix(gate));
  }
  const probabilities = Array.from(real, (value, index) => value * value + imag[index] * imag[index]);
  const norm = probabilities.reduce((total, probability) => total + probability, 0);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-10) {
    throw new Error("Simulation quantique invalide : norme de l'état non conservée.");
  }
  // Normalize only numerical drift after checking unitarity, never hide a bad state.
  for (let index = 0; index < probabilities.length; index++) probabilities[index] /= norm;
  return {
    execution_kind: "local_simulator",
    backend_kind: "classical_statevector",
    physical_quantum_hardware: false,
    quantum_advantage_demonstrated: false,
    external_api_calls: 0,
    qubits: input.qubits,
    gate_count: input.gates.length,
    shots: input.shots,
    seed: input.seed,
    probabilities,
    counts: sampleCounts(probabilities, input.qubits, input.shots, input.seed),
    state_norm_squared: norm,
    input_sha256: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    provenance: {
      implementation: "purama-karta-statevector",
      implementation_version: "1",
      arithmetic: "float64_complex",
      initial_state: "all_zero",
      bit_order: "q0_least_significant",
      measurement: "final_computational_basis",
      sampling: "mulberry32_noncryptographic",
      input_hash_format: "sha256_canonical_validated_json_v1",
      limits: QUANTUM_LIMITS,
    },
  };
}
