#!/usr/bin/env python3
"""Exercise the actual OAuth migration in a private, disposable PostgreSQL cluster.

Only the two input files are read. All SQL actors, keys and effects are fixtures.
The helper TypeScript is fingerprinted, not executed by this native SQL bench.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import subprocess
import threading
import time
import traceback
import uuid


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Session:
    def __init__(self, bench, label):
        self.bench = bench
        self.label = label
        self.lines = []
        self.errors = []
        self.messages = queue.Queue()
        self.process = subprocess.Popen(
            bench.psql_command(), env=bench.client_env(label), text=True,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            bufsize=1,
        )
        bench.sessions.append(self)

        def read_stdout():
            for line in self.process.stdout:
                self.lines.append(line)
                self.messages.put(line.rstrip("\n"))

        def read_stderr():
            for line in self.process.stderr:
                self.errors.append(line)

        self.threads = [threading.Thread(target=read_stdout, daemon=True), threading.Thread(target=read_stderr, daemon=True)]
        for thread in self.threads:
            thread.start()

    def send(self, text):
        self.process.stdin.write(text)
        self.process.stdin.flush()

    def until(self, marker, timeout=8):
        end = time.monotonic() + timeout
        seen = []
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise AssertionError("Interactive psql did not reach " + marker)
            line = self.messages.get(timeout=remaining)
            seen.append(line)
            if line == marker:
                return seen

    def finish(self, commit=True):
        if self.process.poll() is None:
            self.send(("COMMIT;" if commit else "ROLLBACK;") + "\n\\q\n")
            self.process.stdin.close()
            self.process.wait(timeout=10)
        for thread in self.threads:
            thread.join(timeout=2)
        result = {"label": self.label, "exit_code": self.process.returncode, "stdout": "".join(self.lines), "stderr": "".join(self.errors)}
        self.bench.transcript.append(result)
        assert self.process.returncode == 0, result
        return result


class Bench:
    def __init__(self, args):
        self.args = args
        self.bin = Path(args.pg_bin)
        self.out = Path(args.output)
        self.out.mkdir(parents=True, exist_ok=True)
        self.run_id = "oauth_native_" + uuid.uuid4().hex[:10]
        self.cluster = Path(args.fixture_root) / ("cluster-" + self.run_id)
        self.cluster.mkdir(parents=True, exist_ok=False)
        self.data = self.cluster / "data"
        self.transcript = []
        self.sessions = []
        self.children = []
        self.started = False
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
        self.env["PGPASSWORD"] = ""
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        self.env.update({"PGHOST": "127.0.0.1", "PGPORT": str(self.port), "PGDATABASE": "postgres", "PGUSER": "oauth_test_admin", "PGCONNECT_TIMEOUT": "3", "PGOPTIONS": "-c statement_timeout=12000 -c lock_timeout=10000"})
        self.actor = "00000000-0000-4000-8000-000000000001"
        self.other = "00000000-0000-4000-8000-000000000002"
        self.third = "00000000-0000-4000-8000-000000000003"
        self.next_key = 1
        self.report = {
            "run_id": self.run_id,
            "migration_sha256": sha256(args.migration),
            "helper_sha256": sha256(args.helper),
            "runner_sha256": sha256(__file__),
            "port": self.port,
            "cluster": str(self.cluster),
            "started_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "cases": [],
            "runtime_scope": "Native PostgreSQL migration only; TypeScript helper fingerprinted and read separately.",
            "provider_calls": 0,
            "production_connections": 0,
        }

    def client_env(self, label):
        return {**self.env, "PGAPPNAME": self.run_id + "_" + label}

    def psql_command(self):
        return [str(self.bin / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"]

    def command(self, label, args, **kwargs):
        proc = subprocess.run(args, env=self.env, text=True, capture_output=True, timeout=30, **kwargs)
        self.transcript.append({"label": label, "command": args, "exit_code": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr})
        return proc

    def sql(self, statement, label="query", role=None, expect_error=None):
        sql = (("SET ROLE " + role + "; ") if role else "") + statement
        proc = subprocess.run(self.psql_command() + ["-c", sql], env=self.client_env(label), text=True, capture_output=True, timeout=18)
        self.transcript.append({"label": label, "sql": sql, "exit_code": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr})
        if expect_error:
            assert proc.returncode != 0 and expect_error in proc.stderr, {"expected_sqlstate": expect_error, "stdout": proc.stdout, "stderr": proc.stderr}
            return {"sqlstate": expect_error, "exit_code": proc.returncode}
        assert proc.returncode == 0, {"sql": sql, "stderr": proc.stderr, "exit_code": proc.returncode}
        return proc.stdout.strip()

    def json_sql(self, statement, **kwargs):
        return json.loads(self.sql(statement, **kwargs).splitlines()[-1])

    def key(self):
        value = format(self.next_key, "064x")
        self.next_key += 1
        return value

    def create(self, key, purpose="google_connections", provider="google_drive", actor=None):
        actor = actor or self.actor
        return self.sql("SELECT purama_ai.create_oauth_connection_state('%s','%s','%s','%s');" % (key, actor, purpose, provider), label="create", role="service_role")

    def consume_statement(self, key, purpose="google_connections", actor="default"):
        actor = self.actor if actor == "default" else actor
        literal = "NULL" if actor is None else "'%s'::uuid" % actor
        return "SELECT jsonb_build_object('backend_pid', pg_backend_pid(), 'receipts', COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb)) FROM purama_ai.consume_oauth_connection_state('%s','%s',%s) AS r;" % (key, purpose, literal)

    def consume(self, key, purpose="google_connections", actor="default"):
        return self.json_sql(self.consume_statement(key, purpose, actor), label="consume", role="service_role")["receipts"]

    def pending(self, key):
        return self.sql("SELECT consumed_at IS NULL FROM purama_ai.oauth_connection_states WHERE state_hash='%s';" % key, label="pending") == "t"

    def case(self, name, action):
        start = time.monotonic()
        try:
            detail = action()
            row = {"name": name, "status": "PASS", "detail": detail}
        except Exception as error:
            row = {"name": name, "status": "FAIL", "error": str(error), "traceback": traceback.format_exc()}
        row["seconds"] = round(time.monotonic() - start, 3)
        self.report["cases"].append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)

    def start(self):
        init = self.command("initdb", [str(self.bin / "initdb"), "-D", str(self.data), "--username=oauth_test_admin", "--auth=trust", "--no-locale", "--encoding=UTF8"])
        assert init.returncode == 0, init.stderr
        options = "-h 127.0.0.1 -p %d -k '' -c shared_buffers=16MB -c max_connections=32" % self.port
        # Even a timed-out pg_ctl start may have launched this private server.
        # Cleanup must inspect its own data directory before removing anything.
        self.started = True
        start = self.command("pg-start", [str(self.bin / "pg_ctl"), "-D", str(self.data), "-l", str(self.out / "postgres.log"), "-o", options, "-w", "-t", "20", "start"])
        assert start.returncode == 0, start.stderr
        identity = self.json_sql("SELECT jsonb_build_object('data_directory', current_setting('data_directory'), 'server_version', current_setting('server_version'), 'listen_addresses', current_setting('listen_addresses'), 'unix_socket_directories', current_setting('unix_socket_directories'), 'system_identifier', system_identifier::text) FROM pg_control_system();", label="cluster-identity")
        assert Path(identity["data_directory"]).resolve() == self.data.resolve(), identity
        assert identity["listen_addresses"] == "127.0.0.1" and identity["unix_socket_directories"] == "", identity
        self.report["cluster_identity"] = identity
        self.sql("CREATE ROLE anon NOLOGIN NOBYPASSRLS; CREATE ROLE authenticated NOLOGIN NOBYPASSRLS; CREATE ROLE service_role NOLOGIN NOBYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA purama_ai; GRANT USAGE ON SCHEMA purama_ai TO anon, authenticated, service_role; INSERT INTO auth.users(id) VALUES ('%s'),('%s'),('%s');" % (self.actor, self.other, self.third), label="fixture-schema")
        self.sql(Path(self.args.migration).read_text(), label="actual-migration")

    def metadata(self):
        result = self.json_sql("SELECT jsonb_build_object('rls_enabled',(SELECT relrowsecurity FROM pg_class WHERE oid='purama_ai.oauth_connection_states'::regclass),'service_bypasses_rls',(SELECT rolbypassrls FROM pg_roles WHERE rolname='service_role'),'functions',(SELECT jsonb_agg(jsonb_build_object('name',proname,'security_definer',prosecdef,'config',proconfig)) FROM pg_proc WHERE oid IN ('purama_ai.create_oauth_connection_state(text,uuid,text,text)'::regprocedure,'purama_ai.consume_oauth_connection_state(text,text,uuid)'::regprocedure)));", label="metadata")
        assert result["rls_enabled"] and not result["service_bypasses_rls"], result
        assert len(result["functions"]) == 2 and all(not fn["security_definer"] and fn["config"] == ['search_path=""'] for fn in result["functions"]), result
        return result

    def issue_and_replay(self):
        key = self.key()
        expiry = self.create(key)
        row = self.json_sql("SELECT jsonb_build_object('lifetime_seconds',extract(epoch FROM expires_at-created_at),'user_id',user_id,'provider',provider,'pending',consumed_at IS NULL) FROM purama_ai.oauth_connection_states WHERE state_hash='%s';" % key, label="lifetime")
        assert row["lifetime_seconds"] == 600 and row["pending"] and row["user_id"] == self.actor, row
        first = self.consume(key)
        assert first == [{"user_id": self.actor, "provider": "google_drive", "return_path": "/mes-connexions"}], first
        assert self.consume(key) == [], "Replay was admitted"
        return {"expires_at": expiry, "lifetime_seconds": row["lifetime_seconds"], "first": first, "replay": []}

    def purpose_and_actor(self):
        key = self.key()
        self.create(key)
        probes = [("wrong-purpose", "email_agent_gmail", self.actor), ("wrong-actor", "google_connections", self.other), ("null-actor", "google_connections", None)]
        for label, purpose, actor in probes:
            assert self.consume(key, purpose, actor) == [] and self.pending(key), label
        assert len(self.consume(key)) == 1
        gmail = self.key()
        self.create(gmail, "email_agent_gmail", "gmail")
        assert self.consume(gmail, "email_agent_gmail", None) == [] and self.pending(gmail), "Gmail NULL actor was admitted"
        assert self.consume(gmail, "email_agent_gmail", self.other) == [] and self.pending(gmail), "Gmail wrong actor was admitted"
        result = self.consume(gmail, "email_agent_gmail", self.actor)
        assert result == [{"user_id": self.actor, "provider": "gmail", "return_path": "/dashboard/email-agent"}], result
        return {"google_refusals": [p[0] for p in probes], "gmail_null_and_wrong_actor_refused": True, "authorized_gmail": result}

    def expired(self):
        key = self.key()
        self.create(key)
        self.sql("UPDATE purama_ai.oauth_connection_states SET created_at=clock_timestamp()-interval '11 minutes', expires_at=clock_timestamp()-interval '1 minute' WHERE state_hash='%s';" % key, label="expire-fixture")
        assert self.consume(key) == [] and self.pending(key)
        return {"already_expired_receipts": 0, "consumed_at_unchanged": True}

    def invalid_inputs(self):
        invalid = ["SELECT purama_ai.create_oauth_connection_state('bad','%s','google_connections','gmail');" % self.actor,
                   "SELECT purama_ai.create_oauth_connection_state('%s','%s','email_agent_gmail','google_drive');" % (self.key(), self.actor),
                   "SELECT purama_ai.create_oauth_connection_state('%s',NULL,'google_connections','gmail');" % self.key()]
        for sql in invalid:
            self.sql(sql, label="invalid-create", role="service_role", expect_error="22023")
        bad = self.consume("bad")
        wrong_purpose = self.consume(self.key(), "unknown-purpose")
        assert bad == [] and wrong_purpose == []
        return {"invalid_creates_sqlstate": "22023", "rejected_creates": len(invalid), "invalid_consumes": 2}

    def permissions(self):
        key = self.key()
        self.create(key)
        probes = {
            "select": "SELECT * FROM purama_ai.oauth_connection_states;",
            "insert": "INSERT INTO purama_ai.oauth_connection_states VALUES ('%s','%s','google_connections','gmail',clock_timestamp(),clock_timestamp()+interval '10 minutes',NULL);" % (self.key(), self.actor),
            "update": "UPDATE purama_ai.oauth_connection_states SET consumed_at=clock_timestamp() WHERE state_hash='%s';" % key,
            "delete": "DELETE FROM purama_ai.oauth_connection_states WHERE state_hash='%s';" % key,
            "create_rpc": "SELECT purama_ai.create_oauth_connection_state('%s','%s','google_connections','gmail');" % (self.key(), self.actor),
            "consume_rpc": self.consume_statement(key),
        }
        results = []
        for role in ("anon", "authenticated"):
            for label, sql in probes.items():
                results.append({"role": role, "operation": label, **self.sql(sql, label=role+"-"+label, role=role, expect_error="42501")})
        assert self.pending(key), "Unauthorized probe changed the receipt"
        return results

    def wait_for_locks(self, labels, timeout=7):
        end = time.monotonic() + timeout
        names = ",".join("'%s'" % (self.run_id + "_" + label) for label in labels)
        latest = []
        while time.monotonic() < end:
            latest = self.json_sql("SELECT COALESCE(jsonb_agg(jsonb_build_object('pid',pid,'app',application_name,'state',state,'wait_event_type',wait_event_type,'wait_event',wait_event)), '[]'::jsonb) FROM pg_stat_activity WHERE application_name IN (%s);" % names, label="observe-locks")
            if len(latest) == len(labels) and all(row["wait_event_type"] == "Lock" for row in latest):
                return latest
            time.sleep(0.05)
        raise AssertionError({"expected_waiting_clients": len(labels), "observed": latest})

    def held_row(self, key, label):
        session = Session(self, label)
        session.send("BEGIN;\nSELECT pg_backend_pid();\nSELECT state_hash FROM purama_ai.oauth_connection_states WHERE state_hash='%s' FOR UPDATE;\n\\echo LOCK_READY\n" % key)
        session.until("LOCK_READY")
        return session

    def spawn_consumer(self, key, label):
        process = subprocess.Popen(self.psql_command() + ["-c", "SET ROLE service_role; " + self.consume_statement(key)], env=self.client_env(label), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(process)
        return process

    def read_consumer(self, process, label):
        stdout, stderr = process.communicate(timeout=8)
        result = {"label": label, "exit_code": process.returncode, "stdout": stdout, "stderr": stderr}
        self.transcript.append(result)
        assert process.returncode == 0, result
        return json.loads(stdout.strip().splitlines()[-1])

    def concurrent_consumption(self):
        key = self.key()
        self.create(key)
        holder = self.held_row(key, "concurrency-holder")
        labels = ["parallel-%02d" % index for index in range(12)]
        clients = []
        try:
            clients = [self.spawn_consumer(key, label) for label in labels]
            observed = self.wait_for_locks(labels)
        finally:
            holder.finish()
        results = [self.read_consumer(client, label) for label, client in zip(labels, clients)]
        assert len({row["backend_pid"] for row in results}) == 12, results
        assert sum(len(row["receipts"]) for row in results) == 1, results
        assert self.sql("SELECT count(*) FROM purama_ai.oauth_connection_states WHERE state_hash='%s' AND consumed_at IS NOT NULL;" % key) == "1"
        return {"simultaneously_blocked": observed, "client_results": results, "total_receipts": 1}

    def expiry_while_waiting(self):
        key = self.key()
        self.create(key)
        self.sql("UPDATE purama_ai.oauth_connection_states SET created_at=clock_timestamp()-interval '1 minute', expires_at=clock_timestamp()+interval '3 seconds' WHERE state_hash='%s';" % key, label="short-expiry-fixture")
        holder = self.held_row(key, "expiry-holder")
        process = None
        try:
            process = self.spawn_consumer(key, "expiry-client")
            observed = self.wait_for_locks(["expiry-client"])
            was_valid = self.sql("SELECT expires_at>clock_timestamp() FROM purama_ai.oauth_connection_states WHERE state_hash='%s';" % key, label="valid-before-wait")
            assert was_valid == "t", "Fixture expired before contention was observed"
            end = time.monotonic() + 6
            expired = False
            while time.monotonic() < end:
                if self.sql("SELECT expires_at<=clock_timestamp() FROM purama_ai.oauth_connection_states WHERE state_hash='%s';" % key, label="expiry-observer") == "t":
                    expired = True
                    break
                time.sleep(0.08)
            assert expired, "Fixture did not expire while blocked"
        finally:
            holder.finish()
        result = self.read_consumer(process, "expiry-client")
        final = self.json_sql("SELECT jsonb_build_object('expires_at',expires_at,'consumed_at',consumed_at,'observed_at',clock_timestamp()) FROM purama_ai.oauth_connection_states WHERE state_hash='%s';" % key, label="expiry-final")
        detail = {"blocked": observed, "valid_at_lock_wait": was_valid == "t", "expired_before_unlock": expired, "result": result, "row": final}
        assert result["receipts"] == [] and final["consumed_at"] is None, detail
        return detail

    def rollback_consumption(self):
        key = self.key()
        self.create(key)
        observed = self.sql("BEGIN; SET LOCAL ROLE service_role; " + self.consume_statement(key) + " ROLLBACK;", label="consume-rollback")
        result = json.loads(observed.splitlines()[-1])
        assert len(result["receipts"]) == 1 and self.pending(key), result
        assert len(self.consume(key)) == 1 and self.consume(key) == []
        return {"inside_rolled_back_transaction": result, "pending_after_rollback": True, "subsequent_committed_receipts": 1}

    def rollback_issue_cleanup(self):
        live = self.key()
        self.create(live, actor=self.other)
        expired = self.key()
        self.create(expired)
        self.sql("UPDATE purama_ai.oauth_connection_states SET created_at=clock_timestamp()-interval '11 minutes', expires_at=clock_timestamp()-interval '1 minute' WHERE state_hash='%s';" % expired)
        self.sql("SELECT purama_ai.create_oauth_connection_state('%s','%s','google_connections','gmail');" % (live, self.actor), label="issue-rollback", role="service_role", expect_error="23505")
        assert self.sql("SELECT count(*) FROM purama_ai.oauth_connection_states WHERE state_hash='%s';" % expired) == "1"
        assert self.sql("SELECT user_id FROM purama_ai.oauth_connection_states WHERE state_hash='%s';" % live) == self.other
        return {"duplicate_hash_sqlstate": "23505", "expired_cleanup_rolled_back": True, "other_actor_receipt_preserved": True}

    def actor_cascade(self):
        google = self.key()
        gmail = self.key()
        self.create(google, actor=self.third)
        self.create(gmail, "email_agent_gmail", "gmail", actor=self.third)
        self.sql("DELETE FROM auth.users WHERE id='%s';" % self.third, label="delete-fixture-actor")
        assert self.sql("SELECT count(*) FROM purama_ai.oauth_connection_states WHERE user_id='%s';" % self.third) == "0"
        assert self.consume(google, actor=self.third) == [] and self.consume(gmail, "email_agent_gmail", self.third) == []
        return {"deleted_actor_receipts_remaining": 0, "both_purposes_unusable": True}

    def cleanup(self):
        errors = []
        for session in self.sessions:
            if session.process.poll() is None:
                try:
                    session.finish(commit=False)
                except Exception as error:
                    errors.append(str(error))
                    session.process.terminate()
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        stopped = not self.started
        if self.started:
            try:
                stop = self.command("pg-stop", [str(self.bin / "pg_ctl"), "-D", str(self.data), "-m", "fast", "-w", "-t", "15", "stop"])
                status = self.command("pg-status-after-stop", [str(self.bin / "pg_ctl"), "-D", str(self.data), "status"])
                stopped = status.returncode == 3
                if not stopped:
                    errors.append("Native cluster stop was not confirmed")
            except Exception as error:
                errors.append(str(error))
        if stopped:
            shutil.rmtree(self.cluster)
        with socket.socket() as probe:
            probe.settimeout(1)
            port_closed = probe.connect_ex(("127.0.0.1", self.port)) != 0
        self.report["cleanup"] = {"stopped": stopped, "cluster_removed": not self.cluster.exists(), "port_closed": port_closed, "errors": errors}
        self.report["inputs_unchanged"] = sha256(self.args.migration) == self.report["migration_sha256"] and sha256(self.args.helper) == self.report["helper_sha256"]

    def run(self):
        try:
            self.start()
            for name, action in [
                ("invoker_rls_metadata", self.metadata),
                ("ten_minute_issue_and_single_replay", self.issue_and_replay),
                ("purpose_and_verified_actor_for_both_providers", self.purpose_and_actor),
                ("already_expired_state", self.expired),
                ("invalid_inputs", self.invalid_inputs),
                ("anon_authenticated_acl", self.permissions),
                ("twelve_native_consumers_one_receipt", self.concurrent_consumption),
                ("expiry_rechecked_after_lock_wait", self.expiry_while_waiting),
                ("consume_transaction_rollback", self.rollback_consumption),
                ("issue_cleanup_rollback_on_collision", self.rollback_issue_cleanup),
                ("deleted_actor_cascades_receipts", self.actor_cascade),
            ]:
                self.case(name, action)
        except Exception as error:
            self.report["setup_error"] = str(error)
            self.report["setup_traceback"] = traceback.format_exc()
        finally:
            self.cleanup()
            self.report["finished_at_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            self.report["success"] = not self.report.get("setup_error") and len(self.report["cases"]) == 11 and all(row["status"] == "PASS" for row in self.report["cases"]) and self.report["inputs_unchanged"] and all(self.report["cleanup"][key] for key in ["stopped", "cluster_removed", "port_closed"]) and not self.report["cleanup"]["errors"]
            (self.out / "result.json").write_text(json.dumps(self.report, indent=2, ensure_ascii=False) + "\n")
            (self.out / "transcript.json").write_text(json.dumps(self.transcript, indent=2, ensure_ascii=False) + "\n")
            print("FINAL_RESULT " + json.dumps(self.report, ensure_ascii=False), flush=True)
        return 0 if self.report["success"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pg-bin", required=True)
    parser.add_argument("--migration", required=True)
    parser.add_argument("--helper", required=True)
    parser.add_argument("--fixture-root", required=True)
    parser.add_argument("--output", required=True)
    raise SystemExit(Bench(parser.parse_args()).run())
