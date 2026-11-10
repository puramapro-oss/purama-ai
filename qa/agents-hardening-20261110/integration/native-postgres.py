#!/usr/bin/env python3
"""Native PostgreSQL concurrency checks in a disposable, Unix-socket-only cluster.

Python standard library only. No inherited PG* configuration, existing server,
provider, payment or email is used. SIGINT/SIGTERM and ordinary failures execute
the same cleanup; an OS SIGKILL cannot be handled by a Python finally block.

Example:
  python3 native-postgres.py /path/to/checkout --pg-bin /opt/homebrew/bin --quarantine
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
import uuid


OWNER = "00000000-0000-4000-8000-000000009001"
OTHER = "00000000-0000-4000-8000-000000009002"
DB_USER = "purama_test"
DB_NAME = "purama_test"
PORT = "55439"  # Only a filename in the private socket directory; no TCP listener.


class CheckFailure(RuntimeError):
    pass


def require(condition, message, observed=None):
    if not condition:
        suffix = "" if observed is None else ": " + json.dumps(observed, sort_keys=True)
        raise CheckFailure(message + suffix)


def quoted(value):
    return "'" + str(value).replace("'", "''") + "'"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def json_rows(text):
    return [json.loads(line) for line in text.splitlines()
            if line.strip().startswith(("{", "["))]


def binaries(pg_bin):
    names = ("initdb", "pg_ctl", "psql", "postgres")
    if pg_bin:
        found = {name: Path(pg_bin).expanduser().resolve() / name for name in names}
    else:
        found = {}
        for name in names:
            location = shutil.which(name)
            if location is None and (Path("/opt/homebrew/bin") / name).is_file():
                location = str(Path("/opt/homebrew/bin") / name)
            require(location is not None, "PostgreSQL binary missing: " + name)
            found[name] = Path(location).resolve()
    for name, path in found.items():
        require(path.is_file() and os.access(path, os.X_OK), "Binary is not executable", str(path))
    return {name: str(path) for name, path in found.items()}


class Cluster:
    def __init__(self, args, report):
        self.args = args
        self.root = Path(args.checkout).expanduser().resolve()
        self.report = report
        self.bin = binaries(args.pg_bin)
        self.private = Path(tempfile.mkdtemp(prefix="purama-pg-", dir="/tmp"))
        os.chmod(self.private, 0o700)
        self.data = self.private / "data"
        self.socket = self.private / "socket"
        self.socket.mkdir(mode=0o700)
        self.passfile = self.private / "empty.pgpass"
        self.passfile.touch(mode=0o600)
        self.server_log = self.private / "postgres.log"
        self.live = []
        self.start_attempted = False
        # Do not copy os.environ: PGHOST/PGSERVICE/PGOPTIONS/PGPASSFILE and shell
        # configuration must never redirect a test to an existing server.
        self.env = {
            "PATH": str(Path(self.bin["postgres"]).parent) + os.pathsep + os.defpath,
            "LANG": "C", "LC_ALL": "C", "TZ": "UTC",
            "PGPASSFILE": str(self.passfile),
        }
        require(len(str(self.socket / (".s.PGSQL." + PORT)).encode()) < 100,
                "Private Unix socket path is too long")
        report["private_cluster"] = str(self.private)
        report["inherited_pg_environment"] = False

    def spawn(self, argv, label, sql=None, interactive=False):
        record = {"label": label, "argv": argv, "started_at_epoch": time.time()}
        if sql is not None:
            record["sql"] = sql
            record["sql_sha256"] = sha256(sql.encode())
        self.report["commands"].append(record)
        process = subprocess.Popen(
            argv, cwd=str(self.root), env=self.env, text=True,
            stdin=subprocess.PIPE if interactive else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
        )
        job = {"process": process, "record": record}
        self.live.append(job)
        return job

    def collect(self, job, check=True, timeout=40):
        process, record = job["process"], job["record"]
        try:
            out, err = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                out, err = process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()  # This exact psql/pg_ctl child only, never a server PID.
                out, err = process.communicate()
            record["timeout"] = True
        record.update(returncode=process.returncode, stdout=out, stderr=err,
                      elapsed_seconds=round(time.time() - record["started_at_epoch"], 4))
        if job in self.live:
            self.live.remove(job)
        if check:
            require(process.returncode == 0 and not record.get("timeout"),
                    "Command failed: " + record["label"], record)
        return record

    def run(self, argv, label, check=True, timeout=40):
        return self.collect(self.spawn(argv, label), check=check, timeout=timeout)

    def psql_argv(self, database=DB_NAME):
        return [self.bin["psql"], "-X", "-w", "-q", "-A", "-t",
                "--host", str(self.socket), "--port", PORT,
                "--username", DB_USER, "--dbname", database,
                "--set", "ON_ERROR_STOP=1", "--set", "VERBOSITY=verbose"]

    def sql_job(self, sql, label, database=DB_NAME):
        return self.spawn(self.psql_argv(database) + ["-c", sql], label, sql=sql)

    def sql(self, sql, label, check=True, database=DB_NAME):
        return self.collect(self.sql_job(sql, label, database), check=check)

    def value(self, sql, label):
        rows = json_rows(self.sql(sql, label)["stdout"])
        require(len(rows) == 1, "Expected one JSON result: " + label, rows)
        return rows[0]

    def interactive(self, sql, label):
        job = self.spawn(self.psql_argv() + ["-f", "-"], label, sql=sql, interactive=True)
        job["process"].stdin.write(sql + "\n")
        job["process"].stdin.flush()
        return job

    def finish_input(self, job, sql):
        job["record"]["sql"] += "\n" + sql
        job["record"]["sql_sha256"] = sha256(job["record"]["sql"].encode())
        job["process"].stdin.write(sql + "\n")
        job["process"].stdin.close()
        job["process"].stdin = None

    def start(self):
        require(os.name == "posix" and os.geteuid() != 0,
                "Run initdb as a normal OS user; this script does not escalate or create OS users")
        versions = {}
        for name in ("initdb", "pg_ctl", "psql", "postgres"):
            versions[name] = self.run([self.bin[name], "--version"], name + " version")["stdout"].strip()
        self.report["versions"] = versions
        majors = {re.search(r"\b(\d+)(?:\.\d+)?\b", value).group(1) for value in versions.values()}
        require(len(majors) == 1, "PostgreSQL binaries must have the same major version", versions)
        self.run([self.bin["initdb"], "-D", str(self.data), "-U", DB_USER,
                  "-A", "trust", "--no-locale", "--encoding=UTF8"], "initialize private cluster")
        with (self.data / "postgresql.conf").open("a") as config:
            config.write("\n# Isolated test settings; no external connections.\n")
            config.write("listen_addresses = ''\n")
            config.write("unix_socket_directories = " + quoted(self.socket) + "\n")
            config.write("unix_socket_permissions = 0700\nport = " + PORT + "\n")
            config.write("max_connections = 40\nshared_buffers = '32MB'\nwork_mem = '1MB'\n")
            config.write("timezone = 'UTC'\nlog_timezone = 'UTC'\n")
            config.write("default_transaction_isolation = 'read committed'\n")
        self.start_attempted = True
        self.run([self.bin["pg_ctl"], "-D", str(self.data), "-l", str(self.server_log),
                  "-p", self.bin["postgres"], "-w", "-t", "30", "start"], "start private server")
        self.sql("CREATE DATABASE " + DB_NAME, "create private test database", database="postgres")
        settings = self.value("""SELECT json_build_object(
          'version',version(),'listen_addresses',current_setting('listen_addresses'),
          'socket',current_setting('unix_socket_directories'),
          'data_directory',current_setting('data_directory'),
          'isolation',current_setting('default_transaction_isolation'),
          'unix_connection',inet_server_addr() IS NULL,
          'database',current_database(),'user',current_user)""", "verify isolated server")
        require(settings["listen_addresses"] == "" and settings["unix_connection"] is True,
                "Server must have no TCP listener and client must use Unix socket", settings)
        require(Path(settings["data_directory"]).resolve() == self.data.resolve()
                and settings["database"] == DB_NAME and settings["user"] == DB_USER,
                "Connected to unexpected database", settings)
        self.report["server_settings"] = settings

    def migration(self, relative):
        path = (self.root / relative).resolve()
        require(path.is_file() and self.root in path.parents, "Required migration missing", relative)
        raw = path.read_bytes()
        snapshot_dir = self.private / "migrations"
        snapshot_dir.mkdir(mode=0o700, exist_ok=True)
        snapshot = snapshot_dir / path.name
        snapshot.write_bytes(raw)
        self.report["migrations"].append({"path": relative, "sha256": sha256(raw),
                                          "executed_snapshot": str(snapshot)})
        self.run(self.psql_argv() + ["-f", str(snapshot)], "migration " + relative)

    def bootstrap(self):
        self.sql("""CREATE ROLE anon; CREATE ROLE authenticated;
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
          CREATE SCHEMA auth; CREATE SCHEMA purama_ai;
          CREATE TABLE auth.users(id uuid PRIMARY KEY);
          CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
            SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
          $$;
          GRANT USAGE ON SCHEMA auth,purama_ai TO anon,authenticated,service_role;
          INSERT INTO auth.users(id) VALUES (%s),(%s);
        """ % (quoted(OWNER), quoted(OTHER)), "auth-only test stubs")
        # Historical broad grants precede the actual newer server-only grants.
        for relative in (
            "supabase/migrations/20260406230000_partner_agent.sql",
            "supabase/migrations/20260727020000_overage_credits.sql",
            "supabase/migrations/20261110000200_overage_credit_idempotency.sql",
            "supabase/migrations/20261110030000_partner_outreach_reservations.sql",
        ):
            self.migration(relative)
        for filename in (
            "008_chef_control_plane.sql", "009_chef_hardening.sql", "010_chef_reliability.sql",
            "011_chef_runtime_policy.sql", "012_chef_mission_ingest.sql", "013_chef_independent_review.sql",
            "014_chef_file_ownership.sql", "015_chef_mission_file_ownership.sql", "016_chef_scoped_evidence.sql",
            "017_chef_evidence_generation.sql", "021_chef_budget_admission.sql", "022_chef_mission_estimates.sql",
        ):
            self.migration("karta/migrations/" + filename)
        quarantine = self.root / "karta/migrations/023_chef_process_quarantine.sql"
        if quarantine.is_file():
            self.migration("karta/migrations/023_chef_process_quarantine.sql")
        else:
            require(not self.args.quarantine, "--quarantine requires the real migration 023")

    def transaction(self, name, select_sql, hold=None):
        pause = self.args.hold_seconds if hold is None else hold
        return ("SET application_name=" + quoted(name) + "; BEGIN; "
                "SET TRANSACTION ISOLATION LEVEL READ COMMITTED; "
                "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='12s'; "
                "SET LOCAL ROLE service_role; " + select_sql + "; "
                "SELECT pg_sleep(" + str(pause) + "); COMMIT;")

    def activity(self, prefix):
        return self.value("""SELECT json_build_object('sessions',count(*),
          'pids',coalesce(json_agg(pid),'[]'::json),
          'lock_waiters',count(*) FILTER (WHERE wait_event_type='Lock'))
          FROM pg_stat_activity WHERE left(application_name,%d)=%s"""
          % (len(prefix), quoted(prefix)), "observe concurrent sessions " + prefix)

    def parallel(self, label, statements):
        prefix = "purama_" + uuid.uuid4().hex[:10] + "_"
        jobs = []
        observations = []
        results = []
        try:
            for i, statement in enumerate(statements):
                sql = self.transaction(prefix + str(i), "SELECT pg_sleep(0.35); " + statement)
                jobs.append(self.sql_job(sql, label + " connection " + str(i)))
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and any(j["process"].poll() is None for j in jobs):
                snapshot = self.activity(prefix)
                observations.append(snapshot)
                if snapshot["sessions"] >= len(jobs) and snapshot["lock_waiters"] > 0:
                    break
                time.sleep(0.03)
            for job in jobs:
                result = self.collect(job)
                rows = json_rows(result["stdout"])
                require(len(rows) == 1, "Expected one receipt per connection", result)
                results.append(rows[0])
        finally:
            for job in jobs:
                if job in self.live:
                    self.collect(job, check=False, timeout=20)
        pids = [item["backend_pid"] for item in results]
        require(len(set(pids)) == len(statements), "Connections did not have distinct native backend PIDs", pids)
        peak = max((s["sessions"] for s in observations), default=0)
        lock_waiters = max((s["lock_waiters"] for s in observations), default=0)
        overlapping_contention = any(s["sessions"] >= min(8, len(statements)) and s["lock_waiters"] > 0
                                     for s in observations)
        require(overlapping_contention,
                "Parallel overlap/lock contention was not observed", observations)
        return {"receipts": results, "backend_pids": pids,
                "peak_parallel_sessions": peak, "max_lock_waiters": lock_waiters,
                "observations": observations}

    def wait_until(self, sql, label, timeout=4):
        deadline = time.monotonic() + timeout
        observed = None
        while time.monotonic() < deadline:
            observed = self.value(sql, label)
            if observed.get("ready"):
                return observed
            time.sleep(0.03)
        raise CheckFailure(label + " not observed: " + json.dumps(observed))

    def cleanup(self):
        child_errors = []
        for job in list(self.live):
            try:
                process = job["process"]
                if process.stdin:
                    process.stdin.close()
                    process.stdin = None
                if process.poll() is None:
                    process.terminate()
                self.collect(job, check=False, timeout=3)
            except Exception as error:
                # A failed client cleanup must not bypass the server shutdown.
                child_errors.append(str(error))
        stopped = True
        if self.start_attempted:
            status = self.run([self.bin["pg_ctl"], "-D", str(self.data), "status"],
                              "private server status before cleanup", check=False)
            if status["returncode"] == 0 or (self.data / "postmaster.pid").exists():
                for mode in ("fast", "immediate"):
                    self.run([self.bin["pg_ctl"], "-D", str(self.data), "-m", mode,
                              "-w", "-t", "15", "stop"], "stop own server " + mode,
                             check=False, timeout=20)
                    status = self.run([self.bin["pg_ctl"], "-D", str(self.data), "status"],
                                      "verify own server stopped", check=False)
                    if status["returncode"] != 0 and not (self.data / "postmaster.pid").exists():
                        break
                stopped = status["returncode"] != 0 and not (self.data / "postmaster.pid").exists()
        self.report["cleanup"] = {"server_stopped": stopped, "temporary_cluster_removed": False,
                                  "client_cleanup_errors": child_errors}
        if self.server_log.is_file():
            self.report["server_log_tail"] = self.server_log.read_text(errors="replace")[-30000:]
        if stopped:
            shutil.rmtree(self.private)
            self.report["cleanup"]["temporary_cluster_removed"] = True
        require(stopped, "Could not confirm shutdown of this script's private cluster", str(self.private))


def create_mission(cluster, name, repo, tasks, budget=100):
    brief_tasks = []
    for i, task in enumerate(tasks):
        item = {
            "key": "T" + str(i + 1), "title": "Native fixture", "instructions": "No provider execution",
            "requirementKeys": ["R1"], "provider": "codex", "accessMode": "read",
            "verificationProfiles": ["acceptance"], "estimatedTokens": 0,
            "estimatedCostMicros": task.get("cost", 0), "priority": len(tasks) - i,
        }
        if task.get("worktree") is not None:
            item["worktree"] = task["worktree"]
        brief_tasks.append(item)
    brief = {"briefId": name, "version": 1, "goal": "Native SQL fixture", "repo": repo,
             "requirements": [{"key": "R1", "description": "Test", "critical": False}],
             "tasks": brief_tasks}
    encoded = json.dumps(brief, separators=(",", ":"))
    result = cluster.value("SELECT json_build_object('id',purama_ai.chef_create_mission("
                           + quoted(OWNER) + "::uuid," + quoted(encoded) + "::jsonb,"
                           + quoted(sha256(encoded.encode())) + ",4,NULL," + str(budget) + "))",
                           "create real mission " + name)
    task_ids = cluster.value("SELECT json_object_agg(task_key,id) FROM purama_ai.chef_tasks WHERE mission_id="
                             + quoted(result["id"]) + "::uuid", "read created tasks " + name)
    return result["id"], task_ids


def register_worker(cluster, name, repo, worktree=None):
    session = "session-" + name
    cluster.sql("SELECT purama_ai.chef_heartbeat_worker("
                + ",".join((quoted(name), "'codex'", "'native-fixture'", "'idle'", quoted(session),
                            "1", "NULL", quoted(repo), "NULL" if worktree is None else quoted(worktree),
                            "NULL", "'{}'::jsonb")) + ")", "register real worker " + name)
    return session


def claim_select(mission, worker, session):
    return ("SELECT json_build_object('backend_pid',pg_backend_pid(),'ids',coalesce(json_agg(id),'[]'::json)) "
            "FROM purama_ai.chef_claim_next_task(" + quoted(mission) + "::uuid," + quoted(worker) + ","
            + quoted(session) + ",'codex',300)")


def budget_case(cluster):
    mission, _ = create_mission(cluster, "native-budget", "native-budget-repo", [{"cost": 70}, {"cost": 70}])
    statements = []
    for i in range(cluster.args.connections):
        worker = "native-budget-" + str(i)
        session = register_worker(cluster, worker, "native-budget-repo")
        statements.append(claim_select(mission, worker, session))
    parallel = cluster.parallel("70+70 against 100", statements)
    acquired = [task_id for receipt in parallel["receipts"] for task_id in receipt["ids"]]
    snapshot = cluster.value("""SELECT json_build_object(
      'active_count',count(*) FILTER (WHERE state IN ('claimed','running','verifying')),
      'reserved_cost',coalesce(sum(estimated_cost_micros) FILTER
        (WHERE state IN ('claimed','running','verifying')),0)::text,
      'mission_state',(SELECT state FROM purama_ai.chef_missions WHERE id=%s::uuid),
      'claim_events',(SELECT count(*) FROM purama_ai.chef_events WHERE mission_id=%s::uuid AND kind='task_claimed'))
      FROM purama_ai.chef_tasks WHERE mission_id=%s::uuid"""
      % (quoted(mission), quoted(mission), quoted(mission)), "verify atomic budget admission")
    require(len(acquired) == 1 and snapshot == {"active_count": 1, "reserved_cost": "70",
                                              "mission_state": "active", "claim_events": 1},
            "Budget admitted more than one 70 reservation, or paused temporarily blocked work", snapshot)
    return {"parallel": parallel, "snapshot": snapshot}


def credit_expression(owner=OWNER):
    return ("purama_ai.credit_overage_pack(" + quoted(owner) + "::uuid,"
            "'cs_test_native_one_session','pi_native_fixture','evt_native_fixture',"
            "'2026-10-31T23:59:00Z'::timestamptz,1900,'eur',false,2000)")


def credit_case(cluster):
    statement = "SELECT json_build_object('backend_pid',pg_backend_pid(),'receipt'," + credit_expression() + ")"
    parallel = cluster.parallel("one paid session delivered repeatedly", [statement] * cluster.args.connections)
    receipts = [item["receipt"] for item in parallel["receipts"]]
    require(sum(receipt["credited"] is True for receipt in receipts) == 1,
            "Expected exactly one credited receipt", receipts)
    require(len({r["credit_id"] for r in receipts}) == 1
            and all(r["period_start"] == "2026-10-01" for r in receipts),
            "Duplicate deliveries did not retain one immutable receipt", receipts)
    conflict = cluster.sql("BEGIN; SET LOCAL ROLE service_role; SELECT " + credit_expression(OTHER) + "; COMMIT;",
                           "reject cross-owner replay", check=False)
    require(conflict["returncode"] != 0 and "22023" in conflict["stderr"]
            and "overage_session_conflict_requires_reconciliation" in conflict["stderr"],
            "Cross-owner replay must fail", conflict)
    snapshot = cluster.value("""SELECT json_build_object('rows',count(*),'actions',sum(actions),
      'owners',json_agg(DISTINCT user_id)) FROM purama_ai.overage_credits
      WHERE stripe_session_id='cs_test_native_one_session'""", "verify one committed credit")
    require(snapshot == {"rows": 1, "actions": 2000, "owners": [OWNER]},
            "Native deliveries duplicated or changed a credit", snapshot)
    return {"parallel": parallel, "snapshot": snapshot, "cross_owner_sqlstate": "22023"}


def outreach_case(cluster):
    prospect, rejected = str(uuid.uuid4()), str(uuid.uuid4())
    cluster.sql("""INSERT INTO purama_ai.partner_agent_config
      (user_id,is_active,sender_name,sender_email,require_approval_new_prospect,require_approval_outreach)
      VALUES (%s,true,'Native Sender','sender@example.invalid',false,false);
      INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status)
      VALUES (%s,%s,'Native prospect','recipient@example.invalid','ready_to_contact'),
             (%s,%s,'Suppressed prospect','Blocked@example.invalid','rejected');"""
      % (quoted(OWNER), quoted(prospect), quoted(OWNER), quoted(rejected), quoted(OWNER)),
      "outreach fixture, no provider")
    tokens = [str(uuid.uuid4()) for _ in range(cluster.args.connections)]
    reserve = cluster.parallel("outreach reservation", [
        "SELECT json_build_object('backend_pid',pg_backend_pid(),'receipt',purama_ai.partner_outreach_reserve("
        + quoted(OWNER) + "::uuid," + quoted(prospect) + "::uuid,'outreach'," + quoted(token) + "::uuid))"
        for token in tokens])
    winners = [i for i, item in enumerate(reserve["receipts"]) if item["receipt"].get("claimed") is True]
    require(len(winners) == 1, "More than one outreach generation admission", reserve)
    ids = {item["receipt"].get("action_id") for item in reserve["receipts"]}
    require(len(ids) == 1 and None not in ids, "Reservation action identity differs", reserve)
    action = next(iter(ids))
    draft = cluster.value("SELECT purama_ai.partner_outreach_save_draft(" + quoted(OWNER) + "::uuid,"
                          + quoted(action) + "::uuid," + quoted(tokens[winners[0]])
                          + "::uuid,'Native fixture','<p>No email is sent.</p>')", "prepare frozen draft")
    require(draft.get("status") == "ready", "Outreach draft was not admitted", draft)
    sending = cluster.parallel("outreach send admission only", [
        "SELECT json_build_object('backend_pid',pg_backend_pid(),'receipt',purama_ai.partner_outreach_begin_send("
        + quoted(OWNER) + "::uuid," + quoted(action) + "::uuid," + quoted(uuid.uuid4()) + "::uuid))"
        for _ in tokens])
    require(sum(item["receipt"].get("claimed") is True for item in sending["receipts"]) == 1,
            "More than one outreach send admission", sending)
    first_suppression = cluster.value("SELECT purama_ai.partner_outreach_reserve(" + quoted(OWNER) + "::uuid,"
                                      + quoted(rejected) + "::uuid,'outreach'," + quoted(uuid.uuid4()) + "::uuid)",
                                      "reject opposed prospect")
    cluster.sql("UPDATE purama_ai.partner_prospects SET status='ready_to_contact',has_replied=false,"
                "email='bLoCkEd@example.invalid' WHERE id=" + quoted(rejected) + "::uuid",
                "simulate later pipeline edit")
    second_suppression = cluster.value("SELECT purama_ai.partner_outreach_reserve(" + quoted(OWNER) + "::uuid,"
                                       + quoted(rejected) + "::uuid,'outreach'," + quoted(uuid.uuid4()) + "::uuid)",
                                       "retain persistent opposition")
    for result in (first_suppression, second_suppression):
        require(result == {"status": "blocked", "reason": "contact_suppressed"},
                "Opposition was not respected", result)
    snapshot = cluster.value("""SELECT json_build_object('actions',count(*),
      'started',count(dispatch_started_at),'generation_attempts',sum(generation_attempts),
      'suppressed_actions',count(*) FILTER (WHERE prospect_id=%s::uuid))
      FROM purama_ai.partner_outreach_dispatches WHERE user_id=%s::uuid"""
      % (quoted(rejected), quoted(OWNER)), "verify outreach deduplication")
    require(snapshot == {"actions": 1, "started": 1, "generation_attempts": 1, "suppressed_actions": 0},
            "Outreach admission duplicated or bypassed opposition", snapshot)
    return {"reservations": reserve, "send_admissions": sending, "snapshot": snapshot,
            "opposition": [first_suppression, second_suppression], "provider_calls": 0, "emails_sent": 0}


def session_probe(name, condition):
    return ("SELECT json_build_object('ready',coalesce(bool_or(" + condition + "),false),"
            "'sessions',coalesce(json_agg(json_build_object('pid',a.pid,'state',a.state,"
            "'wait_type',a.wait_event_type,'wait_event',a.wait_event,"
            "'blockers',pg_blocking_pids(a.pid))),'[]'::json)) "
            "FROM pg_stat_activity a WHERE a.application_name=" + quoted(name))


def holds_advisory(mode, granted=True):
    return ("EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory' "
            "AND l.mode=" + quoted(mode) + " AND l.granted=" + ("true" if granted else "false") + ")")


def transition(cluster, task, worker, state):
    result = cluster.value("SELECT json_build_object('ok',purama_ai.chef_transition_task("
                           + quoted(task) + "::uuid," + quoted(worker) + ",1," + quoted(state) + "))",
                           "real task transition " + state)
    require(result["ok"] is True, "Task transition refused", result)


def running_fixture(cluster, suffix, repo=None):
    repo = repo or "native-quarantine-" + suffix
    path = "/purama-native-" + suffix
    mission, tasks = create_mission(cluster, "native-" + suffix, repo, [{"worktree": path}])
    worker = "native-worker-" + suffix
    session = register_worker(cluster, worker, repo, path)
    result = cluster.value(claim_select(mission, worker, session), "initial real claim " + suffix)
    require(result["ids"] == [tasks["T1"]], "Initial claim failed", result)
    transition(cluster, tasks["T1"], worker, "running")
    return {"mission": mission, "task": tasks["T1"], "worker": worker, "session": session,
            "repo": repo, "worktree": path}


def quarantine_queue_case(cluster):
    """Reproduce the candidate reader/writer queue cycle using real RPCs.

