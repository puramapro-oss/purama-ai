#!/usr/bin/env python3
"""Prepare one private native PostgreSQL cluster, then exercise the real relay.

The existing native-outbox harness owns PostgreSQL initialization/cleanup.
This wrapper does not use any configured production database or provider.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import signal
import subprocess
import time


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=pathlib.Path, required=True)
    parser.add_argument("--pg-bin", type=pathlib.Path, required=True)
    parser.add_argument("--redis-server", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    args.repo = args.repo.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    receipt = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "commands": [], "success": False,
               "postgres_transport": "private Unix socket; TCP disabled",
               "redis_transport": "private Unix socket; TCP disabled",
               "provider_calls": "Not permitted; JavaScript fetch tripwire installed"}
    code = 1
    cluster = None
    child = None
    try:
        module_path = args.repo / "qa/iao-runtime-20261110/native-outbox.py"
        spec = importlib.util.spec_from_file_location("existing_native_outbox", module_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        source_paths = sorted(subprocess.check_output(["rg", "--files", "karta/src", "-g", "*.ts"],
                                                     cwd=args.repo, text=True).splitlines())
        source_paths += ["karta/package-lock.json",
                        "qa/approval-outbox-live-20261111/approvalOutboxNative.mjs",
                        "qa/approval-outbox-live-20261111/run.py"]
        source_paths += ["karta/migrations/" + name for name in module.MIGRATIONS]
        before = {name: digest(args.repo / name) for name in source_paths}
        receipt.update({
            "source_hashes_before": before,
            "repository_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.repo, text=True).strip(),
            "source_file_count": len(before),
            "binary_sha256": {str(binary): digest(binary) for binary in
                              [args.redis_server, args.pg_bin / "postgres", args.pg_bin / "pg_ctl", args.pg_bin / "psql"]},
            "reused_native_cluster_harness_sha256": digest(module_path),
        })
        # Preflight must finish before allocating an owned cluster directory.
        cluster = module.Cluster(args.pg_bin)
        cluster.initialize()
        receipt["postgres_version"] = cluster.query("SELECT version();")
        assert cluster.query("SHOW listen_addresses;") == ""
        cluster.query("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);"
                      "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;"
                      "CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;"
                      "GRANT USAGE ON SCHEMA purama_ai,auth TO service_role,authenticated,anon;")
        for filename in module.MIGRATIONS:
            raw = (args.repo / "karta/migrations" / filename).read_text()
            cluster.query(raw, timeout=20)
        cluster.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA purama_ai TO service_role;")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "TZ": "UTC",
               "NODE_OPTIONS": "--max-old-space-size=192", "DOTENV_CONFIG_PATH": "/dev/null",
               "SUPABASE_URL": "http://127.0.0.1:1", "SUPABASE_SERVICE_ROLE_KEY": "inert-native-fixture-only",
               "NATIVE_REPO": str(args.repo), "NATIVE_OUTPUT": str(args.output),
               "NATIVE_PG_BIN": str(args.pg_bin), "NATIVE_PG_DATA": str(cluster.data),
               "NATIVE_PG_SOCKET": str(cluster.root), "NATIVE_REDIS_SERVER": str(args.redis_server)}
        command = ["node", str(args.repo / "karta/node_modules/tsx/dist/cli.mjs"),
                   str(args.repo / "qa/approval-outbox-live-20261111/approvalOutboxNative.mjs")]
        started = time.monotonic()
        with (args.output / "execution.log").open("w") as log:
            child = subprocess.Popen(command, cwd=args.output, env=env, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = child.wait(timeout=80)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=3)
                code = 124
        receipt["commands"].append({"argv": command, "cwd": str(args.output), "exit": code,
                                    "elapsed_seconds": round(time.monotonic() - started, 3)})
        results = args.output / "native-protocol-results.json"
        if results.exists():
            receipt["protocol_results_sha256"] = digest(results)
            receipt["protocol_success"] = json.loads(results.read_text())["success"]
        receipt["source_hashes_after"] = {name: digest(args.repo / name) for name in source_paths}
        receipt["source_unchanged_during_run"] = before == receipt["source_hashes_after"]
        receipt["binary_sha256_after"] = {name: digest(pathlib.Path(name)) for name in receipt["binary_sha256"]}
        receipt["binaries_unchanged_during_run"] = receipt["binary_sha256"] == receipt["binary_sha256_after"]
    except Exception as error:
        receipt["error"] = str(error)[:3000]
    finally:
        try:
            if child is not None and child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=3)
            receipt["child_cleanup"] = "PASS: owned child exited" if child is not None else "NOT STARTED"
        except Exception as error:
            # A failed child signal must not skip the independent cluster cleanup
            # or erase the original execution error and its failure receipt.
            receipt["child_cleanup"] = "FAIL: " + str(error)[:1500]
        if cluster is None:
            receipt["postgres_cleanup"] = "NOT CREATED: preflight failed before cluster allocation"
        else:
            try:
                if cluster.log.exists():
                    (args.output / "postgres.log").write_bytes(cluster.log.read_bytes())
            except OSError as error:
                receipt["postgres_log_copy_error"] = str(error)[:1000]
            try:
                if cluster.data.exists():
                    status = subprocess.run([str(args.pg_bin / "pg_ctl"), "-D", str(cluster.data), "status"],
                                            capture_output=True, text=True, timeout=5)
                    if status.returncode == 0:
                        cluster.started = True
                    elif status.returncode not in (3, 4):
                        raise RuntimeError("Cannot establish status of the owned PostgreSQL cluster")
                cluster.cleanup()
                assert not cluster.root.exists()
                receipt["postgres_cleanup"] = "PASS: own cluster stopped and temporary cluster removed"
            except Exception as error:
                receipt["postgres_cleanup"] = "FAIL: " + str(error)[:1500]
        receipt["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        receipt["success"] = (code == 0 and receipt.get("protocol_success") is True
                              and receipt.get("source_unchanged_during_run") is True
                              and receipt.get("binaries_unchanged_during_run") is True
                              and receipt["child_cleanup"].startswith("PASS")
                              and receipt["postgres_cleanup"].startswith("PASS"))
        (args.output / "native-run-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt), flush=True)
    return 0 if receipt["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
