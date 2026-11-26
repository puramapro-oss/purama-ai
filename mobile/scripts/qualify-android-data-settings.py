#!/usr/bin/env python3
"""Qualify one Settings DATA-selection attempt on the known disposable CI image.

This is a separate diagnostic after a real failed preflight, never a repair of
that preflight or proof of network isolation. Without --allow-settings-transition
it issues no ADB command. The original receipt and the offline observer remain
unchanged. Actual API35-r9 Settings UI is deliberately not assumed to match AOSP:
an unknown activity, locale, widget, geometry or state fails without a click.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shlex
import stat
import sys
import time
import uuid
import xml.etree.ElementTree as ET

# Import only the existing bounded process runner and subscription parser. In
# particular, do not bypass Preparation.run's READY-before-radio-mutation guard.
sys.dont_write_bytecode = True
PREPARER_PATH = Path(__file__).with_name("prepare-android-offline.py")
_spec = importlib.util.spec_from_file_location("_existing_android_preparation", PREPARER_PATH)
assert _spec is not None and _spec.loader is not None
_preparation = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_preparation)
bounded_command = _preparation.bounded_command
inspect_data_subscription = _preparation.inspect_data_subscription
utc_now = _preparation.utc_now
MAX_COMMAND_SECONDS = _preparation.MAX_COMMAND_SECONDS
MAX_BYTES = _preparation.MAX_STDOUT_BYTES

FINGERPRINT = "google/sdk_gphone64_x86_64/emu64xa:15/AE3A.240806.043/12960925:userdebug/dev-keys"
IMAGE_PROPERTIES = {"Pkg.Revision": "9", "AndroidVersion.ApiLevel": "35",
                    "AndroidVersion.ExtensionLevel": "13", "SystemImage.Abi": "x86_64",
                    "SystemImage.TagId": "google_apis"}
SETTINGS_COMPONENT = "com.android.settings/.Settings$MobileNetworkActivity"
SETTINGS_ACTION = "android.settings.NETWORK_OPERATOR_SETTINGS"
SUBSCRIPTION_EXTRA = "android.provider.extra.SUB_ID"
TITLE_IDS = {"android:id/title", "com.android.settings:id/title"}
SWITCH_IDS = {"com.android.settings:id/switchWidget", "com.android.settings:id/switch_widget",
              "android:id/switch_widget"}


class QualificationError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise QualificationError(reason)


def read_evidence(path: Path) -> bytes:
    require(not path.is_symlink() and stat.S_ISREG(path.stat().st_mode), "invalid_evidence_file")
    with path.open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    require(len(data) <= MAX_BYTES, "evidence_size_limit")
    return data


def shell(*arguments: str) -> list[str]:
    # One explicitly quoted remote shell command also preserves the '$' in the
    # Settings activity name. JSON escaping is not remote-shell escaping.
    return ["shell", shlex.join(arguments)]


def canonical_component(value: str) -> str:
    if value.startswith("com.android.settings/com.android.settings."):
        return "com.android.settings/." + value.split("/com.android.settings.", 1)[1]
    return value


def eligible_subscription(text: str, expected: int | None = None) -> dict:
    state = inspect_data_subscription(text)
    require(state.get("status") in {"WAITING", "READY"}, state.get("reason", "invalid_subscription"))
    mapping = state["activeSubscriptionMapping"]
    require(state["activeModemCount"] == 1 and len(mapping) == 1 and 0 in mapping,
            "requires_one_active_modem_and_subscription")
    require(re.findall(r"^areAllSubscriptionsLoaded=(true|false)\r?$", text, re.M) == ["true"],
            "subscriptions_not_loaded")
    sub_id = mapping[0]
    require(expected is None or sub_id == expected, "subscription_changed")
    return {**state, "selectedSubscriptionId": sub_id}


def display_size(text: str) -> tuple[int, int]:
    physical = re.findall(r"^Physical size: ([0-9]+)x([0-9]+)\r?$", text, re.M)
    override = re.findall(r"^Override size: ([0-9]+)x([0-9]+)\r?$", text, re.M)
    require(len(physical) == 1 and len(override) <= 1, "unknown_display_size")
    width, height = map(int, (override or physical)[0])
    require(0 < width <= 16384 and 0 < height <= 16384, "invalid_display_size")
    return width, height


def bounds(node: ET.Element, size: tuple[int, int]) -> tuple[int, int, int, int]:
    match = re.fullmatch(r"\[([0-9]{1,5}),([0-9]{1,5})\]\[([0-9]{1,5}),([0-9]{1,5})\]",
                         node.get("bounds", ""))
    require(match is not None, "invalid_ui_bounds")
    x1, y1, x2, y2 = map(int, match.groups())
    require(0 <= x1 < x2 <= size[0] and 0 <= y1 < y2 <= size[1], "offscreen_ui_bounds")
    return x1, y1, x2, y2


def mobile_data_control(xml: str, size: tuple[int, int]) -> dict:
    require(len(xml.encode("utf-8")) <= MAX_BYTES and "<!DOCTYPE" not in xml.upper()
            and "<!ENTITY" not in xml.upper(), "unsafe_ui_xml")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as error:
        raise QualificationError("invalid_ui_xml") from error
    require(root.tag == "hierarchy" and root.get("rotation") in {"0", "1", "2", "3"},
            "unknown_ui_hierarchy")
    if root.get("rotation") in {"1", "3"}:
        size = size[1], size[0]
    nodes = list(root.iter("node"))
    require(len(nodes) <= 4000, "ui_node_limit")
    parents = {child: parent for parent in root.iter() for child in parent}
    for node in nodes:
        depth, parent = 0, node
        while parent is not None:
            depth += 1
            require(depth <= 64, "ui_depth_limit")
            parent = parents.get(parent)
    titles = [node for node in nodes if node.get("text") == "Mobile data"
              and node.get("resource-id") in TITLE_IDS
              and node.get("package") == "com.android.settings"]
    require(len(titles) == 1, "mobile_data_title_missing_or_ambiguous")
    title = titles[0]
    require(title.get("enabled") == "true", "mobile_data_title_disabled")
    title_bounds = bounds(title, size)
    row = parents.get(title)
    while row is not None and row.tag == "node":
        descendants = list(row.iter("node"))
        switches = [node for node in descendants if node.get("class") == "android.widget.Switch"
                    and node.get("resource-id") in SWITCH_IDS]
        if switches and row.get("clickable") == "true":
            require(len(switches) == 1, "mobile_data_switch_ambiguous")
            switch = switches[0]
            require(row.get("enabled") == "true" and row.get("package") == "com.android.settings"
                    and switch.get("enabled") == "true" and switch.get("checkable") == "true"
                    and switch.get("package") == "com.android.settings"
                    and switch.get("checked") in {"true", "false"}, "mobile_data_control_not_actionable")
            # A semantic preference key is not a runtime resource ID. Require the
            # actual title, switch ID, state and clickable ancestor from this dump.
            require(sum(node.get("resource-id") in TITLE_IDS for node in descendants) == 1,
                    "mobile_data_row_ambiguous")
            row_bounds, switch_bounds = bounds(row, size), bounds(switch, size)
            for child_bounds in (title_bounds, switch_bounds):
                require(row_bounds[0] <= child_bounds[0] < child_bounds[2] <= row_bounds[2]
                        and row_bounds[1] <= child_bounds[1] < child_bounds[3] <= row_bounds[3],
                        "inconsistent_ui_bounds")
            # Tap within the observed title in the enabled clickable row. The
            # SwitchCompat widget itself is commonly non-clickable.
            x, y = (title_bounds[0] + title_bounds[2]) // 2, (title_bounds[1] + title_bounds[3]) // 2
            ancestors = set()
            parent = row
            while parent is not None:
                ancestors.add(parent)
                parent = parents.get(parent)
            for node in nodes:
                if node.get("clickable") != "true" or node.get("enabled") != "true":
                    continue
                rectangle = bounds(node, size)
                if rectangle[0] <= x < rectangle[2] and rectangle[1] <= y < rectangle[3]:
                    require(node in ancestors, "overlapping_click_target")
            return {"checked": switch.get("checked") == "true", "title": "Mobile data",
                    "titleResourceId": title.get("resource-id"),
                    "switchResourceId": switch.get("resource-id"), "rowBounds": row_bounds,
                    "switchBounds": switch_bounds, "tap": [x, y], "rotation": root.get("rotation")}
        row = parents.get(row)
    raise QualificationError("mobile_data_clickable_row_missing")


class Qualification:
    def __init__(self, artifacts: Path, directory: Path, timeout: float, allow: bool):
        self.artifacts, self.directory = artifacts, directory
        self.started = time.monotonic()
        self.deadline = self.started + timeout
        self.adb: list[str] = []
        self.authorized = False
        self.origin_bytes: bytes | None = None
        self.origin_valid = False
        self.receipt = {"schema": 1, "phase": "data-settings-qualification", "status": "IN_PROGRESS",
                        "startedAt": utc_now(), "timeoutSeconds": timeout,
                        "allowSettingsTransition": allow, "networkVerified": False,
                        "emulatorVerified": False, "mutationAttempted": False,
                        "selectionAttempts": 0, "uiClicks": 0, "uiObservations": [],
                        "commands": [], "failures": [], "dataSelectionObserved": False,
                        "sourceSha256": {Path(__file__).name: hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                                         PREPARER_PATH.name: hashlib.sha256(PREPARER_PATH.read_bytes()).hexdigest()}}

    def checkpoint(self) -> None:
        self.receipt["elapsedSeconds"] = round(time.monotonic() - self.started, 6)
        temporary = self.directory / "receipt.json.tmp"
        temporary.write_text(json.dumps(self.receipt, indent=2) + "\n")
        temporary.replace(self.directory / "receipt.json")

    def run(self, name: str, arguments: list[str], action: str = "read", binary: bool = False,
            deadline: float | None = None) -> str | bytes:
        end = min(self.deadline - 0.1, deadline if deadline is not None else self.deadline)
        remaining = end - time.monotonic()
        require(remaining > 0, "qualification_deadline")
        require(action == "read" or (self.authorized and self.receipt["allowSettingsTransition"]),
                "settings_transition_not_authorized")
        if action != "read":
            require(self.origin_valid and read_evidence(self.artifacts / "network-preparation/receipt.json")
                    == self.origin_bytes, "original_evidence_changed")
        if action in {"settings-launch", "settings-click"}:
            self.receipt["mutationAttempted"] = True
        command = self.adb + arguments
        record = {"name": name, "command": command, "action": action, "startedAt": utc_now(),
                  "outcome": "DISPATCHING"}
        self.receipt["commands"].append(record)
        self.checkpoint()  # Preserve a possible unknown action outcome before dispatch.
        began = time.monotonic()
        if began >= end:
            record.update(outcome="NOT_DISPATCHED", failure="qualification_deadline")
            self.checkpoint()
            raise QualificationError("qualification_deadline")
        # Evidence validation/writing also consumes the original global budget.
        stdout, stderr, result = bounded_command(command, min(end, began + MAX_COMMAND_SECONDS))
        target = self.directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        (target.parent / (target.name + (".png" if binary else ".txt"))).write_bytes(stdout)
        (target.parent / (target.name + ".stderr.txt")).write_bytes(stderr)
        record.update(result, outcome="RETURNED", seconds=round(time.monotonic() - began, 6),
                      stdoutBytes=len(stdout), stdoutSha256=hashlib.sha256(stdout).hexdigest(),
                      stderrBytes=len(stderr), stderrSha256=hashlib.sha256(stderr).hexdigest())
        failure = result["failure"] or ("command_failed" if result["exitCode"] != 0 else None)
        failure = failure or ("unexpected_command_stderr" if stderr.strip() else None)
        decoded: str | bytes = stdout
        if not failure and not binary:
            try:
                decoded = stdout.decode("utf-8", "strict")
            except UnicodeError:
                failure = "invalid_command_encoding"
        record["failure"] = failure
        if failure:
            self.receipt["failures"].append({"command": name, "reason": failure})
        self.checkpoint()
        require(failure is None, failure or "command_failed")
        return decoded

    def origin(self) -> None:
        self.origin_bytes = read_evidence(self.artifacts / "network-preparation/receipt.json")
        original = json.loads(self.origin_bytes)
        require(isinstance(original, dict) and original.get("schema") == 1
                and original.get("phase") == "network-preparation" and original.get("mode") == "prepare"
                and original.get("status") == "FAIL" and original.get("reason") == "data_subscription_not_ready"
                and original.get("emulatorVerified") is True and original.get("mutationAttempted") is False
                and original.get("networkVerified") is False, "requires_original_data_readiness_failure")
        run_id = original.get("runId", "")
        require(isinstance(run_id, str) and str(uuid.UUID(run_id)) == run_id, "invalid_origin_run_id")
        finished = datetime.fromisoformat(original["finishedAt"])
        require(finished.tzinfo is not None, "origin_time_requires_timezone")
        age = (datetime.now(timezone.utc) - finished).total_seconds()
        require(0 <= age <= 180, "origin_failure_is_not_fresh")
        readiness = original.get("dataReadiness", {})
        require(isinstance(readiness, dict), "invalid_origin_readiness_evidence")
        observations = readiness.get("observations", [])
        require(readiness.get("status") == "FAIL" and readiness.get("reason") == "data_subscription_not_ready"
                and isinstance(observations, list) and observations and isinstance(observations[-1], dict)
                and observations[-1].get("status") == "WAITING"
                and observations[-1].get("defaultDataSubId") == -1, "invalid_origin_readiness_evidence")
        adb = original.get("adb", [])
        require(isinstance(adb, list) and len(adb) == 3 and adb[:2] == ["adb", "-s"] and isinstance(adb[2], str)
                and re.fullmatch(r"emulator-[0-9]{1,6}", adb[2]) is not None, "origin_serial_not_pinned")
        require(not os.environ.get("ANDROID_SERIAL") or os.environ["ANDROID_SERIAL"] == adb[2],
                "original_serial_mismatch")
        self.adb = adb
        source = read_evidence(self.artifacts / "system-image-source.properties")
        properties = {}
        for line in source.decode("utf-8", "strict").splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            key, separator, value = line.partition("=")
            require(bool(separator) and key not in properties, "ambiguous_image_properties")
            properties[key] = value
        require(all(properties.get(key) == value for key, value in IMAGE_PROPERTIES.items()),
                "unsupported_system_image")
        checkout = read_evidence(self.artifacts / "checkout.txt").decode("ascii").splitlines()
        require(len(checkout) == 2 and all(re.fullmatch(r"[0-9a-f]{40}", item) for item in checkout),
                "invalid_checkout_evidence")
        self.receipt.update(runId=run_id, adb=self.adb, origin={
            "status": "FAIL", "reason": original["reason"], "finishedAt": original["finishedAt"],
            "ageSeconds": round(age, 6), "receiptSha256": hashlib.sha256(self.origin_bytes).hexdigest(),
            "imagePropertiesSha256": hashlib.sha256(source).hexdigest(), "checkout": checkout,
            "identityLimit": "Original receipt binds serial/image/time; it did not capture a kernel boot UUID."})
        self.origin_valid = True
        self.checkpoint()

    def subscription(self, name: str, expected: int | None = None, deadline: float | None = None) -> dict:
        state = eligible_subscription(self.run(name, shell("dumpsys", "isub"), deadline=deadline), expected)
        self.receipt.setdefault("subscriptionObservations", []).append({"command": name, **state})
        self.checkpoint()
        return state

    def focus(self, name: str, deadline: float | None = None) -> None:
        text = self.run(name, shell("dumpsys", "window", "windows"), deadline=deadline)
        matches = re.findall(r"^[ \t]*mCurrentFocus=Window\{[^}\r\n]*[ \t]"
                             r"(com\.android\.settings/[A-Za-z0-9_.$]+)\}[ \t]*\r?$", text, re.M)
        require(len(re.findall(r"^[ \t]*mCurrentFocus=", text, re.M)) == 1 and len(matches) == 1
                and canonical_component(matches[0]) == SETTINGS_COMPONENT,
                "unexpected_focused_window")

    def ui(self, deadline: float | None = None, purpose: str = "observation") -> dict:
        index = len(self.receipt["uiObservations"]) + 1
        require(index <= 10, "ui_observation_limit")
        observation = {"index": index, "purpose": purpose, "startedAt": utc_now()}
        self.receipt["uiObservations"].append(observation)
        prefix = "ui/%02d" % index
        self.focus(prefix + "/window", deadline)
        size = display_size(self.run(prefix + "/display", shell("wm", "size"), deadline=deadline))
        remote = "/data/local/tmp/purama-data-settings-%s-%02d.xml" % (self.receipt["runId"], index)
        self.run(prefix + "/dump", shell("uiautomator", "dump", remote), "ui-dump", deadline=deadline)
        xml = self.run(prefix + "/hierarchy", ["exec-out", "cat", remote], deadline=deadline)
        control = mobile_data_control(xml, size)
        observation.update(control=control, finishedAt=utc_now())
        self.checkpoint()
        return control

    def screenshot(self, name: str) -> None:
        png = self.run(name, ["exec-out", "screencap", "-p"], binary=True)
        require(png.startswith(b"\x89PNG\r\n\x1a\n"), "invalid_screenshot")

    def click_and_observe(self, control: dict, expected: bool, sub_id: int) -> dict:
        require(self.receipt["uiClicks"] < 2, "ui_click_limit")
        state = self.subscription("before-click-%d/isub" % (self.receipt["uiClicks"] + 1), sub_id)
        require(state["status"] == "WAITING", "data_became_ready_before_ui_transition")
        # The subscription read or asynchronous Settings refresh can move the
        # row. Re-identify its state and geometry immediately before this click.
        fresh = self.ui(purpose="before-click-%d" % (self.receipt["uiClicks"] + 1))
        require(fresh["checked"] == control["checked"] and fresh["checked"] is not expected,
                "ui_state_changed_before_click")
        self.receipt["selectionAttempts"] = 1
        self.receipt["uiClicks"] += 1
        self.run("controls/click-%d" % self.receipt["uiClicks"],
                 shell("input", "tap", *(str(value) for value in fresh["tap"])), "settings-click")
        end = min(self.deadline - 0.1, time.monotonic() + 12)
        for _ in range(3):
            observed = self.ui(end, "after-click-%d" % self.receipt["uiClicks"])
            if observed["checked"] is expected:
                return observed
            remaining = end - time.monotonic()
            require(remaining > 0, "ui_transition_not_observed")
            time.sleep(min(0.25, remaining))
        raise QualificationError("ui_transition_not_observed")

    def execute(self) -> None:
        self.origin()
        if not self.receipt["allowSettingsTransition"]:
            self.receipt.update(status="NOT_ATTEMPTED", reason="explicit_settings_transition_flag_required")
            return
        require(self.run("identity/serial", ["get-serialno"]).strip() == self.adb[2], "device_serial_changed")
        require(self.run("identity/qemu", shell("getprop", "ro.kernel.qemu")).strip() == "1", "refused_non_emulator")
        self.receipt["emulatorVerified"] = True
        for name, prop, value in (("api", "ro.build.version.sdk", "35"),
                                  ("abi", "ro.product.cpu.abi", "x86_64"),
                                  ("fingerprint", "ro.build.fingerprint", FINGERPRINT)):
            require(self.run("identity/" + name, shell("getprop", prop)).strip() == value, "unsupported_emulator_identity")
        require(self.run("identity/user", shell("am", "get-current-user")).strip() == "0", "unsupported_android_user")
        require(self.run("identity/sim-state", shell("getprop", "gsm.sim.state")).strip() == "LOADED", "sim_not_loaded")
        state = self.subscription("before-settings/isub")
        if state["status"] == "READY":
            self.receipt.update(status="NOT_ATTEMPTED", reason="data_already_ready_without_settings")
            return
        sub_id = state["selectedSubscriptionId"]
        resolved = self.run("settings/resolve", shell("cmd", "package", "resolve-activity", "--brief", "--user", "0",
                            "-a", SETTINGS_ACTION, "--ei", SUBSCRIPTION_EXTRA, str(sub_id)))
        components = re.findall(r"^[ \t]*([A-Za-z0-9_.]+/[A-Za-z0-9_.$]+)[ \t]*\r?$", resolved, re.M)
        require(len(components) == 1 and canonical_component(components[0]) == SETTINGS_COMPONENT,
                "settings_activity_missing_or_ambiguous")
        self.authorized = True
        launched = self.run("settings/launch", shell("am", "start", "-W", "--user", "0", "-n", SETTINGS_COMPONENT,
                            "-a", SETTINGS_ACTION, "--ei", SUBSCRIPTION_EXTRA, str(sub_id)), "settings-launch")
        require(re.findall(r"^Status: (.+)\r?$", launched, re.M) == ["ok"], "settings_launch_unconfirmed")
        control = self.ui(purpose="initial")
        self.screenshot("ui/before-transition")
        self.receipt["initialControl"] = control
        if control["checked"]:
            control = self.click_and_observe(control, False, sub_id)
        control = self.click_and_observe(control, True, sub_id)
        self.receipt["finalControl"] = control
        end = min(self.deadline - 0.1, time.monotonic() + 12)
        for index in range(12):
            state = self.subscription("after-settings/%02d-isub" % (index + 1), sub_id, end)
            if state["status"] == "READY":
                self.receipt.update(status="DATA_SELECTION_OBSERVED", reason="mapped_data_default_observed_after_settings",
                                    dataSelectionObserved=True,
                                    interpretation="A diagnostic observation only; original preflight remains FAIL and network isolation is unverified.")
                self.screenshot("ui/after-transition")
                return
            remaining = end - time.monotonic()
            require(remaining > 0, "data_selection_not_observed")
            time.sleep(min(1.0, remaining))
        raise QualificationError("data_selection_not_observed")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", required=True, type=Path,
                        help="Existing android-network-preflight directory; original receipt is read only.")
    parser.add_argument("--allow-settings-transition", action="store_true")
    parser.add_argument("--timeout-seconds", type=float, default=60)
    args = parser.parse_args()
    if not math.isfinite(args.timeout_seconds) or not 0 < args.timeout_seconds <= 60:
        parser.error("--timeout-seconds must be finite and within (0, 60]")
    directory = args.artifact_dir / "data-settings-qualification"
    try:
        directory.mkdir(exist_ok=False)
    except OSError as error:
        parser.error("Use a fresh diagnostic directory; evidence is never overwritten: " + str(error))
    qualification = Qualification(args.artifact_dir, directory, args.timeout_seconds, args.allow_settings_transition)
    try:
        qualification.execute()
    except (QualificationError, OSError, ValueError, TypeError, KeyError) as error:
        reason = error.reason if isinstance(error, QualificationError) else "invalid_evidence_or_runtime_error"
        qualification.receipt.update(status="FAIL", reason=reason)
        if qualification.authorized and time.monotonic() < qualification.deadline - 0.1:
            try:
                qualification.screenshot("ui/on-failure")
            except (QualificationError, OSError) as secondary:
                qualification.receipt["failureCapture"] = getattr(secondary, "reason", "capture_failed")
    finally:
        if qualification.origin_bytes is not None:
            try:
                unchanged = read_evidence(args.artifact_dir / "network-preparation/receipt.json") == qualification.origin_bytes
            except (QualificationError, OSError):
                unchanged = False
            qualification.receipt["originalEvidencePreserved"] = unchanged
            qualification.receipt["initialFailurePreserved"] = qualification.origin_valid and unchanged
            if not unchanged:
                qualification.receipt.update(status="FAIL", reason="original_evidence_changed")
        qualification.receipt["finishedAt"] = utc_now()
        qualification.checkpoint()
    print(json.dumps({key: qualification.receipt.get(key) for key in
                      ("status", "reason", "networkVerified", "initialFailurePreserved", "uiClicks", "elapsedSeconds")}))
    return 0 if qualification.receipt["status"] == "DATA_SELECTION_OBSERVED" else 24


if __name__ == "__main__":
    raise SystemExit(main())