The claim transaction first takes the same mission lock its RPC takes. This
allows the exact interleaving to be observed, without changing product SQL.
Whether PostgreSQL safely reorders a soft edge or reports 40P01 is measured.
"""
    tag = "purama_three_" + uuid.uuid4().hex[:8]
    repo = "native-three-session-repo"
    mission, tasks = create_mission(cluster, "native-three-session", repo,
                                    [{"worktree": "/purama-three/a"}, {"worktree": "/purama-three/b"}])
    worker_a, worker_b = "native-three-a", "native-three-b"
    session_a = register_worker(cluster, worker_a, repo, "/purama-three/a")
    session_b = register_worker(cluster, worker_b, repo, "/purama-three/b")
    require(cluster.value(claim_select(mission, worker_a, session_a), "claim task before completion")["ids"]
            == [tasks["T1"]], "Completion fixture claim failed")
    transition(cluster, tasks["T1"], worker_a, "running")
    transition(cluster, tasks["T1"], worker_a, "verifying")
    cluster.sql("INSERT INTO purama_ai.chef_evidence(task_id,kind,payload,attempt,fencing_token,worker_id) VALUES("
                + quoted(tasks["T1"]) + "::uuid,'test','{\"ok\":true}'::jsonb,1,1," + quoted(worker_a) + ")",
                "current-generation completion proof")
    incident = running_fixture(cluster, "three-incident")
    jobs, observations, outputs = [], {}, []
    claim_job = None
    try:
        claim_job = cluster.interactive(
            "SET application_name=" + quoted(tag + "_claim") + "; BEGIN; "
            "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='12s'; SET LOCAL ROLE service_role; "
            "SELECT id FROM purama_ai.chef_missions WHERE id=" + quoted(mission) + "::uuid FOR UPDATE;",
            "three sessions: claim holds mission")
        jobs.append(claim_job)
        observations["claim_holds_mission"] = cluster.wait_until(
            session_probe(tag + "_claim", "a.state='idle in transaction'"), "observe held mission")
        claim_pid = observations["claim_holds_mission"]["sessions"][0]["pid"]
        complete_job = cluster.sql_job(cluster.transaction(tag + "_complete",
            "SELECT json_build_object('ok',purama_ai.chef_transition_task(" + quoted(tasks["T1"])
            + "::uuid," + quoted(worker_a) + ",1,'verified_done'))", hold=0),
            "three sessions: real completion waits for mission")
        jobs.append(complete_job)
        observations["completion_shared_waiting_on_claim"] = cluster.wait_until(
            session_probe(tag + "_complete", holds_advisory("ShareLock")
                          + " AND " + str(claim_pid) + "=ANY(pg_blocking_pids(a.pid))"),
            "observe completion shared lock and mission dependency")
        quarantine_job = cluster.sql_job(cluster.transaction(tag + "_quarantine",
            "SELECT json_build_object('ok',purama_ai.chef_quarantine_process(" + quoted(incident["task"])
            + "::uuid," + quoted(incident["worker"]) + ",1,1,'native queue race'))", hold=0),
            "three sessions: real quarantine queues exclusive")
        jobs.append(quarantine_job)
        observations["quarantine_waiting_exclusive"] = cluster.wait_until(
            session_probe(tag + "_quarantine", holds_advisory("ExclusiveLock", False)),
            "observe queued exclusive quarantine")
        cluster.finish_input(claim_job, claim_select(mission, worker_b, session_b) + "; COMMIT;")
        for job in jobs:
            outputs.append(cluster.collect(job, check=False, timeout=25))
    finally:
        if claim_job is not None and claim_job["process"].stdin is not None:
            try:
                cluster.finish_input(claim_job, "ROLLBACK;")
            except (BrokenPipeError, OSError):
                pass
        for job in jobs:
            if job in cluster.live:
                cluster.collect(job, check=False, timeout=20)
    outcomes = [{"label": item["label"], "returncode": item["returncode"],
                 "stdout": item["stdout"], "stderr": item["stderr"],
                 "elapsed_seconds": item["elapsed_seconds"]} for item in outputs]
    evidence = {"observations": observations, "outcomes": outcomes}
    require(not any("40P01" in item["stderr"] for item in outputs),
            "Native PostgreSQL detected the three-session deadlock (SQLSTATE 40P01)", evidence)
    require(all(item["returncode"] == 0 or "PCQ01" in item["stderr"] for item in outputs),
            "Unexpected error in the three-session sequence", evidence)
    require(len(outputs) == 3 and all(not item.get("timeout") for item in outputs),
            "Three-session sequence did not finish", evidence)
    evidence["deadlock_sqlstate_observed"] = False
    return evidence


def quarantine_block_case(cluster, recovery=False):
    suffix = "expiry" if recovery else "direct"
    incident = running_fixture(cluster, suffix + "-incident")
    target_path = "/purama-native-" + suffix + "-candidate"
    other_mission, tasks = create_mission(cluster, "native-" + suffix + "-candidate", incident["repo"],
                                          [{"worktree": target_path}])
    other_worker = "native-" + suffix + "-candidate"
    other_session = register_worker(cluster, other_worker, incident["repo"], target_path)
    if recovery:
        cluster.sql("UPDATE purama_ai.chef_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id="
                    + quoted(incident["task"]) + "::uuid", "expire only the test task")
        mark = "purama_ai.chef_requeue_expired_tasks(" + quoted(incident["mission"]) + "::uuid)"
    else:
        mark = "purama_ai.chef_quarantine_process(" + quoted(incident["task"]) + "::uuid,"
        mark += quoted(incident["worker"]) + ",1,1,'native unconfirmed process')"
    tag = "purama_" + suffix + "_" + uuid.uuid4().hex[:8]
    holder = cluster.interactive("SET application_name=" + quoted(tag + "_holder")
        + "; BEGIN; SET LOCAL statement_timeout='15s'; SET LOCAL ROLE service_role; "
        "SELECT json_build_object('marked'," + mark + ");", "hold uncommitted " + suffix + " quarantine")
    blocked = None
    observations = {}
    try:
        observations["exclusive_uncommitted"] = cluster.wait_until(
            session_probe(tag + "_holder", "a.state='idle in transaction' AND " + holds_advisory("ExclusiveLock")),
            "observe uncommitted quarantine lock")
        blocked = cluster.sql_job(cluster.transaction(tag + "_claim",
            claim_select(other_mission, other_worker, other_session), hold=0), "claim waits for " + suffix + " quarantine")
        observations["claim_waiting_shared"] = cluster.wait_until(
            session_probe(tag + "_claim", holds_advisory("ShareLock", False)),
            "observe admission waiting on quarantine")
        cluster.finish_input(holder, "COMMIT;")
        holder_result = cluster.collect(holder)
        blocked_result = cluster.collect(blocked, check=False)
    finally:
        if holder["process"].stdin is not None:
            try:
                cluster.finish_input(holder, "ROLLBACK;")
            except (BrokenPipeError, OSError):
                pass
        for job in (holder, blocked):
            if job is not None and job in cluster.live:
                cluster.collect(job, check=False, timeout=20)
    require(blocked_result["returncode"] != 0 and "PCQ01" in blocked_result["stderr"],
            "Admission did not reject the concurrently committed quarantine", blocked_result)
    require(json_rows(holder_result["stdout"])[0]["marked"] == (1 if recovery else True),
            "Quarantine was not recorded", holder_result)
    target = cluster.value("SELECT json_build_object('state',state,'fencing_token',fencing_token,'attempt',attempt) "
                           "FROM purama_ai.chef_tasks WHERE id=" + quoted(tasks["T1"]) + "::uuid",
                           "verify blocked claim is unchanged")
    require(target == {"state": "ready", "fencing_token": 0, "attempt": 0},
            "Rejected admission mutated the candidate", target)
    cluster.sql("DELETE FROM purama_ai.chef_missions WHERE id=" + quoted(incident["mission"]) + "::uuid",
                "delete fixture mission without deleting quarantine")
    retained = cluster.value("SELECT json_build_object('n',count(*)) FROM purama_ai.chef_process_quarantines WHERE task_id="
                             + quoted(incident["task"]) + "::uuid", "verify quarantine outlives mission")
    require(retained["n"] == 1, "Mission deletion erased quarantine", retained)
    return {"observations": observations, "candidate": target, "rejection_sqlstate": "PCQ01", "quarantine_retained": True}


def quarantine_try_lock_case(cluster):
    incident = running_fixture(cluster, "try-lock-incident")
    cluster.sql("UPDATE purama_ai.chef_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id="
                + quoted(incident["task"]) + "::uuid", "expire try-lock fixture")
    before = cluster.value("SELECT json_build_object('state',state,'lease',lease_expires_at::text,'fence',fencing_token) "
                           "FROM purama_ai.chef_tasks WHERE id=" + quoted(incident["task"]) + "::uuid", "snapshot expired claim")
    tag = "purama_shared_" + uuid.uuid4().hex[:8]
    holder = cluster.interactive("SET application_name=" + quoted(tag) + "; BEGIN; "
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('purama_ai.chef.process_quarantine',0));",
        "hold shared admission lock")
    try:
        observed = cluster.wait_until(session_probe(tag, "a.state='idle in transaction' AND " + holds_advisory("ShareLock")),
                                      "observe shared admission lock")
        result = cluster.value("BEGIN; SET LOCAL statement_timeout='2s'; SET LOCAL ROLE service_role; "
            "SELECT json_build_object('n',purama_ai.chef_requeue_expired_tasks(" + quoted(incident["mission"])
            + "::uuid)); COMMIT;", "expiry recovery must not wait on a shared guard")
        require(result["n"] == 0, "Recovery should return zero while the advisory lock is unavailable", result)
        after = cluster.value("SELECT json_build_object('state',state,'lease',lease_expires_at::text,'fence',fencing_token) "
                              "FROM purama_ai.chef_tasks WHERE id=" + quoted(incident["task"]) + "::uuid", "retain expired exclusion")
        require(after == before, "Try-lock contention released or modified the exclusion", {"before": before, "after": after})
        cluster.finish_input(holder, "COMMIT;")
        cluster.collect(holder)
    finally:
        if holder["process"].stdin is not None:
            try:
                cluster.finish_input(holder, "ROLLBACK;")
            except (BrokenPipeError, OSError):
                pass
        if holder in cluster.live:
            cluster.collect(holder, check=False)
    recovered = cluster.value("SELECT json_build_object('n',purama_ai.chef_requeue_expired_tasks("
                              + quoted(incident["mission"]) + "::uuid))", "retry expiry after shared lock release")
    require(recovered["n"] == 1, "Recovery failed after lock release", recovered)
    return {"observed_shared_lock": observed, "during_contention": result, "unchanged": after, "after_release": recovered}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("checkout", help="Root of the checkout containing the real migrations")
    parser.add_argument("--pg-bin", help="Directory containing initdb, pg_ctl, psql and postgres")
    parser.add_argument("--connections", type=int, choices=range(8, 13), default=12)
    parser.add_argument("--hold-seconds", type=float, default=0.2,
                        help="Hold each tested transaction open after its RPC (0.1 to 1 second)")
    parser.add_argument("--quarantine", action="store_true",
                        help="Also exercise migration 023, including the candidate three-session deadlock")
    parser.add_argument("--output", help="JSON evidence path (default: checkout/qa/.../integration/native-postgres-results.json)")
    args = parser.parse_args()
    root = Path(args.checkout).expanduser().resolve()
    require(root.is_dir(), "Checkout is not a directory", str(root))
    require(0.1 <= args.hold_seconds <= 1, "hold-seconds must be between 0.1 and 1")
    output = Path(args.output).expanduser().resolve() if args.output else (
        root / "qa/agents-hardening-20261110/integration/native-postgres-results.json")
    report = {
        "status": "RUNNING", "started_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "checkout": str(root), "script_sha256": sha256(Path(__file__).read_bytes()),
        "python_version": sys.version, "parallel_connections_per_batch": args.connections,
        "quarantine_requested": args.quarantine, "commands": [], "migrations": [], "checks": [],
        "external_network_calls": 0, "provider_calls": 0, "payments_created": 0, "emails_sent": 0,
        "scope": "Disposable native PostgreSQL only; SQL transport/concurrency, not provider integration",
    }
    cluster = None
    previous_umask = os.umask(0o077)
    previous_signals = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}

    def interrupt(signum, _frame):
        raise KeyboardInterrupt("Interrupted by signal " + str(signum))

    for sig in previous_signals:
        signal.signal(sig, interrupt)
    try:
        cluster = Cluster(args, report)
        cluster.start()
        cluster.bootstrap()
        cases = [("budget_70_plus_70_under_100", budget_case),
                 ("one_credit_for_concurrent_deliveries", credit_case),
                 ("outreach_admission_and_persistent_opposition", outreach_case)]
        if args.quarantine:
            cases += [("quarantine_three_session_reader_writer_queue", quarantine_queue_case),
                      ("quarantine_blocks_concurrent_claim", quarantine_block_case),
                      ("expiry_quarantine_blocks_concurrent_claim", lambda c: quarantine_block_case(c, recovery=True)),
                      ("expiry_recovery_uses_nonblocking_advisory_lock", quarantine_try_lock_case)]
        for name, check in cases:
            started = time.monotonic()
            item = {"name": name, "status": "RUNNING"}
            report["checks"].append(item)
            try:
                item["evidence"] = check(cluster)
                item["status"] = "PASS"
            except Exception as error:
                item.update(status="FAIL", error=str(error), traceback=traceback.format_exc())
            item["elapsed_seconds"] = round(time.monotonic() - started, 4)
            print(json.dumps({"check": name, "status": item["status"],
                              "elapsed_seconds": item["elapsed_seconds"]}), flush=True)
        report["status"] = "PASS" if all(item["status"] == "PASS" for item in report["checks"]) else "FAIL"
    except BaseException as error:
        report.update(status="INTERRUPTED" if isinstance(error, KeyboardInterrupt) else "FAIL",
                      error=str(error), traceback=traceback.format_exc())
    finally:
        # Do not interrupt cleanup halfway through a second Ctrl-C/SIGTERM.
        for sig in previous_signals:
            signal.signal(sig, signal.SIG_IGN)
        try:
            if cluster is not None:
                cluster.cleanup()
        except BaseException as error:
            report.update(status="FAIL", cleanup_error=str(error), cleanup_traceback=traceback.format_exc())
        finally:
            report["finished_at_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            try:
                output.parent.mkdir(parents=True, exist_ok=True)
                temporary_output = output.with_name(output.name + ".tmp-" + uuid.uuid4().hex)
                temporary_output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf8")
                temporary_output.replace(output)
            finally:
                os.umask(previous_umask)
                for sig, handler in previous_signals.items():
                    signal.signal(sig, handler)
    print(json.dumps({"status": report["status"], "evidence": str(output),
                      "cleanup": report.get("cleanup")}), flush=True)
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
