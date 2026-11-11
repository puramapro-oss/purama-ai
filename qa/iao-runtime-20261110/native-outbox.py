#!/usr/bin/env python3
"""Inert native PostgreSQL checks: private cluster, Unix socket, no TCP/providers.

Usage: python3 native-outbox.py --repo /absolute/repo --output /absolute/result.json
Only this script's newly-created temporary PostgreSQL cluster is stopped/deleted.
"""
import argparse
import concurrent.futures
import contextlib
import datetime
import hashlib
import json
import os
import pathlib
import selectors
import shutil
import subprocess
import tempfile
import threading
import time

OWNER = "00000000-0000-4000-8000-000000000701"
PARENT = "00000000-0000-4000-8000-000000000702"
ACTION = "00000000-0000-4000-8000-000000000703"
KEY = "queue:v2:karta-v2-dedupe-" + "a" * 64
FINGERPRINT = "b" * 64
LEGACY = "queue:karta-" + hashlib.sha256(("approval-resume|" + ACTION + "|executed").encode()).hexdigest() + ":"
MIGRATIONS = ["001_karta_core.sql", "002_karta_global_kill_switch.sql", "005_karta_pending_actions.sql",
              "006_execution_claims.sql", "019_karta_approval_parent_guard.sql", "020_execution_fingerprints.sql",
              "026_pending_action_execution_origin.sql", "027_approval_continuation_outbox.sql"]


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class Cluster:
    def __init__(self, binary):
        self.binary = pathlib.Path(binary)
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="karta-outbox-", dir="/tmp"))
        os.chmod(self.root, 0o700)
        self.data = self.root / "data"
        self.log = self.root / "postgres.log"
        self.started = False
        self.command = [str(self.binary / "psql"), "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
                        "-v", "VERBOSITY=verbose", "-h", str(self.root), "-p", "55497", "-U", "fixture", "postgres"]

    def initialize(self):
        subprocess.run([str(self.binary / "initdb"), "-D", str(self.data), "-A", "trust", "-U", "fixture",
                        "--no-locale", "--encoding=UTF8"], check=True, capture_output=True, text=True, timeout=30)
        with (self.data / "postgresql.conf").open("a") as config:
            config.write("\nlisten_addresses=''\nport=55497\nunix_socket_directories='" + str(self.root) + "'\n")
            config.write("unix_socket_permissions=0700\nmax_connections=12\nshared_buffers='16MB'\nfsync=on\n")
        self.start()

    def start(self):
        subprocess.run([str(self.binary / "pg_ctl"), "-D", str(self.data), "-l", str(self.log), "-w", "start"],
                       check=True, capture_output=True, text=True, timeout=20)
        self.started = True

    def stop(self):
        if self.started:
            subprocess.run([str(self.binary / "pg_ctl"), "-D", str(self.data), "-m", "fast", "-w", "stop"],
                           check=True, capture_output=True, text=True, timeout=20)
            self.started = False

    def query(self, sql, expect_error=None, timeout=10):
        result = subprocess.run(self.command, input=sql, capture_output=True, text=True, timeout=timeout)
        if expect_error:
            require(result.returncode != 0 and expect_error in result.stderr,
                    "Expected SQLSTATE " + expect_error + ": " + result.stderr[-800:])
            return result.stderr
        require(result.returncode == 0, "SQL failed: " + result.stderr[-1200:])
        return result.stdout.strip()

    @contextlib.contextmanager
    def hold(self, sql):
        # The sentinel is emitted only after PostgreSQL has acquired the lock.
        process = subprocess.Popen(self.command + ["-o", os.devnull], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, bufsize=1)
        selector = selectors.DefaultSelector()
        try:
            process.stdin.write("BEGIN;\n" + sql + ";\n\\echo LOCK_READY\n")
            process.stdin.flush()
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 10
            while True:
                require(time.monotonic() < deadline and process.poll() is None, "Lock holder did not become ready")
                if not selector.select(timeout=max(0, deadline - time.monotonic())):
                    continue
                line = process.stdout.readline()
                if line.strip() == "LOCK_READY":
                    break
            yield
        finally:
            selector.close()
            if process.poll() is None:
                process.stdin.write("ROLLBACK;\n\\q\n")
                process.stdin.flush()
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=5)

    def cleanup(self):
        self.stop()
        shutil.rmtree(self.root)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--pg-bin", default="/opt/homebrew/opt/postgresql@18/bin")
    parser.add_argument("--expected-migration-sha")
    args = parser.parse_args()
    sql_dir = args.repo / "karta/migrations"
    migration_bytes = {name: (sql_dir / name).read_bytes() for name in MIGRATIONS}
    hashes = {name: hashlib.sha256(value).hexdigest() for name, value in migration_bytes.items()}
    if args.expected_migration_sha:
        require(hashes[MIGRATIONS[-1]] == args.expected_migration_sha, "Migration changed before verification")
    results = {"scope": "native PostgreSQL, inert fixtures only, no Redis/provider integration claimed",
               "harness_sha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
               "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "migrations_sha256": hashes,
               "checks": [], "cleanup": "pending", "success": False}
    cluster = Cluster(args.pg_bin)

    def check(name, function):
        started = time.monotonic()
        try:
            evidence = function()
            item = {"name": name, "status": "PASS", "evidence": evidence}
        except Exception as error:
            item = {"name": name, "status": "FAIL", "error": str(error)[:1500]}
        item["duration_ms"] = round((time.monotonic() - started) * 1000)
        results["checks"].append(item)
        print(json.dumps(item), flush=True)

    def seed(resolved=False):
        cluster.query("TRUNCATE auth.users CASCADE; INSERT INTO auth.users(id) VALUES('" + OWNER + "');"
                      "INSERT INTO purama_ai.karta_global_state(id,kill_switch) VALUES('global',false) ON CONFLICT(id) DO UPDATE SET kill_switch=false;"
                      "INSERT INTO purama_ai.karta_agent_state(user_id,agent_type,simulation_mode) VALUES('" + OWNER + "','legal',false);"
                      "INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode,status,duration_ms,tools_used) VALUES('"
                      + PARENT + "','" + OWNER + "','legal','manual','live','awaiting_approval',1,'"
                      + json.dumps([{"tool": "inert", "pendingActionId": ACTION, "success": False, "outcome": "pending"}]) + "');"
                      "INSERT INTO purama_ai.karta_pending_actions(id,user_id,run_id,agent_type,tool_name,tool_params) VALUES('"
                      + ACTION + "','" + OWNER + "','" + PARENT + "','legal','inert','{\"private\":\"INERT_PRIVATE_SENTINEL\"}');")
        if resolved:
            cluster.query("SET ROLE service_role; SELECT jsonb_array_length(purama_ai.karta_claim_pending_action_bounded('" + ACTION + "','approve'));"
                          "SELECT purama_ai.karta_finalize_pending_action('" + ACTION + "','executed','INERT_PRIVATE_SENTINEL');")

    def lease():
        return cluster.query("SET ROLE service_role; SELECT lease_token FROM purama_ai.karta_claim_approval_outbox(5);")

    def prepare(token):
        return "SET ROLE service_role; SELECT purama_ai.karta_prepare_approval_outbox('" + ACTION + "','" + token + "','" + KEY + "','" + FINGERPRINT + "','" + LEGACY + "');"

    def finish(token):
        return "SET ROLE service_role; SELECT purama_ai.karta_finish_approval_outbox('" + ACTION + "','" + token + "','retry');"

    def atomic():
        seed(True)
        row = json.loads(cluster.query("SELECT row_to_json(o) FROM purama_ai.karta_approval_outbox o;"))
        require(row["status"] == "pending" and row["resolution"] == "executed" and row["execution_key"] is None, "Missing intent")
        require("INERT_PRIVATE_SENTINEL" not in json.dumps(row), "Private action content leaked into intent")
        cluster.query("SET ROLE service_role; SELECT purama_ai.karta_finalize_pending_action('" + ACTION + "','executed','idempotent');")
        require(json.loads(cluster.query("SELECT row_to_json(o) FROM purama_ai.karta_approval_outbox o;")) == row, "Idempotent call changed intent")
        return {"intent_count": 1, "private_payload_absent": True, "repeat_finalization_unchanged": True}

    def rollback():
        seed()
        cluster.query("SET ROLE service_role; SELECT jsonb_array_length(purama_ai.karta_claim_pending_action_bounded('" + ACTION + "','approve'));"
                      "UPDATE purama_ai.karta_runs SET tools_used='[]' WHERE id='" + PARENT + "';")
        cluster.query("SET ROLE service_role; SELECT purama_ai.karta_finalize_pending_action('" + ACTION + "','executed','inert');", expect_error="P0001")
        require(cluster.query("SELECT status FROM purama_ai.karta_pending_actions WHERE id='" + ACTION + "';") == "executing", "Action did not roll back")
        require(cluster.query("SELECT count(*) FROM purama_ai.karta_approval_outbox;") == "0", "Intent did not roll back")
        return {"action": "executing", "intent_count": 0}

    def concurrent_claims():
        seed(True)
        barrier = threading.Barrier(2)
        def claim():
            barrier.wait(timeout=5)
            return cluster.query("SET ROLE service_role; SELECT count(*) FROM purama_ai.karta_claim_approval_outbox(5);")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(claim), pool.submit(claim)]
            counts = sorted(int(future.result(timeout=10)) for future in futures)
        require(counts == [0, 1], "Two independent sessions claimed the same intent: " + str(counts))
        require(cluster.query("SELECT attempts FROM purama_ai.karta_approval_outbox;") == "1", "Duplicate attempt")
        return {"independent_sessions": 2, "claim_counts": counts, "attempts": 1}

    def skip_locked():
        seed(True)
        with cluster.hold("SELECT 1 FROM purama_ai.karta_approval_outbox FOR UPDATE"):
            started = time.monotonic()
            count = cluster.query("SET ROLE service_role; SELECT count(*) FROM purama_ai.karta_claim_approval_outbox(5);")
            elapsed = time.monotonic() - started
            require(count == "0" and elapsed < 1.5, "SKIP LOCKED waited or claimed locked row")
        require(bool(lease()), "Intent unavailable after lock release")
        return {"while_locked": 0, "elapsed_ms": round(elapsed * 1000), "claim_after_unlock": True}

    def stale():
        seed(True)
        old = lease()
        cluster.query("UPDATE purama_ai.karta_approval_outbox SET lease_until=now()-interval '1 second';")
        new = lease()
        require(old != new, "Lease token reused")
        require(cluster.query(prepare(old)) == "stale", "Expired owner prepared publication")
        require(cluster.query(finish(old)) == "f", "Expired owner acknowledged new lease")
        require(cluster.query(prepare(new)) == "ready", "Current owner could not prepare")
        return {"old_prepare": "stale", "old_finish": False, "new_prepare": "ready"}

    def permissions():
        denials = 0
        for role in ["anon", "authenticated"]:
            for statement in ["SELECT count(*) FROM purama_ai.karta_approval_outbox;",
                              "SELECT count(*) FROM purama_ai.karta_claim_approval_outbox(1);",
                              "SELECT purama_ai.karta_approval_outbox_health();",
                              "SELECT purama_ai.karta_claim_pending_action_bounded('" + ACTION + "','approve');"]:
                cluster.query("SET ROLE " + role + "; " + statement, expect_error="42501")
                denials += 1
        return {"client_access_denials": denials}

    def health():
        statement = "SET ROLE service_role; SELECT purama_ai.karta_approval_outbox_health();"
        require(json.loads(cluster.query(statement)) == {"protocol": 1, "ready": True}, "Fresh health not ready")
        cluster.query("REVOKE INSERT ON purama_ai.karta_approval_outbox FROM service_role;")
        try:
            require(json.loads(cluster.query(statement))["ready"] is False, "Missing one privilege accepted")
        finally:
            cluster.query("GRANT INSERT ON purama_ai.karta_approval_outbox TO service_role;")
        cluster.query("ALTER TABLE purama_ai.karta_pending_actions DISABLE TRIGGER karta_capture_approval_continuation;")
        try:
            require(json.loads(cluster.query(statement))["ready"] is False, "Disabled capture trigger accepted")
        finally:
            cluster.query("ALTER TABLE purama_ai.karta_pending_actions ENABLE TRIGGER karta_capture_approval_continuation;")
        require(json.loads(cluster.query(statement))["ready"] is True, "Restored health not ready")
        return {"fresh": True, "missing_insert_privilege": False, "disabled_trigger": False, "restored": True}

    def lock_bound(mode):
        seed(mode in ("prepare", "finish", "claim_outbox"))
        token = lease() if mode in ("prepare", "finish") else None
        if mode.startswith("finalize"):
            cluster.query("SET ROLE service_role; SELECT jsonb_array_length(purama_ai.karta_claim_pending_action_bounded('" + ACTION + "','approve'));")
        statements = {
            "claim_pending": "SELECT jsonb_array_length(purama_ai.karta_claim_pending_action_bounded('" + ACTION + "','approve'));",
            "claim_pending_table": "SELECT jsonb_array_length(purama_ai.karta_claim_pending_action_bounded('" + ACTION + "','approve'));",
            "claim_pending_parent_table": "SELECT jsonb_array_length(purama_ai.karta_claim_pending_action_bounded('" + ACTION + "','approve'));",
            "finalize": "SELECT purama_ai.karta_finalize_pending_action('" + ACTION + "','executed','inert');",
            "finalize_pending_table": "SELECT purama_ai.karta_finalize_pending_action('" + ACTION + "','executed','inert');",
            "finalize_parent_table": "SELECT purama_ai.karta_finalize_pending_action('" + ACTION + "','executed','inert');",
            "prepare": prepare(token or "00000000-0000-4000-8000-000000000704"),
            "finish": finish(token or "00000000-0000-4000-8000-000000000704"),
            "claim_outbox": "SELECT count(*) FROM purama_ai.karta_claim_approval_outbox(5);",
        }
        lock = ("SELECT 1 FROM purama_ai.karta_runs WHERE id='" + PARENT + "' FOR UPDATE") if mode in ("claim_pending", "finalize") else (
            "LOCK TABLE purama_ai.karta_runs IN ACCESS EXCLUSIVE MODE" if mode in ("claim_pending_parent_table", "finalize_parent_table") else (
            "LOCK TABLE purama_ai.karta_pending_actions IN ACCESS EXCLUSIVE MODE" if mode in ("claim_pending_table", "finalize_pending_table") else (
            "LOCK TABLE purama_ai.karta_approval_outbox IN ACCESS EXCLUSIVE MODE" if mode == "claim_outbox" else
            "SELECT 1 FROM purama_ai.karta_approval_outbox FOR UPDATE")))
        require(cluster.query("SHOW statement_timeout; SHOW lock_timeout;") == "0\n0", "Session timeout contaminated test")
        with cluster.hold(lock):
            started = time.monotonic()
            cluster.query("SET ROLE service_role; " + statements[mode], expect_error="55P03", timeout=8)
            elapsed = time.monotonic() - started
            require(1.5 < elapsed < 5, "Function lock bound not ~2s: " + str(elapsed))
        return {"independent_sessions": 2, "sqlstate": "55P03", "elapsed_ms": round(elapsed * 1000),
                "session_statement_timeout": "0", "session_lock_timeout": "0"}

    def restart():
        seed(True)
        before = cluster.query("SELECT row_to_json(o) FROM purama_ai.karta_approval_outbox o;")
        cluster.stop()
        cluster.start()
        require(cluster.query("SELECT row_to_json(o) FROM purama_ai.karta_approval_outbox o;") == before, "Durable intent lost on restart")
        require(bool(lease()), "Recovered intent not claimable")
        return {"postgres_restart": True, "same_intent": True, "claimable_after_restart": True}

    try:
        cluster.initialize()
        results["postgres_version"] = cluster.query("SELECT version();")
        require(cluster.query("SHOW listen_addresses;") == "", "Fixture unexpectedly listens on TCP")
        cluster.query("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);"
                      "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;"
                      "CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;"
                      "GRANT USAGE ON SCHEMA purama_ai,auth TO service_role,authenticated,anon;")
        for migration in MIGRATIONS:
            cluster.query(migration_bytes[migration].decode("utf8"), timeout=20)
        cluster.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA purama_ai TO service_role;")
        for name, test in [("atomic_finalize_and_private_minimal_intent", atomic), ("rollback_after_parent_patch_failure", rollback),
                           ("concurrent_native_claims", concurrent_claims), ("skip_locked_native", skip_locked),
                           ("expired_lease_cannot_ack", stale), ("client_privileges_denied", permissions),
                           ("health_attestation_fail_closed", health)]:
            check(name, test)
        for mode in ["claim_pending", "claim_pending_table", "claim_pending_parent_table", "finalize",
                     "finalize_pending_table", "finalize_parent_table", "prepare", "finish", "claim_outbox"]:
            check("native_lock_bound_" + mode, lambda mode=mode: lock_bound(mode))
        check("durable_intent_after_postgres_restart", restart)
    except Exception as error:
        results["checks"].append({"name": "harness", "status": "FAIL", "error": str(error)[:1800]})
    finally:
        try:
            cluster.cleanup()
            results["cleanup"] = "PASS: owned cluster stopped and temporary directory removed"
        except Exception as error:
            results["cleanup"] = "FAIL: " + str(error)[:800]
        results["success"] = len(results["checks"]) == 17 and all(x["status"] == "PASS" for x in results["checks"]) and results["cleanup"].startswith("PASS")
        results["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"success": results["success"], "checks": len(results["checks"]), "output": str(args.output), "cleanup": results["cleanup"]}), flush=True)
    return 0 if results["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

