#!/usr/bin/env python3
"""Exercise the real whitespace gate in disposable Git repositories.

No product code, service, network, model or shared checkout is changed.
Run from an IAO checkout: python3 scripts/ci/test-wealth-diff.py
"""

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/ci/check-wealth-diff.sh"
ARCHIVE = "qa/iao-release-qualification-20261123/root-typecheck.log"
ARCHIVE_BLOB = "19d6618bdd08c543b5a101755910791a584b5885"
PR104_ARCHIVES = (
    ("qa/iao-integration-20261124/assembly/immutability-before-final.log", "89117259c0fc80f48e4c26f0755648f3a1f6c2d0"),
    ("qa/iao-integration-20261124/assembly/immutability-before.log", "983820afc7ffd5f12a14afaad806f6a1d00d1bd0"),
    ("qa/iao-integration-20261124/assembly/karta-build-serial.log", "4cad8edb2807d0fc5a1eaf52c51f413e2b85d5c8"),
    ("qa/iao-integration-20261124/assembly/karta-typecheck-1024.log", "55246ae3da84de95a7333206ae1d9ade56c0be8f"),
    ("qa/iao-integration-20261124/assembly/karta-typecheck-serial.log", "7243009a33be03841809d2a193c6d1998625049e"),
    ("qa/iao-integration-20261124/gitnexus/iao-gitnexus-karta-20261124.log", "7c6b1d14cbfc1f95e23ca17dca62517f1f02a143"),
    ("qa/iao-integration-20261124/gitnexus/root-index.log", "7ed99bd6a156ae2c847d3f9b954d389905f9714a"),
    ("qa/iao-integration-20261124/memory/projection-after.log", "55bac429e3e8a4f8895ea51356a9d81564a75e35"),
    ("qa/iao-integration-20261124/memory/projection-before-in-process.log", "efefff155c561b23c7fa6516bbaf9a850eff2722"),
    ("qa/iao-integration-20261124/memory/projection-before.log", "4d3821f0761b459ddc174b103c2db082a2dbf4b8"),
    ("qa/iao-integration-20261124/runtime/after.log", "304319bd3089749a486db6e7ca55a7a845d81110"),
    ("qa/iao-integration-20261124/runtime/before-complete.log", "7c182bfb4c057e8d71549b4a5c9dd385793caa25"),
    ("qa/iao-integration-20261124/runtime/before.log", "e6f6e8c304e81997c5f5e90feca41e0fa40d90d6"),
    ("qa/iao-integration-20261124/runtime/regressions-final.log", "8fbe2c1f4ae25d775d717eea28642e47fdcf668f"),
    ("qa/iao-integration-20261124/runtime/regressions.log", "61bad687fa432d2244e692dca302b693373e61fa"),
)
PR108_ARCHIVES = (
    ("qa/iao-continuity-20261124/auth-sdk/edge-npm-alignment-karta.log", "82ac622e1bf22f17b5160b11f21de59ab29f8401"),
    ("qa/iao-continuity-20261124/ci-first-attempt/device-job-excerpts.log", "307635738311c75bbf1181d9ca648073aa7d3d64"),
)


def git(directory, *args):
    result = subprocess.run(
        ["git", "-C", str(directory), *args],
        capture_output=True, text=True, timeout=20, check=True,
    )
    return result.stdout.strip()


def put(directory, relative, data, mode=0o644):
    target = directory / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    target.chmod(mode)


def revision(directory, message):
    git(directory, "add", "--all")
    git(directory, "commit", "--quiet", "--allow-empty", "-m", message)
    return git(directory, "rev-parse", "HEAD")


def run_case(name, initial=None, additions=None, expected=2,
             bad_revision=False):
    with tempfile.TemporaryDirectory(prefix="iao-whitespace-case-") as tmp:
        directory = Path(tmp)
        git(directory, "init", "--quiet")
        git(directory, "config", "user.name", "IAO isolated test")
        git(directory, "config", "user.email", "iao-tests@example.invalid")
        git(directory, "config", "commit.gpgsign", "false")
        git(directory, "config", "core.hooksPath", "/dev/null")
        git(directory, "config", "core.fileMode", "true")
        git(directory, "config", "core.whitespace",
            "blank-at-eol,blank-at-eof,space-before-tab")
        put(directory, "README.md", b"Isolated gate fixture.\n")
        for path, data, mode in initial or []:
            put(directory, path, data, mode)
        base = revision(directory, "base fixture")
        for path, data, mode in additions or []:
            put(directory, path, data, mode)
        head = revision(directory, "candidate fixture")
        if bad_revision:
            head = "missing-iao-test-revision"
        result = subprocess.run(
            ["bash", str(SCRIPT), base, head], cwd=directory,
            capture_output=True, text=True, timeout=20,
        )
        passed = result.returncode == expected
        return {
            "name": name, "expected_exit": expected,
            "actual_exit": result.returncode, "pass": passed,
            "stdout": result.stdout, "stderr": result.stderr,
        }


