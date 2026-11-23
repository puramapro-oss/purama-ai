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
