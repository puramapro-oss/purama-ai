#!/usr/bin/env python3
"""Exercise the wrapper's resource/receipt contract with inert Python doubles.

No native protocol scenario is executed. All subprocess creation, signals and
network entry points used by the wrapper are intercepted. Fixture files are
ordinary temporary files; the fake binaries are not executable.

Run the identical tests against any candidate with --wrapper, or set
OUTBOX_WRAPPER_UNDER_TEST when using unittest discovery. --evidence records the
observations before unittest disposes of its temporary fixture directories.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime
import errno
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import traceback
import types
import unittest
import urllib.request
from unittest import mock


HERE = pathlib.Path(__file__).resolve()
DEFAULT_WRAPPER = HERE.with_name("run.py")
WRAPPER_PATH = pathlib.Path(os.environ.get("OUTBOX_WRAPPER_UNDER_TEST", str(DEFAULT_WRAPPER))).resolve()
OBSERVATIONS: list[dict] = []


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class WrapperLifecycleTests(unittest.TestCase):
    def exercise(self, scenario: str) -> dict:
        """Inject a boundary failure and observe the public main() outcome."""
        wrapper_bytes = WRAPPER_PATH.read_bytes()
        wrapper_hash = hashlib.sha256(wrapper_bytes).hexdigest()
        with tempfile.TemporaryDirectory(prefix="inert-wrapper-lifecycle-") as temporary:
            fixture = pathlib.Path(temporary)
            repo = fixture / "repo"
            output = fixture / "output"
            binaries = fixture / "non-executable-fixtures"
            pg_bin = binaries / "pg"
            redis = binaries / "redis-server"
            native_path = repo / "qa/iao-runtime-20261110/native-outbox.py"
            source_name = "karta/src/inert.ts"
            files = {
                source_name: b"export const inertFixture = true;\n",
                "karta/package-lock.json": b'{"lockfileVersion":3,"packages":{}}\n',
                "qa/approval-outbox-live-20261111/approvalOutboxNative.mjs": b"// Inert fixture: never executed.\n",
                "qa/approval-outbox-live-20261111/run.py": wrapper_bytes,
                "qa/iao-runtime-20261110/native-outbox.py": b"# Inert loader supplies the fake Cluster.\n",
                "karta/migrations/001_inert.sql": b"-- Inert text: never submitted to a database.\n",
            }
            for relative, content in files.items():
                path = repo / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                if not (scenario == "source_digest_failure" and relative == source_name):
                    path.write_bytes(content)
            for path in [redis, pg_bin / "postgres", pg_bin / "pg_ctl", pg_bin / "psql"]:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"INERT NON-EXECUTABLE BINARY FIXTURE\n")

            operations: list[dict] = []
            forbidden: list[str] = []
            clusters = []
            children = []

            def reject(operation):
                def blocked(*args, **kwargs):
                    forbidden.append(operation)
                    raise AssertionError("Forbidden real operation attempted: " + operation)
                return blocked

            class FakeCluster:
                def __init__(self, binary):
                    self.root = fixture / ("owned-cluster-" + str(len(clusters)))
                    self.root.mkdir()
                    self.data = self.root / "data"
                    self.log = self.root / "postgres.log"
                    self.started = False
                    self.initialize_calls = 0
                    self.cleanup_calls = 0
                    self.query_calls = 0
                    clusters.append(self)

                def initialize(self):
                    self.initialize_calls += 1
                    self.data.mkdir()
                    self.started = True
                    self.log.write_text("Inert cluster fixture; no server started.\n")

                def query(self, sql, **kwargs):
                    self.query_calls += 1
                    if sql == "SELECT version();":
                        return "INERT_POSTGRES_FIXTURE"
                    return ""

                def cleanup(self):
                    self.cleanup_calls += 1
                    self.started = False
                    shutil.rmtree(self.root)

            class FakeNativeLoader:
                def create_module(self, spec):
                    return None

                def exec_module(self, module):
                    module.Cluster = FakeCluster
                    module.MIGRATIONS = ["001_inert.sql"]

            def native_spec(name, location, *args, **kwargs):
                if pathlib.Path(location) != native_path:
                    return reject("unexpected dynamic module load")()
                return importlib.machinery.ModuleSpec(name, FakeNativeLoader(), origin=str(location))

            def fake_check_output(argv, *args, **kwargs):
                words = [str(word) for word in argv]
                operations.append({"operation": "check_output", "argv": words, "inert": True})
                if words[0] == "rg":
                    if scenario == "source_discovery_failure":
                        raise FileNotFoundError(errno.ENOENT, "INERT_RG_UNAVAILABLE", "rg")
                    return source_name + "\n"
                if words[:3] == ["git", "rev-parse", "HEAD"]:
                    return "1" * 40 + "\n"
                return reject("unexpected check_output command")()

            def fake_run(argv, *args, **kwargs):
                words = [str(word) for word in argv]
                operations.append({"operation": "run", "argv": words, "inert": True})
                if words[0] == str(pg_bin / "pg_ctl") and words[-1] == "status":
                    return subprocess.CompletedProcess(words, 3, stdout="", stderr="")
                return reject("unexpected subprocess.run command")()

            class FakeChild:
                pid = 246813579  # A marker only; os.kill/killpg never reach the OS.

                def __init__(self):
                    self.returncode = None
                    self.wait_calls = 0

                def wait(self, timeout=None):
                    self.wait_calls += 1
                    if scenario == "child_cleanup_failure":
                        raise OSError(errno.EIO, "INERT_CHILD_WAIT_FAILURE")
                    self.returncode = 0
                    return 0

                def poll(self):
                    return self.returncode

            def fake_popen(argv, *args, **kwargs):
                words = [str(word) for word in argv]
                operations.append({"operation": "Popen", "argv": words, "inert": True})
                if words[0] != "node":
                    return reject("unexpected Popen command")()
                child = FakeChild()
                children.append(child)
                if scenario == "valid_control":
                    (output / "native-protocol-results.json").write_text('{"success":true}\n')
                return child

            def fake_killpg(pid, sig):
                operations.append({"operation": "killpg", "pid": pid, "signal": int(sig), "inert": True})
                if scenario == "child_cleanup_failure" and pid == FakeChild.pid:
                    raise PermissionError(errno.EPERM, "INERT_CHILD_SIGNAL_DENIED")
                return reject("unexpected process-group signal")()

            argv = [str(WRAPPER_PATH), "--repo", str(repo), "--pg-bin", str(pg_bin),
                    "--redis-server", str(redis), "--output", str(output)]
            captured = io.StringIO()
            result = None
            raised = None
            with contextlib.ExitStack() as stack:
                for target, attribute, replacement in [
                    (subprocess, "check_output", fake_check_output),
                    (subprocess, "run", fake_run),
                    (subprocess, "Popen", fake_popen),
                    (subprocess, "call", reject("subprocess.call")),
                    (subprocess, "check_call", reject("subprocess.check_call")),
                    (os, "killpg", fake_killpg),
                    (os, "kill", reject("os.kill")),
                    (os, "system", reject("os.system")),
                    (os, "popen", reject("os.popen")),
                    (socket, "socket", reject("socket.socket")),
                    (socket, "socketpair", reject("socket.socketpair")),
                    (socket, "create_connection", reject("socket.create_connection")),
                    (urllib.request, "urlopen", reject("urllib.request.urlopen")),
                ]:
                    stack.enter_context(mock.patch.object(target, attribute, replacement))
                stack.enter_context(mock.patch.object(sys, "argv", argv))
                stack.enter_context(contextlib.redirect_stdout(captured))
                try:
                    module_name = "inert_wrapper_under_test_" + scenario
                    wrapper = types.ModuleType(module_name)
                    wrapper.__file__ = str(WRAPPER_PATH)
                    stack.enter_context(mock.patch.dict(sys.modules, {module_name: wrapper}))
                    # Execute the bytes whose digest is recorded, never a .pyc cache.
                    exec(compile(wrapper_bytes, str(WRAPPER_PATH), "exec"), wrapper.__dict__)
                    stack.enter_context(mock.patch.object(importlib.util, "spec_from_file_location", native_spec))
                    result = wrapper.main()
                except Exception as error:
                    raised = {"type": type(error).__name__, "message": str(error),
                              "traceback": traceback.format_exc()}

            receipt_path = output / "native-run-receipt.json"
            receipt = None
            receipt_error = None
            if receipt_path.exists():
                try:
                    receipt = json.loads(receipt_path.read_text())
                except (ValueError, OSError) as error:
                    receipt_error = str(error)
            observation = {
                "scenario": scenario,
                "wrapper_sha256": wrapper_hash,
                "wrapper_unchanged": wrapper_hash == sha256(WRAPPER_PATH),
                "main_argv": argv,
                "main_return": result,
                "uncaught_exception": raised,
                "receipt_exists": receipt_path.exists(),
                "receipt": receipt,
                "receipt_parse_error": receipt_error,
                "fake_cluster_count": len(clusters),
                "fake_cluster_initialize_calls": sum(c.initialize_calls for c in clusters),
                "fake_cluster_cleanup_calls": sum(c.cleanup_calls for c in clusters),
                "owned_roots_remaining_before_fixture_disposal": [str(c.root) for c in clusters if c.root.exists()],
                "fake_child_count": len(children),
                "fake_child_returncodes": [c.returncode for c in children],
                "operations": operations,
                "forbidden_operation_attempts": forbidden,
                "stdout_characters": len(captured.getvalue()),
                "fixture_disposal": "TemporaryDirectory removes the test fixtures after these observations.",
            }
            OBSERVATIONS.append(observation)
            return observation

    def assert_failure_contract(self, observation, markers, preflight=False):
        problems = []
        if observation["uncaught_exception"] is not None:
            problems.append("main() leaked an exception: " + observation["uncaught_exception"]["message"])
        if type(observation["main_return"]) is not int or observation["main_return"] == 0:
            problems.append("main() did not return a controlled nonzero status")
        if observation["owned_roots_remaining_before_fixture_disposal"]:
            problems.append("wrapper left its owned temporary cluster directory behind")
        receipt = observation["receipt"]
        if not isinstance(receipt, dict):
            problems.append("no readable native-run-receipt.json was produced")
        else:
            if receipt.get("success") is not False:
                problems.append("failure receipt must say success=false")
            if not receipt.get("finished_at"):
                problems.append("failure receipt lacks a completion timestamp")
            recorded = json.dumps(receipt)
            for marker in markers:
                if marker not in recorded:
                    problems.append("receipt lost failure cause " + marker)
            if observation["fake_cluster_count"] and not str(receipt.get("postgres_cleanup", "")).startswith("PASS"):
                problems.append("receipt does not attest cleanup of the successfully removed fake cluster")
        if preflight and observation["fake_cluster_initialize_calls"] != 0:
            problems.append("cluster initialization occurred despite failed preflight")
        if preflight and observation["fake_child_count"] != 0:
            problems.append("child execution occurred despite failed preflight")
        if observation["forbidden_operation_attempts"]:
            problems.append("forbidden operation attempted: " + repr(observation["forbidden_operation_attempts"]))
        if not observation["wrapper_unchanged"]:
            problems.append("wrapper source changed during the check")
        self.assertEqual(problems, [], "\n".join(problems))

    def test_source_discovery_failure_is_reported_without_leaking_owned_resources(self):
        observation = self.exercise("source_discovery_failure")
        self.assert_failure_contract(observation, ["INERT_RG_UNAVAILABLE"], preflight=True)

    def test_source_digest_failure_is_reported_without_leaking_owned_resources(self):
        observation = self.exercise("source_digest_failure")
        self.assert_failure_contract(observation, ["inert.ts"], preflight=True)

    def test_child_cleanup_failure_still_cleans_cluster_and_preserves_both_causes(self):
        observation = self.exercise("child_cleanup_failure")
        self.assert_failure_contract(observation, ["INERT_CHILD_WAIT_FAILURE", "INERT_CHILD_SIGNAL_DENIED"])

    def test_valid_inert_control_returns_success_and_cleans_owned_resources(self):
        observation = self.exercise("valid_control")
        self.assertIsNone(observation["uncaught_exception"])
        self.assertEqual(observation["main_return"], 0)
        self.assertIs(observation["receipt"]["success"], True)
        self.assertEqual(observation["owned_roots_remaining_before_fixture_disposal"], [])
        self.assertEqual(observation["forbidden_operation_attempts"], [])
        self.assertTrue(observation["wrapper_unchanged"])


def run_cli() -> int:
    global WRAPPER_PATH
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wrapper", type=pathlib.Path, default=WRAPPER_PATH)
    parser.add_argument("--evidence", type=pathlib.Path)
    args = parser.parse_args()
    WRAPPER_PATH = args.wrapper.resolve(strict=True)
    before = sha256(WRAPPER_PATH)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(WrapperLifecycleTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    exit_code = 0 if result.wasSuccessful() else 1
    if args.evidence:
        evidence = {
            "schema": "inert-wrapper-lifecycle-v1",
            "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "command_argv": list(sys.argv),
            "working_directory": str(pathlib.Path.cwd()),
            "python": sys.version,
            "wrapper_path": str(WRAPPER_PATH),
            "wrapper_sha256_before": before,
            "wrapper_sha256_after": sha256(WRAPPER_PATH),
            "test_file": str(HERE),
            "test_file_sha256": sha256(HERE),
            "exit_code": exit_code,
            "tests_run": result.testsRun,
            "failure_count": len(result.failures),
            "error_count": len(result.errors),
            "skipped_count": len(result.skipped),
            "failures": [{"test": test.id(), "traceback": detail} for test, detail in result.failures],
            "errors": [{"test": test.id(), "traceback": detail} for test, detail in result.errors],
            "observations": OBSERVATIONS,
            "scope": "Pure Python wrapper lifecycle; fake Cluster, fake child, local fixture files only.",
            "native_protocol_scenarios_executed": 0,
            "services_started": 0,
            "real_signals_sent": 0,
            "sockets_created": 0,
            "provider_calls": 0,
        }
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        args.evidence.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
        print("Evidence: " + str(args.evidence.resolve()))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(run_cli())
