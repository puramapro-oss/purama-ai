#!/usr/bin/env python3
"""Compare KARTA's local simulator to Qiskit via portable OpenQASM 2.

No accounts, network requests, QPU jobs or automatic package installation.
Install requirements-quantum-verification.txt in a disposable venv beforehand.
Run from any directory; KARTA's existing node_modules/tsx must be installed.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import random
import subprocess
import sys

from qiskit import qasm2
from qiskit.quantum_info import Statevector


NODE_ADAPTER = r"""
import { readFileSync } from 'node:fs';
import { simulateQuantumCircuit } from './src/quantum/simulator.ts';
import { exportQuantumCircuitOpenQasm } from './src/quantum/openqasm.ts';
const inputs = JSON.parse(readFileSync(0, 'utf8'));
const results = inputs.map(input => {
  const result = simulateQuantumCircuit(input);
  return { result, openqasm2: exportQuantumCircuitOpenQasm(input) };
});
process.stdout.write(JSON.stringify({ node_version: process.versions.node, results }));
"""


def generated_circuit(rng: random.Random, qubits: int, gate_count: int) -> dict:
    names = ["H", "X", "Y", "Z", "RX", "RY", "RZ"]
    if qubits > 1:
        names += ["CX", "CZ"]
    gates = []
    for _ in range(gate_count):
        name = rng.choice(names)
        target = rng.randrange(qubits)
        gate = {"gate": name, "target": target}
        if name in ["RX", "RY", "RZ"]:
            gate["angle"] = rng.uniform(-4 * math.pi, 4 * math.pi)
        elif name in ["CX", "CZ"]:
            gate["control"] = rng.choice([q for q in range(qubits) if q != target])
        gates.append(gate)
    return {"qubits": qubits, "gates": gates, "shots": 0, "seed": 0}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=int, default=64, help="Random circuits in addition to fixed reference cases (1..256).")
    parser.add_argument("--seed", type=int, default=20261112)
    parser.add_argument("--output", type=Path, help="Optional JSON evidence file.")
    args = parser.parse_args()
    if not 1 <= args.cases <= 256:
        parser.error("--cases must be between 1 and 256")

    karta = Path(__file__).resolve().parents[1]
    rng = random.Random(args.seed)
    fixed = [
        ("empty", {"qubits": 1, "gates": []}),
        ("least-significant-qubit", {"qubits": 3, "gates": [{"gate": "X", "target": 0}]}),
        ("bell", {"qubits": 2, "gates": [{"gate": "H", "target": 0}, {"gate": "CX", "control": 0, "target": 1}]}),
        ("ghz-high-control", {"qubits": 4, "gates": [
            {"gate": "H", "target": 3}, {"gate": "CX", "control": 3, "target": 2},
            {"gate": "CX", "control": 2, "target": 1}, {"gate": "CX", "control": 1, "target": 0},
        ]}),
        ("phase-interference", {"qubits": 2, "gates": [
            {"gate": "H", "target": 0}, {"gate": "RY", "target": 1, "angle": 0.731},
            {"gate": "Y", "target": 0}, {"gate": "RX", "target": 1, "angle": -1.234},
            {"gate": "CZ", "control": 1, "target": 0}, {"gate": "RZ", "target": 0, "angle": 2.345},
            {"gate": "Z", "target": 1}, {"gate": "H", "target": 0},
        ]}),
        ("scientific-notation", {"qubits": 1, "gates": [
            {"gate": "RY", "target": 0, "angle": 1e-8}, {"gate": "RZ", "target": 0, "angle": -1e-9},
        ]}),
        ("angle-boundary", {"qubits": 1, "gates": [{"gate": "RX", "target": 0, "angle": 1_000_000}]}),
    ]
    named = [(name, {**circuit, "shots": 0, "seed": 0}) for name, circuit in fixed]
    for index in range(args.cases):
        named.append((f"random-{index:03d}", generated_circuit(rng, rng.randint(1, 8), rng.randint(1, 128))))
    named.append(("maximum-workload", generated_circuit(rng, 10, 128)))
    inputs = [circuit for _, circuit in named]
    serialized = json.dumps(inputs, separators=(",", ":"), allow_nan=False)
    node = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", NODE_ADAPTER],
        input=serialized, text=True, capture_output=True, timeout=60, cwd=karta, check=False,
    )
    if node.returncode:
        raise RuntimeError(f"KARTA oracle adapter failed: {node.stderr[:2000]}")
    actual = json.loads(node.stdout)
    if len(actual["results"]) != len(named):
        raise RuntimeError("KARTA returned the wrong number of results")

    evidence = []
    for (name, circuit_input), item in zip(named, actual["results"], strict=True):
        # Independent parser and state evolution: do not rebuild Qiskit gates
        # from our JSON gate objects or reuse the TypeScript matrix arithmetic.
        circuit = qasm2.loads(item["openqasm2"], strict=True)
        circuit = circuit.remove_final_measurements(inplace=False)
        expected = Statevector.from_instruction(circuit).probabilities()
        result = item["result"]
        probabilities = result["probabilities"]
        if len(expected) != len(probabilities):
            raise RuntimeError(f"Basis dimension mismatch for {name}")
        error = max(abs(float(reference) - observed) for reference, observed in zip(expected, probabilities, strict=True))
        norm_error = abs(result["state_norm_squared"] - 1)
        honest = (result["execution_kind"] == "local_simulator"
                  and result["backend_kind"] == "classical_statevector"
                  and result["physical_quantum_hardware"] is False
                  and result["quantum_advantage_demonstrated"] is False
                  and result["external_api_calls"] == 0)
        evidence.append({
            "name": name,
            "qubits": circuit_input["qubits"],
            "gate_count": len(circuit_input["gates"]),
            "input_sha256": result["input_sha256"],
            "max_abs_probability_error": error,
            "state_norm_squared_error": norm_error,
            "status": "PASS" if error <= 1e-12 and norm_error <= 1e-10 and honest else "FAIL",
        })

    files = ["src/quantum/simulator.ts", "src/quantum/openqasm.ts", "scripts/verify-quantum-qiskit.py"]
    report = {
        "status": "PASS" if all(case["status"] == "PASS" for case in evidence) else "FAIL",
        "oracle": "Qiskit Statevector via strict OpenQASM 2 parser",
        "qpu_used": False,
        "seed": args.seed,
        "case_count": len(evidence),
        "random_case_count": args.cases,
        "max_abs_probability_error": max(case["max_abs_probability_error"] for case in evidence),
        "max_state_norm_squared_error": max(case["state_norm_squared_error"] for case in evidence),
        "probability_tolerance": 1e-12,
        "versions": {
            "python": sys.version.split()[0], "node": actual["node_version"],
            **{name: importlib.metadata.version(name) for name in ["qiskit", "numpy", "scipy", "rustworkx"]},
        },
        "input_set_sha256": hashlib.sha256(serialized.encode()).hexdigest(),
        "source_sha256": {name: hashlib.sha256((karta / name).read_bytes()).hexdigest() for name in files},
        "cases": evidence,
    }
    output = json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    print(output, end="")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