def main():
    archive_bytes = (REPO / ARCHIVE).read_bytes()
    blob = hashlib.sha1(
        b"blob " + str(len(archive_bytes)).encode() + b"\0" + archive_bytes
    ).hexdigest()
    if blob != ARCHIVE_BLOB:
        raise SystemExit("The immutable fixture no longer matches its archived blob")
    original = (ARCHIVE, archive_bytes, 0o644)
    cases = [
        ("unchanged clean tree", dict(expected=0)),
        ("first exact archived blob", dict(additions=[original], expected=0)),
        ("modified archive stays strict", dict(additions=[
            (ARCHIVE, archive_bytes + b"modified evidence \n", 0o644)])),
        ("renamed archive stays strict", dict(additions=[
            ("qa/renamed-proof.log", archive_bytes, 0o644)])),
        ("unlisted new QA stays strict", dict(additions=[
            ("qa/unlisted-proof.log", b"new unlisted proof \n", 0o644)])),
        ("application source stays strict", dict(additions=[
            ("src/gate-fixture.ts", b"export const guard = 1; \n", 0o644)])),
        ("one exemption cannot hide a bad source", dict(additions=[
            original,
            ("src/gate-fixture.ts", b"export const guard = 1; \n", 0o644)])),
        ("preexisting path stays strict", dict(
            initial=[(ARCHIVE, b"previous clean evidence\n", 0o644)],
            additions=[original])),
        ("executable archived file stays strict", dict(additions=[
            (ARCHIVE, archive_bytes, 0o755)])),
        ("invalid revision is not accepted", dict(bad_revision=True, expected=128)),
    ]
    pr104_originals = []
    for path, expected_blob in PR104_ARCHIVES:
        data = (REPO / path).read_bytes()
        actual_blob = hashlib.sha1(
            b"blob " + str(len(data)).encode() + b"\0" + data
        ).hexdigest()
        if actual_blob != expected_blob:
            raise SystemExit("The immutable PR104 fixture changed: " + path)
        fixture = (path, data, 0o644)
        pr104_originals.append(fixture)
        cases.append(("first exact PR104 archived blob: " + path,
                      dict(additions=[fixture], expected=0)))
    modified_path, modified_bytes, modified_mode = pr104_originals[0]
    cases.extend([
        ("modified PR104 archive stays strict", dict(additions=[
            (modified_path, modified_bytes + b"modified evidence \n", modified_mode)])),
        ("PR104 exemptions cannot hide a bad source", dict(additions=[
            *pr104_originals,
            ("src/gate-fixture.ts", b"export const guard = 1; \n", 0o644)])),
    ])
    pr108_originals = []
    for path, expected_blob in PR108_ARCHIVES:
        data = (REPO / path).read_bytes()
        actual_blob = hashlib.sha1(
            b"blob " + str(len(data)).encode() + b"\0" + data
        ).hexdigest()
        if actual_blob != expected_blob:
            raise SystemExit("The immutable PR108 fixture changed: " + path)
        fixture = (path, data, 0o644)
        pr108_originals.append(fixture)
        cases.extend([
            ("first exact PR108 archived blob: " + path,
             dict(additions=[fixture], expected=0)),
            ("modified PR108 archive stays strict: " + path, dict(additions=[
                (path, data + b"modified evidence \n", 0o644)])),
            ("renamed PR108 archive stays strict: " + path, dict(additions=[
                ("qa/renamed-" + Path(path).name, data, 0o644)])),
            ("preexisting PR108 path stays strict: " + path, dict(
                initial=[(path, b"previous clean evidence\n", 0o644)],
                additions=[fixture])),
            ("executable PR108 archive stays strict: " + path, dict(additions=[
                (path, data, 0o755)])),
        ])
    cases.extend([
        ("exact PR104 and PR108 archives compose", dict(
            additions=[*pr104_originals, *pr108_originals], expected=0)),
        ("PR108 exemptions cannot hide a bad source", dict(additions=[
            *pr108_originals,
            ("src/gate-fixture.ts", b"export const guard = 1; \n", 0o644)])),
    ])
    results = [run_case(name, **settings) for name, settings in cases]
    summary = {
        "fixture": ARCHIVE, "fixture_blob": blob,
        "fixture_sha256": hashlib.sha256(archive_bytes).hexdigest(),
        "total": len(results), "passed": sum(case["pass"] for case in results),
        "cases": results,
    }
    print(json.dumps(summary, indent=2) + "\n", end="")
    raise SystemExit(0 if all(case["pass"] for case in results) else 1)


if __name__ == "__main__":
    main()
