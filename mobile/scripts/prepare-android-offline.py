#!/usr/bin/env python3
"""Prepare one disposable emulator and retain evidence; never certify isolation.

COMMANDS_COMPLETED means only that the existing control commands completed.
OBSERVED is a read-only inspection. The separate wait-for-android-offline.py
observer remains responsible for its unchanged live-network acceptance criteria.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import time
import uuid


MAX_STDOUT_BYTES = 2 * 1024 * 1024
MAX_STDERR_BYTES = 65536
MAX_COMMAND_SECONDS = 5.0
RADIO_SETTINGS = (
    "airplane_mode_on", "wifi_on", "mobile_data", "multi_sim_data_call",
    "device_provisioned", "device_provisioning_mobile_data",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PreparationError(Exception):
    def __init__(self, reason: str, command: str):
        super().__init__(reason)
        self.reason = reason
        self.command = command


def bounded_command(command: list[str], deadline: float) -> tuple[bytes, bytes, dict]:
    """Limit the process, inherited pipes and captured bytes, not just its parent."""
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": MAX_STDOUT_BYTES, "stderr": MAX_STDERR_BYTES}
    truncated = {"stdout": False, "stderr": False}
    reason = None
    process = None
    with selectors.DefaultSelector() as selector:
        try:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       stdin=subprocess.DEVNULL, start_new_session=True)
            for name in buffers:
                selector.register(getattr(process, name), selectors.EVENT_READ, name)
            while selector.get_map() or process.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    reason = "command_timeout"
                    break
                events = selector.select(min(0.05, remaining))
                for key, _ in events:
                    data = os.read(key.fd, 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    name = key.data
                    available = limits[name] - len(buffers[name])
                    buffers[name].extend(data[:available])
                    if len(data) > available:
                        truncated[name] = True
                        reason = "command_output_limit"
                        break
                if reason:
                    break
        except OSError as error:
            buffers["stderr"].extend(str(error).encode("utf-8")[:MAX_STDERR_BYTES])
            reason = "command_spawn_error"
        finally:
            if process is not None:
                # A child can keep stdout open after its parent exits. Kill this
                # invocation's group on timeout, including that inherited pipe.
                if reason or process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                try:
                    process.wait(timeout=0.1)
                except subprocess.TimeoutExpired:
                    reason = reason or "command_reap_timeout"
                for name in buffers:
                    getattr(process, name).close()
    return bytes(buffers["stdout"]), bytes(buffers["stderr"]), {
        "exitCode": process.returncode if process is not None else None,
        "failure": reason, "stdoutTruncated": truncated["stdout"],
        "stderrTruncated": truncated["stderr"],
    }


class Preparation:
    def __init__(self, directory: Path, run_id: str, timeout: float, inspect_only: bool):
        self.directory = directory
        self.started = time.monotonic()
        self.deadline = self.started + timeout
        self.adb = ["adb"]
        serial = os.environ.get("ANDROID_SERIAL")
        if serial:
            self.adb += ["-s", serial]
        self.receipt = {
            "schema": 1, "status": "IN_PROGRESS", "phase": "network-preparation",
            "mode": "inspect-only" if inspect_only else "prepare",
            "runId": run_id, "startedAt": utc_now(), "timeoutSeconds": timeout,
            "commandTimeoutSeconds": MAX_COMMAND_SECONDS, "adb": self.adb,
            "networkVerified": False, "emulatorVerified": False,
            "mutationAttempted": False, "commands": [], "snapshots": [], "failures": [],
        }

    def checkpoint(self) -> None:
        self.receipt["elapsedSeconds"] = round(time.monotonic() - self.started, 6)
        temporary = self.directory / "receipt.json.tmp"
        temporary.write_text(json.dumps(self.receipt, indent=2) + "\n")
        temporary.replace(self.directory / "receipt.json")

    def run(self, name: str, arguments: list[str], mutation: bool = False) -> str:
        # Leave a small part of the same global budget for kill/reap and receipt.
        remaining = self.deadline - time.monotonic() - 0.1
        if remaining <= 0:
            raise PreparationError("preparation_deadline", name)
        if mutation and not self.receipt["emulatorVerified"]:
            raise PreparationError("emulator_guard_required", name)
        self.receipt["mutationAttempted"] |= mutation
        began = time.monotonic()
        command = self.adb + arguments
        started_at = utc_now()
        stdout, stderr, result = bounded_command(command, began + min(MAX_COMMAND_SECONDS, remaining))
        target = self.directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        (target.parent / (target.name + ".txt")).write_bytes(stdout)
        (target.parent / (target.name + ".stderr.txt")).write_bytes(stderr)
        result.update({
            "name": name, "command": command, "mutation": mutation, "startedAt": started_at,
            "seconds": round(time.monotonic() - began, 6),
            "stdoutBytes": len(stdout), "stdoutSha256": hashlib.sha256(stdout).hexdigest(),
            "stderrBytes": len(stderr), "stderrSha256": hashlib.sha256(stderr).hexdigest(),
        })
        decoded = ""
        if result["failure"] is None:
            if result["exitCode"] != 0:
                result["failure"] = "command_failed"
            elif stderr.strip():
                result["failure"] = "unexpected_command_stderr"
            else:
                try:
                    decoded = stdout.decode("utf-8", "strict")
                except UnicodeError:
                    result["failure"] = "invalid_command_encoding"
        self.receipt["commands"].append(result)
        if result["failure"]:
            self.receipt["failures"].append({"command": name, "reason": result["failure"]})
        self.checkpoint()
        if result["failure"]:
            raise PreparationError(result["failure"], name)
        return decoded

    def snapshot(self, phase: str, strict: bool = True) -> None:
        snapshot = {"phase": phase, "observedAt": utc_now(), "settings": {}, "errors": []}
        self.receipt["snapshots"].append(snapshot)

        def read(name: str, arguments: list[str]) -> str | None:
            try:
                return self.run("snapshots/" + phase + "/" + name, arguments)
            except PreparationError as error:
                snapshot["errors"].append({"command": error.command, "reason": error.reason})
                return None

        isub = read("isub", ["shell", "dumpsys", "isub"])
        read("phone", ["shell", "dumpsys", "phone"])
        for setting in RADIO_SETTINGS:
            if time.monotonic() >= self.deadline - 0.1:
                break
            value = read(setting, ["shell", "settings", "get", "global", setting])
            if value is not None:
                snapshot["settings"][setting] = value.strip()
        # Only IDs explicitly exposed by the subscription service/default-data
        # setting are inspected. These are diagnostics, never an offline verdict.
        ids = set(re.findall(
            r"^[ \t]*(?:defaultDataSubId|activeDataSubId)=([0-9]{1,10})[ \t]*\r?$"
            r"|^[ \t]*Logical SIM slot [0-9]+: subId=([0-9]{1,10})[ \t]*\r?$",
            isub or "", re.M))
        subscription_ids = {int(value) for pair in ids for value in pair if value}
        default = snapshot["settings"].get("multi_sim_data_call", "")
        if re.fullmatch(r"[0-9]{1,10}", default):
            subscription_ids.add(int(default))
        subscription_ids = sorted(value for value in subscription_ids if value < 2147483647)
        snapshot["subscriptionIds"] = subscription_ids
        if len(subscription_ids) > 16:
            snapshot["errors"].append({"command": "snapshots/" + phase + "/isub",
                                       "reason": "diagnostic_subscription_limit"})
        else:
            for sub_id in subscription_ids:
                if time.monotonic() >= self.deadline - 0.1:
                    break
                setting = "mobile_data" + str(sub_id)
                value = read(setting, ["shell", "settings", "get", "global", setting])
                if value is not None:
                    snapshot["settings"][setting] = value.strip()
        if time.monotonic() >= self.deadline - 0.1:
            snapshot["errors"].append({"command": "snapshots/" + phase,
                                       "reason": "preparation_deadline"})
        self.checkpoint()
        if strict and snapshot["errors"]:
            first = snapshot["errors"][0]
            raise PreparationError(first["reason"], first["command"])

    def execute(self, inspect_only: bool) -> None:
        if len(self.adb) == 1:
            # Pin the selected device so a subsequent default-device change
            # cannot redirect a mutation after the emulator guard.
            serial = self.run("identity/serial", ["get-serialno"]).strip()
            if serial == "unknown" or not re.fullmatch(r"[A-Za-z0-9_.:\-]{1,255}", serial):
                raise PreparationError("unknown_device_serial", "identity/serial")
            self.adb += ["-s", serial]
        qemu = self.run("identity/emulator", ["shell", "getprop", "ro.kernel.qemu"])
        if qemu.strip() != "1":
            raise PreparationError("refused_non_emulator", "identity/emulator")
        self.receipt["emulatorVerified"] = True
        for name, prop in (("api", "ro.build.version.sdk"),
                           ("abi", "ro.product.cpu.abi"),
                           ("fingerprint", "ro.build.fingerprint")):
            self.run("identity/" + name, ["shell", "getprop", prop])
        self.run("identity/phone-help", ["shell", "cmd", "phone", "help"])
        self.snapshot("observed" if inspect_only else "before")
        if inspect_only:
            self.receipt.update(status="OBSERVED", reason="read_only_diagnostics_collected")
            return
        # Preserve the existing mutation order while exposing the previously
        # missing state between DATA disable and enabling airplane mode.
        self.run("controls/wifi-disable", ["shell", "svc", "wifi", "disable"], mutation=True)
        self.run("controls/data-disable", ["shell", "svc", "data", "disable"], mutation=True)
        self.snapshot("after-data")
        self.run("controls/airplane-enable", ["shell", "cmd", "connectivity", "airplane-mode", "enable"], mutation=True)
        self.run("controls/airplane-setting", ["shell", "settings", "put", "global", "airplane_mode_on", "1"], mutation=True)
        self.run("controls/remove-reverses", ["reverse", "--remove-all"], mutation=True)
        self.snapshot("after-airplane")
        self.receipt.update(status="COMMANDS_COMPLETED", reason="control_commands_completed_network_unverified")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--inspect-only", action="store_true")
    parser.add_argument("--timeout-seconds", type=float, default=60)
    args = parser.parse_args()
    try:
        if str(uuid.UUID(args.run_id)) != args.run_id:
            raise ValueError("Noncanonical run ID")
    except ValueError:
        parser.error("--run-id must be a canonical UUID")
    if not math.isfinite(args.timeout_seconds) or not 0 < args.timeout_seconds <= 60:
        parser.error("--timeout-seconds must be finite and within (0, 60]")
    directory = args.artifact_dir / "network-preparation"
    try:
        directory.mkdir(parents=True, exist_ok=False)
    except OSError as error:
        parser.error("Use a fresh artifact directory; existing evidence is never overwritten: " + str(error))
    preparation = Preparation(directory, args.run_id, args.timeout_seconds, args.inspect_only)
    try:
        preparation.execute(args.inspect_only)
    except PreparationError as error:
        preparation.receipt.update(status="FAIL", reason=error.reason, failedCommand=error.command)
        if preparation.receipt["mutationAttempted"] and time.monotonic() < preparation.deadline - 0.1:
            preparation.snapshot("on-failure", strict=False)
    except (OSError, ValueError) as error:
        preparation.receipt.update(status="FAIL", reason="preparation_error", error=str(error))
    finally:
        preparation.receipt["finishedAt"] = utc_now()
        preparation.checkpoint()
    print(json.dumps({key: preparation.receipt[key] for key in
                      ("status", "mode", "reason", "networkVerified", "elapsedSeconds")}))
    return 0 if preparation.receipt["status"] in {"COMMANDS_COMPLETED", "OBSERVED"} else 23


if __name__ == "__main__":
    raise SystemExit(main())
