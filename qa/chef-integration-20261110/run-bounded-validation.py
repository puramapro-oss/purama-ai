"""Run every KARTA test, releasing each PGlite test process before the next.

This verification receipt does not change Vitest's test/hook timeouts or retries.
Run from any directory with Python 3 and the installed, lock-matched KARTA deps.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def snapshot():
    result = {}
    for name in ("memory.current", "memory.max", "memory.events"):
        path = Path("/sys/fs/cgroup") / name
        if path.exists():
            result[name] = path.read_text()
    return result


def stop(child):
    if child.poll() is not None:
        return
    os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", default="node")
    parser.add_argument("--expected-tests", type=int, required=True)
    parser.add_argument("--batch-timeout", type=int, default=180)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    karta = root / "karta"
    output = Path(__file__).resolve().parent / "bounded"
    output.mkdir(exist_ok=True)

    files = sorted(path.relative_to(karta).as_posix() for path in (karta / "test").rglob("*.test.ts"))
    sql = [path for path in files if "@electric-sql/pglite" in (karta / path).read_text()]
    other = [path for path in files if path not in sql]
    batches = ([('non-sql', other)] if other else []) + [(Path(path).stem, [path]) for path in sql]
    assigned = [path for _, batch in batches for path in batch]
    if Counter(assigned) != Counter(files) or any(count != 1 for count in Counter(assigned).values()):
        raise RuntimeError("The batches must cover each discovered test file exactly once")

    hashes = {path: hashlib.sha256((karta / path).read_bytes()).hexdigest() for path in files}
    receipt = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "node": subprocess.check_output([args.node, "--version"], text=True).strip(),
        "expected_tests": args.expected_tests,
        "files": files,
        "test_file_sha256": hashes,
        "pglite_files": sql,
        "classification": "Direct PGlite imports; all remaining files are included in the first batch",
        "planned_batches": len(batches),
        "batches": [],
        "status": "RUNNING",
    }
    receipt_path = output / "summary.json"

    def save():
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")

    save()
    for index, (label, paths) in enumerate(batches):
        log = output / f"{index:02d}-{label}.log"
        report = output / f"{index:02d}-{label}.vitest.json"
        if report.exists():
            raise RuntimeError(f"Refusing to overwrite a previous run: {report}")
        command = [args.node, "node_modules/vitest/vitest.mjs", "run", *paths,
                   "--maxWorkers=1", "--no-file-parallelism", "--reporter=verbose",
                   "--reporter=json", f"--outputFile={report}"]
        record = {"label": label, "files": paths, "command": command,
                  "resources_before": snapshot(), "timed_out": False, "interrupted": False}
        started = time.monotonic()
        with log.open("w") as stream:
            child = subprocess.Popen(command, cwd=karta, stdout=stream, stderr=subprocess.STDOUT,
                                     start_new_session=True)
            try:
                record["exit_code"] = child.wait(timeout=args.batch_timeout)
            except subprocess.TimeoutExpired:
                record["timed_out"] = True
                stop(child)
                record["exit_code"] = child.returncode
            except KeyboardInterrupt:
                record["interrupted"] = True
                stop(child)
                record["exit_code"] = child.returncode
            finally:
                stop(child)
        record["elapsed_seconds"] = round(time.monotonic() - started, 3)
        record["resources_after"] = snapshot()
        record["observed_files"] = []
        record["counts"] = {}
        record["passed"] = False
        if report.exists():
            result = json.loads(report.read_text())
            record["counts"] = {key: result.get(key, 0) for key in
                                ("numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests")}
            record["observed_files"] = sorted(Path(item["name"]).resolve().relative_to(karta).as_posix()
                                              for item in result.get("testResults", []))
            record["passed"] = (record["exit_code"] == 0 and result.get("success") is True
                                and not record["timed_out"] and not record["interrupted"]
                                and record["counts"]["numTotalTests"] > 0
                                and record["counts"]["numPassedTests"] == record["counts"]["numTotalTests"]
                                and record["counts"]["numFailedTests"] == 0
                                and record["counts"]["numPendingTests"] == 0
                                and record["counts"]["numTodoTests"] == 0
                                and record["observed_files"] == sorted(paths))
        receipt["batches"].append(record)
        save()
        print(json.dumps({"batch": index + 1, "of": len(batches), "label": label,
                          "passed": record["passed"], "tests": record["counts"],
                          "seconds": record["elapsed_seconds"]}), flush=True)
        if record["interrupted"]:
            receipt["status"] = "INTERRUPTED"
            save()
            return 130

    observed = [path for record in receipt["batches"] for path in record["observed_files"]]
    receipt["observed_file_coverage_exact"] = Counter(observed) == Counter(files)
    receipt["source_changes_during_run"] = [path for path, digest in hashes.items()
                                            if hashlib.sha256((karta / path).read_bytes()).hexdigest() != digest]
    receipt["total_tests"] = sum(record["counts"].get("numTotalTests", 0) for record in receipt["batches"])
    receipt["passed_tests"] = sum(record["counts"].get("numPassedTests", 0) for record in receipt["batches"])
    passed = (all(record["passed"] for record in receipt["batches"])
              and receipt["observed_file_coverage_exact"]
              and not receipt["source_changes_during_run"]
              and receipt["total_tests"] == args.expected_tests
              and receipt["passed_tests"] == args.expected_tests)
    receipt["status"] = "PASS" if passed else "FAIL"
    receipt["finished_at"] = datetime.now(timezone.utc).isoformat()
    save()
    print(json.dumps({key: receipt[key] for key in
                      ("status", "total_tests", "passed_tests", "observed_file_coverage_exact", "source_changes_during_run")}), flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
