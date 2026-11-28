#!/usr/bin/env python3
"""Observe a disposable Android qualification device; never alter its settings.

Settings can change before ConnectivityService removes its live networks. A
successful receipt therefore requires stable settings AND an empty current
network set. Logs and historical network requests are deliberately not evidence
of a current connection. Unknown dumpsys formats fail closed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def inspect_connectivity(text: str) -> dict:
    """Read the current AOSP ConnectivityService sections, excluding history."""
    defaults = list(re.finditer(r"^Active default network: ([^\r\n]+)\r?$", text, re.M))
    starts = list(re.finditer(r"^Current Networks:[ \t]*\r?$", text, re.M))
    ends = list(re.finditer(r"^Status for known UIDs:[ \t]*\r?$", text, re.M))
    if len(defaults) != 1 or len(starts) != 1 or len(ends) != 1:
        return {"recognized": False, "reason": "missing_or_ambiguous_current_sections"}
    if not defaults[0].end() < starts[0].start() < starts[0].end() < ends[0].start():
        return {"recognized": False, "reason": "invalid_current_section_order"}
    default = defaults[0].group(1).strip(" \t")
    if default != "none" and not re.fullmatch(r"[0-9]+", default):
        return {"recognized": False, "reason": "unknown_default_network_value", "default": default}
    body = text[starts[0].end():ends[0].start()].strip(" \t\r\n")
    # AOSP dumpNetworks() emits nothing for an empty live network set. Requiring
    # that exact empty section also rejects per-app, restricted and local-only
    # networks, rather than trusting a missing system-default network alone.
    return {
        "recognized": True,
        "activeDefaultNetwork": None if default == "none" else int(default),
        "currentNetworksEmpty": not body,
        "offline": default == "none" and not body,
    }


def observe(adb: list[str], directory: Path, deadline: float) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    results = {}
    settings = {}
    commands = [
        ("airplane-mode", ["shell", "settings", "get", "global", "airplane_mode_on"]),
        ("wifi-on", ["shell", "settings", "get", "global", "wifi_on"]),
        ("mobile-data", ["shell", "settings", "get", "global", "mobile_data"]),
        ("connectivity-offline", ["shell", "dumpsys", "connectivity"]),
    ]
    for name, arguments in commands:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {"offline": False, "fatal": "observation_deadline", "commands": results}
        began = time.monotonic()
        try:
            result = subprocess.run(adb + arguments, capture_output=True,
                                    timeout=min(5.0, remaining), check=False)
            stdout, stderr = result.stdout, result.stderr
            code = result.returncode
        except subprocess.TimeoutExpired as error:
            stdout, stderr = error.stdout or b"", error.stderr or b""
            code = 124
        except OSError as error:
            stdout, stderr, code = b"", str(error).encode(), 127
        (directory / (name + ".txt")).write_bytes(stdout)
        (directory / (name + ".stderr.txt")).write_bytes(stderr)
        results[name] = {
            "command": adb + arguments, "exitCode": code,
            "seconds": round(time.monotonic() - began, 6),
            "stdoutBytes": len(stdout), "stdoutSha256": hashlib.sha256(stdout).hexdigest(),
            "stderrBytes": len(stderr), "stderrSha256": hashlib.sha256(stderr).hexdigest(),
        }
        if code != 0:
            return {"offline": False, "fatal": "adb_observation_failed", "commands": results}
        if len(stdout) > 2 * 1024 * 1024 or len(stderr) > 65536:
            return {"offline": False, "fatal": "observation_too_large", "commands": results}
        if stderr.strip():
            return {"offline": False, "fatal": "adb_observation_stderr", "commands": results}
        try:
            decoded = stdout.decode("utf-8", "strict")
        except UnicodeError:
            return {"offline": False, "fatal": "invalid_adb_output_encoding", "commands": results}
        if name != "connectivity-offline":
            settings[name] = decoded.strip()
        else:
            connectivity = inspect_connectivity(decoded)
    if any(value not in {"0", "1"} for value in settings.values()):
        return {"offline": False, "fatal": "unknown_radio_setting", "settings": settings,
                "connectivity": connectivity, "commands": results}
    if not connectivity["recognized"]:
        return {"offline": False, "fatal": "unknown_connectivity_format", "settings": settings,
                "connectivity": connectivity, "commands": results}
    offline = (settings == {"airplane-mode": "1", "wifi-on": "0", "mobile-data": "0"}
               and connectivity["offline"])
    return {"offline": offline, "settings": settings, "connectivity": connectivity,
            "commands": results}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--phase", required=True,
                        choices=("before-restart", "after-restart", "after-completion"))
    parser.add_argument("--timeout-seconds", type=float, default=45)
    parser.add_argument("--interval-seconds", type=float, default=1)
    args = parser.parse_args()
    try:
        if str(uuid.UUID(args.run_id)) != args.run_id:
            raise ValueError("Noncanonical native run ID")
    except ValueError:
        parser.error("--run-id must be a canonical UUID")
    if not 0 < args.timeout_seconds <= 45 or not 0.01 <= args.interval_seconds <= 5:
        parser.error("timeouts must be bounded (0 < timeout <= 45; 0.01 <= interval <= 5)")
    directory = args.artifact_dir / ("network-" + args.phase)
    directory.mkdir(parents=True, exist_ok=True)
    adb = ["adb"]
    serial = os.environ.get("ANDROID_SERIAL")
    if serial:
        adb.extend(["-s", serial])
    started = time.monotonic()
    deadline = started + args.timeout_seconds
    required = 3
    consecutive = 0
    receipt = {
        "schema": 1, "status": "FAIL", "runId": args.run_id, "phase": args.phase,
        "startedAt": utc_now(), "adb": adb, "timeoutSeconds": args.timeout_seconds,
        "intervalSeconds": args.interval_seconds, "requiredStableObservations": required,
        "mode": "converge" if args.phase == "before-restart" else "assert",
        "observations": [],
    }
    reason = "network_did_not_converge"
    try:
        while time.monotonic() < deadline:
            index = len(receipt["observations"]) + 1
            snapshot = observe(adb, directory / ("observation-%03d" % index), deadline)
            snapshot["observedAt"] = utc_now()
            snapshot["index"] = index
            receipt["observations"].append(snapshot)
            if snapshot.get("fatal"):
                reason = snapshot["fatal"]
                break
            if snapshot["offline"]:
                consecutive += 1
            else:
                consecutive = 0
                if args.phase != "before-restart":
                    reason = "network_returned_after_offline_boundary"
                    break
            if consecutive == required:
                receipt["status"] = "PASS"
                reason = "stable_offline_state"
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(args.interval_seconds, remaining))
    except (OSError, UnicodeError, ValueError) as error:
        reason = "observation_error"
        receipt["error"] = str(error)
    finally:
        receipt.update({"reason": reason, "finishedAt": utc_now(),
                        "elapsedSeconds": round(time.monotonic() - started, 6),
                        "stableObservations": consecutive})
        (directory / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({key: receipt[key] for key in
                      ("status", "phase", "reason", "stableObservations", "elapsedSeconds")}))
    return 0 if receipt["status"] == "PASS" else 23


if __name__ == "__main__":
    raise SystemExit(main())
