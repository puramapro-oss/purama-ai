#!/usr/bin/env python3
"""Qualify OTS stamp persistence in a disposable native PostgreSQL cluster.

Reuses the repository's isolated PostgreSQL lifecycle/client implementation.
Only fixture identities and the real contract migrations are installed. No
inherited PG* environment, TCP listener, existing database or provider is used.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import traceback


PARENT = "cb5accbeac30bf43872c0a7a19233a619faed4ca"
HELPER = "qa/agents-hardening-20261110/integration/native-postgres.py"
BASE = "supabase/migrations/20260423110000_docuseal_contracts.sql"
MIGRATION = "supabase/migrations/20261110180000_contract_ots_audit_atomicity.sql"
STAMP = "supabase/functions/contracts-ots-stamp/index.ts"
OWNER = "11111111-1111-4111-8111-111111111111"
ADMIN = "22222222-2222-4222-8222-222222222222"
CONTRACT = "33333333-3333-4333-8333-333333333333"
FOREIGN = "44444444-4444-4444-8444-444444444444"
OLD_HASH, NEW_HASH = "ab" * 32, "cd" * 32
OLD_PROOF = base64.b64encode(b"fixture-old-proof").decode()
NEW_PROOF = base64.b64encode(b"fixture-new-proof").decode()


def quoted(value):
    return "NULL" if value is None else "'" + str(value).replace("'", "''") + "'"


def rpc(**overrides):
    values = dict(contract_id=CONTRACT, user_id=OWNER, submission_id=17,
                  previous_hash=OLD_HASH, previous_proof=OLD_PROOF,
                  hash=NEW_HASH, proof=NEW_PROOF)
    values.update(overrides)
    return "purama_ai.persist_contract_ots_stamp(" + ",".join(quoted(x) for x in values.values()) + ")"


def claims(role="authenticated", actor=ADMIN):
    return ("SET LOCAL ROLE " + role + "; "
            "SELECT set_config('request.jwt.claim.role'," + quoted(role) + ",true); "
            "SELECT set_config('request.jwt.claim.sub'," + quoted(actor or "") + ",true); ")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout")
    parser.add_argument("--pg-bin", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--private-parent", default="/private/tmp")
    args = parser.parse_args()
    args.hold_seconds = 0.4
    root = Path(args.checkout).resolve()
    output = Path(args.output).resolve()
    spec = importlib.util.spec_from_file_location("purama_native_pg", root / HELPER)
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    require = native.require

    class ContractCluster(native.Cluster):
        # Only allocation is specialized. Client execution, isolation validation,
        # process ownership, concurrency observation and cleanup stay shared.
        def __init__(self):
            self.args, self.root, self.report = args, root, report
            self.bin = native.binaries(args.pg_bin)
            self.private = Path(tempfile.mkdtemp(prefix="purama-iao-native-221cb4a2-", dir=args.private_parent))
            os.chmod(self.private, 0o700)
            self.data, self.socket = self.private / "data", self.private / "socket"
            self.socket.mkdir(mode=0o700)
            self.passfile = self.private / "empty.pgpass"
            self.passfile.touch(mode=0o600)
            self.server_log = self.private / "postgres.log"
            self.live, self.start_attempted = [], False
            self.env = {"PATH": str(Path(self.bin["postgres"]).parent) + os.pathsep + os.defpath,
                        "LANG": "C", "LC_ALL": "C", "TZ": "UTC", "PGPASSFILE": str(self.passfile)}
            require(len(str(self.socket / (".s.PGSQL." + native.PORT)).encode()) < 100, "Socket path too long")
            report.update(private_cluster=str(self.private), inherited_pg_environment=False)

    report = {"parent": PARENT, "started_at_epoch": time.time(), "commands": [], "migrations": [], "checks": [],
              "scope": "Native SQL persistence and audit; no production schema/runtime or cryptographic qualification",
              "source_sha256": {path: hashlib.sha256((root / path).read_bytes()).hexdigest()
                                for path in (HELPER, BASE, MIGRATION, STAMP, "tests/contracts-ots/native-postgres.py")}}
    cluster = ContractCluster()

    def record(name, observed):
        report["checks"].append({"name": name, "status": "PASS", "observed": observed})

    def snapshot(label):
        return cluster.value("""SELECT jsonb_build_object(
          'contract',(SELECT to_jsonb(c) FROM purama_ai.contracts c LIMIT 1),
          'events',coalesce((SELECT jsonb_agg(e ORDER BY created_at,id) FROM purama_ai.contract_events e),'[]'::jsonb))""", label)

    def reset():
        cluster.sql("TRUNCATE purama_ai.contracts CASCADE; "
                    "INSERT INTO purama_ai.fixture_roles VALUES (" + quoted(ADMIN) + ",'admin') ON CONFLICT DO NOTHING; "
                    "INSERT INTO purama_ai.contracts(id,user_id,app_slug,template_slug,status,docuseal_submission_id,"
                    "ots_stamp_hash,ots_proof,ots_verified_at,ots_block_height,ots_btc_timestamp) VALUES (" +
                    ",".join(map(quoted, [CONTRACT, OWNER, "fixture", "fixture", "signed", 17, OLD_HASH, OLD_PROOF,
                                          "2026-10-01T00:00:00Z", 900000, "2026-09-30T23:00:00Z"])) + ");", "reset fixture")

    def call(label, role="authenticated", actor=ADMIN, **overrides):
        return cluster.value("BEGIN; " + claims(role, actor) + "SELECT json_build_object('written'," +
                             rpc(**overrides) + "); COMMIT;", label)

    def audit_failure(enabled):
        if enabled:
            cluster.sql("""CREATE OR REPLACE FUNCTION purama_ai.fixture_audit_failure() RETURNS trigger
              LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-audit-failure' USING ERRCODE='P7001'; END $$;
              CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON purama_ai.contract_events
              FOR EACH ROW EXECUTE FUNCTION purama_ai.fixture_audit_failure();""", "inject audit INSERT failure")
        else:
            cluster.sql("DROP TRIGGER fixture_audit_failure ON purama_ai.contract_events", "remove injected audit failure")

    def interrupted(_signum, _frame):
        raise RuntimeError("Native test interrupted; cleaning only this private cluster")

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, interrupted)
    exit_code = 1
    try:
        cluster.start()
        cluster.sql("""CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role NOLOGIN BYPASSRLS;
          CREATE SCHEMA auth; CREATE SCHEMA purama_ai; CREATE TABLE auth.users(id uuid PRIMARY KEY);
          CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
            SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
          CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
            SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
          CREATE TYPE purama_ai.app_role AS ENUM ('admin','user');
          CREATE TABLE purama_ai.fixture_roles(user_id uuid,role purama_ai.app_role, PRIMARY KEY(user_id,role));
          CREATE FUNCTION purama_ai.has_role(_user_id uuid,_role purama_ai.app_role) RETURNS boolean
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
            SELECT EXISTS(SELECT 1 FROM purama_ai.fixture_roles WHERE user_id=_user_id AND role=_role) $$;
          GRANT USAGE ON SCHEMA auth,purama_ai TO anon,authenticated,service_role;
          INSERT INTO auth.users(id) VALUES (%s),(%s),(%s);""" %
                    (quoted(OWNER), quoted(ADMIN), quoted(FOREIGN)), "fixture Auth and role stubs only")
        cluster.migration(BASE)
        reset()

        # Reproduce the old split-write failure using real independent commits.
        audit_failure(True)
        cluster.sql("BEGIN; " + claims("service_role", None) + "UPDATE purama_ai.contracts SET ots_proof=" +
                    quoted(NEW_PROOF) + " WHERE id=" + quoted(CONTRACT) + "; COMMIT;", "baseline independently committed proof")
        failure = cluster.sql("BEGIN; " + claims("service_role", None) +
                              "INSERT INTO purama_ai.contract_events(contract_id,event_type) VALUES (" +
                              quoted(CONTRACT) + ",'ots_stamped'); COMMIT;", "baseline failed separate audit", check=False)
        observed = snapshot("baseline split-write result")
        require(failure["returncode"] != 0 and "P7001" in failure["stderr"] and
                observed["contract"]["ots_proof"] == NEW_PROOF and not observed["events"],
                "Expected original proof-without-audit failure", observed)
        record("baseline split-write defect reproduced", {"proof_committed": True, "audit_count": 0, "sqlstate": "P7001"})
        audit_failure(False)
        cluster.migration(MIGRATION)

        for role, actor in (("authenticated", ADMIN), ("service_role", None)):
            reset()
            result = call("atomic " + role + " stamp", role, actor)
            observed = snapshot("atomic actor receipt")
            event = observed["events"][0] if observed["events"] else {}
            require(result["written"] == CONTRACT and len(observed["events"]) == 1 and
                    event.get("actor_id") == actor and event.get("actor_type") == ("user" if actor else "service") and
                    event.get("payload") == {"hash": NEW_HASH, "proof_size": len(base64.b64decode(NEW_PROOF))},
                    "Atomic proof/audit or actor mismatch", observed)
            require(all(observed["contract"][field] is None for field in
                        ("ots_verified_at", "ots_block_height", "ots_btc_timestamp")), "Stale confirmation remains", observed)
            record("atomic stamp and authentic actor: " + role, {"written": result, "event": event})

        reset()
        before = snapshot("before failed audit")
        audit_failure(True)
        failure = cluster.sql("BEGIN; " + claims() + "SELECT " + rpc() + "; COMMIT;", "failed audit rolls back proof", check=False)
        observed = snapshot("after failed audit")
        require(failure["returncode"] != 0 and "P7001" in failure["stderr"] and observed == before,
                "Audit failure did not fully roll back", observed)
        record("audit failure rolls back proof and all confirmation fields", {"sqlstate": "P7001", "snapshot_unchanged": True})
        # Catch the error inside the same SQL session to test SET restoration.
        restored = cluster.value("BEGIN; " + claims() + "SET LOCAL purama_ai.atomic_ots_stamp='previous'; "
            "DO $test$ BEGIN BEGIN PERFORM " + rpc() + "; RAISE EXCEPTION 'Expected failure'; "
            "EXCEPTION WHEN SQLSTATE 'P7001' THEN NULL; END; END $test$; "
            "SELECT json_build_object('marker',current_setting('purama_ai.atomic_ots_stamp',true)); COMMIT;",
            "marker restored after caught audit exception")
        require(restored["marker"] == "previous", "Function marker leaked after exception", restored)
        audit_failure(False)
        record("function marker restored after caught failure", restored)

        reset()
        restored = cluster.value("BEGIN; " + claims() + "SET LOCAL purama_ai.atomic_ots_stamp='previous'; "
            "SELECT " + rpc() + "; SELECT json_build_object('marker',current_setting('purama_ai.atomic_ots_stamp',true)); COMMIT;",
            "marker restored after successful RPC")
        require(restored["marker"] == "previous", "Function marker leaked after success", restored)
        record("function marker restored after success", restored)

        reset()
        restored = cluster.value("BEGIN; " + claims() + "SET LOCAL purama_ai.atomic_ots_stamp='previous'; "
            "SELECT " + rpc(previous_hash="00" * 32) +
            "; SELECT json_build_object('marker',current_setting('purama_ai.atomic_ots_stamp',true)); COMMIT;",
            "marker restored after unmatched snapshot")
        require(restored["marker"] == "previous" and not snapshot("unmatched snapshot has no audit")["events"],
                "Function marker leaked after unmatched snapshot", restored)
        record("function marker restored after unmatched snapshot", restored)

        reset()
        legacy = ("UPDATE purama_ai.contracts SET ots_stamp_hash=" + quoted(NEW_HASH) + ",ots_proof=" + quoted(NEW_PROOF) +
                  ",ots_verified_at=NULL,ots_block_height=NULL,ots_btc_timestamp=NULL WHERE id=" + quoted(CONTRACT) + ";")
        cluster.sql("BEGIN; " + claims() + legacy + "COMMIT;", "legacy human handler UPDATE after migration")
        require(not snapshot("legacy UPDATE has no automatic audit")["events"], "Legacy handler got duplicate automatic audit")
        cluster.sql("BEGIN; " + claims("service_role", None) +
            "INSERT INTO purama_ai.contract_events(contract_id,event_type,payload,actor_id,actor_type) VALUES (" +
            quoted(CONTRACT) + ",'ots_stamped',jsonb_build_object('hash'," + quoted(NEW_HASH) + ",'proof_size',17)," +
            quoted(ADMIN) + ",'user'); COMMIT;", "legacy human handler's separate service audit")
        require(len(snapshot("legacy audit count")["events"]) == 1, "Legacy handler audit is not unique")
        # A new RPC then a legacy UPDATE in the same session must not leak its marker.
        reset()
        cluster.sql("BEGIN; " + claims() + "SELECT " + rpc() + "; " + legacy + "COMMIT;", "new then legacy UPDATE in same transaction")
        require(len(snapshot("new then legacy audit count")["events"]) == 1, "Marker leaked into subsequent legacy statement")
        record("old and new handlers coexist without automatic double audit", {"legacy_events": 1, "new_then_legacy_events": 1})

        reset()
        cluster.sql("BEGIN; " + claims("service_role", None) +
                    "UPDATE purama_ai.contracts SET ots_proof=" + quoted(NEW_PROOF) +
                    ",ots_verified_at=now(),ots_block_height=900001,ots_btc_timestamp=now() WHERE id=" +
                    quoted(CONTRACT) + "; COMMIT;", "existing verification writer remains outside marker")
        require(not snapshot("verification does not generate stamp audit")["events"], "Verification misclassified as stamp")
        record("verify writer does not generate an extra stamp event", {"stamp_events": 0, "verify_atomicity": "OUT_OF_SCOPE"})

        for actor in (OWNER, FOREIGN):
            reset()
            before = snapshot("before rejected actor")
            result = call("RLS non-admin rejection", "authenticated", actor)
            require(result["written"] is None and snapshot("after rejected actor") == before,
                    "Invoker RPC bypassed contract RLS")
            record("RLS preserves non-admin rejection: " + actor, result)
        reset()
        cluster.sql("DELETE FROM purama_ai.fixture_roles WHERE user_id=" + quoted(ADMIN), "revoke administrator before write")
        require(call("revoked administrator") == {"written": None}, "Revoked admin persisted proof")
        record("RLS rechecks administrator authority at mutation", {"written": None})

        reset()
        privilege = cluster.value("""SELECT json_build_object(
          'invoker',NOT p.prosecdef,'config',p.proconfig,
          'anon_rpc',has_function_privilege('anon',p.oid,'EXECUTE'),
          'human_rpc',has_function_privilege('authenticated',p.oid,'EXECUTE'),
          'service_rpc',has_function_privilege('service_role',p.oid,'EXECUTE'),
          'human_trigger',has_function_privilege('authenticated',t.oid,'EXECUTE'),
          'service_trigger',has_function_privilege('service_role',t.oid,'EXECUTE'),
          'trigger_definer',t.prosecdef,'trigger_config',t.proconfig)
          FROM pg_proc p,pg_proc t WHERE p.oid='purama_ai.persist_contract_ots_stamp(uuid,uuid,bigint,text,text,text,text)'::regprocedure
          AND t.oid='purama_ai.audit_atomic_contract_ots_stamp()'::regprocedure""", "function privilege catalog")
        require(privilege["invoker"] and not privilege["anon_rpc"] and privilege["human_rpc"] and privilege["service_rpc"] and
                not privilege["human_trigger"] and not privilege["service_trigger"] and privilege["trigger_definer"] and
                'search_path=""' in privilege["config"] and 'search_path=""' in privilege["trigger_config"],
                "Unexpected function privilege/search_path", privilege)
        record("minimum function privileges and fixed search paths", privilege)
        for label, sql, role in (("anonymous RPC", "SELECT " + rpc(), "anon"),
                                ("direct human audit insert", "INSERT INTO purama_ai.contract_events(contract_id,event_type) VALUES (" +
                                 quoted(CONTRACT) + ",'ots_stamped')", "authenticated")):
            result = cluster.sql("BEGIN; " + claims(role, ADMIN) + sql + "; COMMIT;", label, check=False)
            require(result["returncode"] != 0 and "42501" in result["stderr"], label + " was not refused", result)
            record(label + " remains forbidden", {"sqlstate": "42501"})

        for field, change in (("id", FOREIGN), ("user_id", FOREIGN), ("status", "cancelled"),
                              ("docuseal_submission_id", "999"), ("ots_stamp_hash", "ef" * 32), ("ots_proof", NEW_PROOF)):
            reset()
            cluster.sql("UPDATE purama_ai.contracts SET " + field + "=" + quoted(change), "change snapshot field " + field)
            before = snapshot("before stale " + field)
            require(call("reject stale " + field, "service_role", None)["written"] is None and
                    snapshot("after stale " + field) == before, "Lost snapshot condition: " + field)
            record("stale snapshot refused: " + field, {"written": None, "audit_count": 0})

        for label, overrides in (("invalid hash", {"hash": "zz" * 32}), ("empty proof", {"proof": ""}),
                                 ("invalid base64", {"proof": "%%%="}), ("oversized proof", {"proof": "A" * 85336})):
            reset()
            before = snapshot("before invalid payload")
            result = cluster.sql("BEGIN; " + claims() + "SELECT " + rpc(**overrides) + "; COMMIT;", label, check=False)
            require(result["returncode"] != 0 and "22023" in result["stderr"] and snapshot("invalid payload unchanged") == before,
                    "Invalid input persisted: " + label)
            record(label + " refused before effects", {"sqlstate": "22023"})

        reset()
        cluster.sql("UPDATE purama_ai.contracts SET ots_stamp_hash=NULL,ots_proof=NULL", "initial contract without prior proof")
        require(call("first proof accepts null snapshot", previous_hash=None, previous_proof=None)["written"] == CONTRACT,
                "Null prior proof snapshot rejected")
        require(len(snapshot("first proof event count")["events"]) == 1, "Initial proof missing its audit")
        record("first proof preserves NULL snapshot semantics", {"events": 1})

        reset()
        maximum = base64.b64encode(b"x" * 64000).decode()
        require(call("exact maximum storage boundary", proof=maximum)["written"] == CONTRACT,
                "Valid maximum proof size rejected")
        size = cluster.value("SELECT json_build_object('bytes',octet_length(decode(ots_proof,'base64'))) "
                             "FROM purama_ai.contracts", "maximum proof stored size")
        require(size["bytes"] == 64000, "Maximum proof altered", size)
        record("64,000-byte valid storage boundary retained", size)

        reset()
        call("first same-proof request")
        call("second same-proof request", previous_hash=NEW_HASH, previous_proof=NEW_PROOF)
        require(len(snapshot("same-proof event count")["events"]) == 2, "Same-proof successful request lost its own audit")
        record("same proof preserves one audit for each successful request", {"requests": 2, "events": 2, "exactly_once_delivery": False})

        reset()
        statements = ["SELECT set_config('request.jwt.claim.role','service_role',true); "
                      "SELECT json_build_object('backend_pid',pg_backend_pid(),'written'," +
                      rpc(hash=("%02x" % (i + 1)) * 32, proof=base64.b64encode(("race-proof-%d" % i).encode()).decode()) + ")"
                      for i in range(4)]
        concurrent = cluster.parallel("four actual concurrent stamp writers", statements)
        after = snapshot("concurrent committed result")
        require(sum(x["written"] == CONTRACT for x in concurrent["receipts"]) == 1 and len(after["events"]) == 1 and
                after["events"][0]["payload"]["hash"] == after["contract"]["ots_stamp_hash"],
                "Concurrent stale writes produced duplicate/mismatched persistence", concurrent)
        record("native concurrent CAS admits one proof and one audit", concurrent)
        report["status"] = "PASS"
        exit_code = 0
    except BaseException as error:
        report["status"] = "FAIL"
        report["error"] = str(error)
        report["traceback"] = traceback.format_exc()
    finally:
        try:
            cluster.cleanup()
        except BaseException as error:
            report["status"] = "FAIL"
            report["cleanup_error"] = str(error)
            exit_code = 1
        report["finished_at_epoch"] = time.time()
        report["exit_code"] = exit_code
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"status": report["status"], "checks": len(report["checks"]),
                          "output": str(output), "cleanup": report.get("cleanup"), "error": report.get("error")}))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
