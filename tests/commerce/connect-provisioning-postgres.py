#!/usr/bin/env python3
"""Native PostgreSQL checks in an owned socket-only disposable cluster.

Uses installed PostgreSQL binaries only. No network, package install, existing
server, Stripe SDK or provider call. Exit 1 on any missing prerequisite/failed
check or incomplete cleanup. SQL execution is distinct from PostgREST/RLS
configuration deployed by a provider. Private role privileges are tested here.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shlex
import shutil
import signal
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', required=True)
parser.add_argument('--report', required=True)
args = parser.parse_args()
output = Path(args.report).resolve()
root = Path(__file__).resolve().parents[2]
migration = root / 'supabase/migrations/20261111183000_connect_account_provisioning.sql'
correction = root / 'supabase/migrations/20261111203000_connect_provisioning_admission_gates.sql'
bins = Path(args.pg_bin).resolve()
owned = data = socket = None
env = {}
psql = []
sessions = []
start_attempted = False
checks = []
report = {'status': 'FAILED', 'checks': checks, 'real_provider_calls': 0,
          'scope': 'Exact candidate migration and native PostgreSQL roles/constraints/locking in synthetic isolated cluster; no real Supabase/PostgREST or Stripe integration.'}
user = '00000000-0000-4000-8000-000000000001'
other_user = '00000000-0000-4000-8000-000000000002'
context = 'a' * 64
# Synthetic protocol input; the served handler has no qualified creation policy.
payload = {'type': 'express', 'country': 'FR', 'email': 'fixture@example.invalid',
           'capabilities': {'transfers': {'requested': True}}}
default_parameters = object()

def check(condition, message='Verification failed'):
    if not condition:
        raise RuntimeError(str(message))

def literal(value):
    return "'" + str(value).replace("'", "''") + "'"

def claim_sql(actor=user, parameters=default_parameters, version='2025-09-30.clover', credential=context):
    params = 'NULL' if parameters is None else literal(json.dumps(
        payload if parameters is default_parameters else parameters, separators=(',', ':'))) + '::jsonb'
    return ("SET ROLE service_role; SELECT public.claim_connect_account_provision("
            + ','.join(['NULL' if actor is None else literal(actor)+'::uuid', params,
                        'NULL' if version is None else literal(version),
                        'NULL' if credential is None else literal(credential)])
            + "); RESET ROLE;")

def final_sql(operation, account='acct_fixture_one', verified=True, actor=user):
    return ("SET ROLE service_role; SELECT public.finalize_connect_account_provision("
            + ','.join([literal(actor)+'::uuid', literal(operation)+'::uuid', literal(account), 'true' if verified else 'false'])
            + "); RESET ROLE;")

def object_query(sql):
    return json.loads(query(sql).stdout.strip())

def reset():
    query("TRUNCATE public.connect_account_provisions, public.connect_accounts, auth.users CASCADE;"
          + f" INSERT INTO auth.users(id) VALUES('{user}'),('{other_user}');")

def completed(name, **details):
    checks.append({'case': name, 'status': 'PASS', **details})

def seed_deadline(receipt, remaining):
    query('DELETE FROM public.connect_account_provisions;')
    query("INSERT INTO public.connect_account_provisions(user_id,operation_id,parameters,api_version,provider_context,created_at,retry_until) "
          f"VALUES('{user}','{receipt['operation_id']}',{literal(json.dumps(receipt['parameters']))}::jsonb,'2025-09-30.clover','{context}',"
          f"now()+interval {literal(remaining)}-interval '23 hours',now()+interval {literal(remaining)});")


def command(argv, **kwargs):
    timeout = kwargs.pop('timeout', 25)
    input_text = kwargs.pop('input', None)
    process = subprocess.Popen(argv, env=env, text=True, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, **kwargs)
    try:
        stdout, stderr = process.communicate(input_text, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate(timeout=2)
        raise
    return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)

def query(sql, expect_error=False):
    result = command(psql, input=sql)
    if not expect_error:
        check(result.returncode == 0, result.stderr)
    return result

class Session:
    def __init__(self, label):
        self.label = label
        self.pending = b''
        self.stderr_path = owned / (label + '.stderr')
        self.stderr_file = self.stderr_path.open('wb')
        self.proc = subprocess.Popen(psql, env={**env, 'PGAPPNAME': label},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr_file, bufsize=0)
        sessions.append(self)
    def execute(self, sql):
        marker = f'__CONNECT_END_{self.label}__'
        self.proc.stdin.write((sql + '\n\\echo ' + marker + '\n').encode())
        self.proc.stdin.flush()
        result = []
        deadline = time.monotonic() + 10
        while True:
            if b'\n' in self.pending:
                line, self.pending = self.pending.split(b'\n', 1)
                decoded = line.decode()
                if decoded.strip() == marker:
                    return '\n'.join(result).strip()
                result.append(decoded)
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.proc.stdout], [], [], remaining)[0]:
                raise TimeoutError(f'Bounded session read expired: {self.label}')
            chunk = os.read(self.proc.stdout.fileno(), 65536)
            if not chunk:
                self.stderr_file.flush()
                raise RuntimeError(self.stderr_path.read_text())
            self.pending += chunk
    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write(b'ROLLBACK;\n\\q\n')
                self.proc.stdin.flush()
                self.proc.wait(timeout=3)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.proc.kill()
                self.proc.wait(timeout=3)
        self.stderr_file.close()
    def abort(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=2)


def overlap(first_sql, second_sql, hold_seconds=0.0, on_wait=None):
    """Execute a real overlapping transaction and observe its PostgreSQL lock."""
    serial = len(checks)
    first = Session(f'connect_first_{serial}')
    second = Session(f'connect_second_{serial}')
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = None
    try:
        first_value = first.execute('BEGIN;\n' + first_sql)
        future = pool.submit(second.execute, second_sql)
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            waiting = query(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{second.label}' AND wait_event_type='Lock';").stdout.strip()
            if waiting == '1':
                break
            check(not future.done(), 'Second statement did not overlap a database lock.')
            time.sleep(0.025)
        else:
            raise RuntimeError('Expected PostgreSQL lock wait was not observed.')
        if on_wait is not None:
            on_wait(second.label)
        if hold_seconds:
            time.sleep(hold_seconds)
        first.execute('COMMIT;')
        second_value = future.result(timeout=8)
        return first_value, second_value
    finally:
        try:
            if future is not None and not future.done():
                second.abort()
        finally:
            try:
                first.close()
            finally:
                try:
                    second.close()
                finally:
                    pool.shutdown(wait=True, cancel_futures=True)

try:
    migration_bytes = migration.read_bytes()
    correction_bytes = correction.read_bytes()
    report['migration_sha256'] = hashlib.sha256(migration_bytes).hexdigest()
    report['correction_sha256'] = hashlib.sha256(correction_bytes).hexdigest()
    check(os.geteuid() != 0, 'initdb must run as a non-root disposable CI user.')
    for name in ('initdb', 'pg_ctl', 'psql'):
        check((bins / name).is_file(), f'Missing installed binary: {name}')
    baseline_path = root / 'supabase/migrations/20260422180000_v4_1_stripe_connect_opentimestamps.sql'
    permissions_path = root / 'supabase/migrations/20260919160000_connect_accounts_server_writes.sql'
    baseline = baseline_path.read_bytes()
    permissions = permissions_path.read_bytes()
    def blob(data):
        return hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
    check(blob(baseline) == '8b7eb2b9157eabb4415a7fa6b4b8a0b4f3e9a0d7', 'Unreviewed baseline schema.')
    check(blob(permissions) == 'dadbacdecbce1651fdd0b75a6ae27bb0a237345c', 'Unreviewed baseline privileges.')
    table = re.search(r'CREATE TABLE IF NOT EXISTS public\.connect_accounts \(.*?CREATE POLICY "users see own connect".*?;', baseline.decode(), re.S)
    check(table is not None, 'Exact baseline Connect table could not be extracted.')
    report['baseline_schema_blob'] = blob(baseline)
    report['baseline_privileges_blob'] = blob(permissions)

    owned = Path(tempfile.mkdtemp(prefix='connect-provision-pg-', dir='/tmp'))
    os.chmod(owned, 0o700)
    check(not output.is_relative_to(owned), 'Report cannot be inside the disposable cluster.')
    data = owned / 'data'; socket = owned / 'socket'; socket.mkdir(mode=0o700)
    env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
    env.update(PGHOST=str(socket), PGPORT='55441', PGUSER='audit_connect', PGDATABASE='postgres', PGCONNECT_TIMEOUT='5')
    psql = [str(bins / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
            '-h', str(socket), '-p', '55441', '-U', 'audit_connect', '-d', 'postgres']
    init = command([str(bins / 'initdb'), '-D', str(data), '-U', 'audit_connect', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
    check(init.returncode == 0, init.stderr)
    options = (f"-h '' -k {shlex.quote(str(socket))} -p 55441 -c unix_socket_permissions=0700 "
               "-c max_connections=10 -c shared_buffers=16MB -c statement_timeout=9000 "
               "-c lock_timeout=6000 -c idle_in_transaction_session_timeout=12000")
    start_attempted = True
    start = command([str(bins / 'pg_ctl'), '-D', str(data), '-l', str(owned / 'server.log'), '-o', options, '-w', '-t', '20', 'start'])
    check(start.returncode == 0, start.stderr + start.stdout)
    check(Path(query('SHOW data_directory;').stdout.strip()).resolve() == data.resolve(), 'Cluster identity mismatch.')
    check(query('SHOW listen_addresses;').stdout.strip() == '', 'TCP must remain disabled.')
    check(query('SHOW port;').stdout.strip() == '55441', 'Wrong cluster port.')
    report.update(cluster_identity_verified=True, tcp_listening_disabled=True,
                  server_version=query('SHOW server_version;').stdout.strip())
    query("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;"
          " CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);"
          " CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;"
          " GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;")
    query(table.group(0))
    query(permissions.decode())
    query(migration_bytes.decode())

    # Admission/ACL correction: run after the exact original migration, before
    # the existing twenty protocol scenarios. All identities and grants below
    # belong exclusively to this disposable cluster, never to deployed data.
    gate_legacy_user = '00000000-0000-4000-8000-000000000011'
    gate_absent_user = '00000000-0000-4000-8000-000000000012'
    gate_incomplete_user = '00000000-0000-4000-8000-000000000013'
    gate_acl_user = '00000000-0000-4000-8000-000000000014'

    def gate_snapshot():
        return object_query("SELECT jsonb_build_object("
            "'users',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY id),'[]'::jsonb) FROM auth.users u),"
            "'bindings',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY user_id),'[]'::jsonb) FROM public.connect_accounts b),"
            "'provisions',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY user_id),'[]'::jsonb) FROM public.connect_account_provisions p));")

    reset()
    query('INSERT INTO auth.users(id) VALUES '
          + ','.join('(' + literal(actor) + '::uuid)' for actor in
                     (gate_legacy_user, gate_absent_user, gate_incomplete_user, gate_acl_user)) + ';')
    gate_bound = object_query(claim_sql())
    check(gate_bound['decision'] == 'create')
    check(object_query(final_sql(gate_bound['operation_id']))['decision'] == 'bound')
    gate_pending = object_query(claim_sql(actor=other_user))
    check(gate_pending['decision'] == 'create')
    query("SET ROLE service_role; INSERT INTO public.connect_accounts(user_id,stripe_account_id) "
          f"VALUES('{gate_legacy_user}','acct_fixture_legacy'); RESET ROLE;")

    # These are expected pre-correction diagnostics, not evidence of an actual
    # compromise or of production grants. Check them before seeding extra ACLs.
    gate_old_legacy = object_query(claim_sql(actor=gate_legacy_user))
    gate_old_context = object_query(claim_sql(credential='b' * 64))
    check(gate_old_legacy['decision'] == 'bound', 'Historical SQL diagnostic changed.')
    check(gate_old_context['decision'] == 'bound', 'Bound-context SQL diagnostic changed.')
    gate_before_dml = gate_snapshot()
    gate_old_dml = query("BEGIN; SET LOCAL ROLE service_role; "
        "INSERT INTO public.connect_accounts(user_id,stripe_account_id) "
        f"VALUES('{gate_acl_user}','acct_diagnostic_before') RETURNING stripe_account_id; "
        f"UPDATE public.connect_accounts SET stripe_account_id='acct_diagnostic_after' WHERE user_id='{gate_acl_user}' RETURNING stripe_account_id; "
        f"DELETE FROM public.connect_accounts WHERE user_id='{gate_acl_user}' RETURNING stripe_account_id; ROLLBACK;")
    check(gate_old_dml.stdout.strip().splitlines() ==
          ['acct_diagnostic_before', 'acct_diagnostic_after', 'acct_diagnostic_after'])
    check(gate_snapshot() == gate_before_dml, 'Diagnostic DML transaction must roll back.')
    report['pre_correction_diagnostics'] = {
        'legacy_binding_decision': gate_old_legacy['decision'],
        'bound_changed_context_decision': gate_old_context['decision'],
        'service_role_direct_insert_update_delete': 'PERMITTED_IN_SYNTHETIC_BASELINE',
        'scope': 'Exact historical SQL in an owned fixture; no deployed incident or historical grants inferred.'}

    # Explicit column grants survive a table-only REVOKE. Seed both direct and
    # PUBLIC-inherited grants so that removing only one source cannot pass.
    query("GRANT INSERT(user_id,stripe_account_id), "
          "UPDATE(user_id,stripe_account_id,country,created_at,onboarding_completed,payouts_enabled,charges_enabled,kyc_verified_at,requirements,updated_at), "
          "REFERENCES(user_id,stripe_account_id) ON public.connect_accounts TO PUBLIC,anon,authenticated,service_role; "
          "GRANT DELETE,TRUNCATE,TRIGGER ON public.connect_accounts TO PUBLIC,anon,authenticated,service_role;")
    check(query("SELECT has_column_privilege('authenticated','public.connect_accounts','stripe_account_id','UPDATE');").stdout.strip() == 't')
    gate_pre_upgrade = gate_snapshot()
    check(len(gate_pre_upgrade['bindings']) == 2 and len(gate_pre_upgrade['provisions']) == 2)
    query(correction_bytes.decode())
    check(gate_snapshot() == gate_pre_upgrade, 'First correction changed existing data.')
    query(correction_bytes.decode())
    check(gate_snapshot() == gate_pre_upgrade, 'Reapplying correction changed existing data.')
    completed('incremental_correction_preserves_preupgrade_rows_twice',
              applications=2, existing_bindings=2, existing_provisions=2,
              preexisting_column_grants=True)

    gate_before = gate_snapshot()
    check(object_query(claim_sql(actor=gate_absent_user, parameters=None))['decision'] == 'reconcile')
    check(gate_snapshot() == gate_before, 'Resolution-only call created an absent intent.')
    completed('resolution_only_absent_user_has_no_intent_or_lease')

    for gate_lease in ('active', 'expired'):
        if gate_lease == 'expired':
            query("UPDATE public.connect_account_provisions SET lease_until=clock_timestamp()-interval '1 second' "
                  f"WHERE user_id='{other_user}';")
        gate_before = gate_snapshot()
        check(object_query(claim_sql(actor=other_user, parameters=None))['decision'] == 'reconcile')
        check(gate_snapshot() == gate_before, 'Resolution-only call mutated a pending intent or lease.')
    completed('resolution_only_preserves_pending_payload_key_and_lease', lease_variants=2)

    gate_before = gate_snapshot()
    gate_invalid_requests = [
        {'actor': None}, {'actor': '00000000-0000-4000-8000-000000000099'},
        {'actor': other_user, 'version': None}, {'actor': other_user, 'version': ''},
        {'actor': other_user, 'credential': None}, {'actor': other_user, 'credential': ''},
    ]
    for gate_invalid in gate_invalid_requests:
        check(object_query(claim_sql(parameters=None, **gate_invalid))['decision'] == 'reconcile')
    check(gate_snapshot() == gate_before, 'Incomplete resolution context mutated durable data.')
    completed('resolution_only_incomplete_context_has_no_mutation', invalid_variants=len(gate_invalid_requests))

    gate_before = gate_snapshot()
    for gate_parameters in (None, payload):
        check(object_query(claim_sql(actor=gate_legacy_user, parameters=gate_parameters))['decision'] == 'reconcile')
    check(gate_snapshot() == gate_before, 'Legacy refusal must not create or rewrite a provision.')
    completed('historical_binding_without_provision_requires_reconciliation', input_variants=2)

    gate_before = gate_snapshot()
    for gate_invalid in ({'credential': 'b' * 64}, {'credential': None},
                         {'version': 'different-api'}, {'version': None}):
        for gate_parameters in (None, payload):
            check(object_query(claim_sql(parameters=gate_parameters, **gate_invalid))['decision'] == 'reconcile')
    gate_bound_resolution = object_query(claim_sql(parameters=None))
    check(gate_bound_resolution == {
        'decision': 'bound', 'user_id': user, 'stripe_account_id': 'acct_fixture_one',
        'operation_id': gate_bound['operation_id'], 'api_version': '2025-09-30.clover',
        'provider_context': context})
    check(gate_snapshot() == gate_before, 'Context rejection or valid resolution mutated bound data.')
    completed('bound_resolution_requires_matching_context_api_and_operation', rejected_variants=8)

    gate_incomplete = object_query(claim_sql(actor=gate_incomplete_user))
    check(gate_incomplete['decision'] == 'create')
    check(object_query(final_sql(gate_incomplete['operation_id'], account='acct_fixture_incomplete', actor=gate_incomplete_user))['decision'] == 'bound')
    query(f"DELETE FROM public.connect_accounts WHERE user_id='{gate_incomplete_user}';")
    gate_before = object_query(f"SELECT to_jsonb(p) FROM public.connect_account_provisions p WHERE user_id='{gate_incomplete_user}';")
    check(object_query(claim_sql(actor=gate_incomplete_user, parameters=None))['decision'] == 'reconcile')
    gate_after = object_query(f"SELECT to_jsonb(p) FROM public.connect_account_provisions p WHERE user_id='{gate_incomplete_user}';")
    check(gate_after['state'] == 'reconcile' and gate_after['reconcile_reason'] == 'binding_conflict')
    check(gate_after['lease_until'] is None)
    check({key: value for key, value in gate_after.items() if key not in ('state', 'reconcile_reason', 'lease_until')}
          == {key: value for key, value in gate_before.items() if key not in ('state', 'reconcile_reason', 'lease_until')})
    check(query(f"SELECT count(*) FROM public.connect_accounts WHERE user_id='{gate_incomplete_user}';").stdout.strip() == '0')
    completed('bound_resolution_with_missing_mapping_is_quarantined')

    gate_roles = "(VALUES ('anon'),('authenticated'),('service_role')) AS roles(role_name)"
    check(query("SELECT count(*) FROM " + gate_roles
        + " CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS privileges(privilege_name) "
          "WHERE has_table_privilege(role_name,'public.connect_accounts',privilege_name);").stdout.strip() == '0')
    check(query("SELECT count(*) FROM " + gate_roles
        + " CROSS JOIN (VALUES ('user_id'),('stripe_account_id'),('country'),('created_at')) AS columns(column_name) "
          "CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('REFERENCES')) AS privileges(privilege_name) "
          "WHERE has_column_privilege(role_name,'public.connect_accounts',column_name,privilege_name);").stdout.strip() == '0')
    check(query("SELECT count(*) FROM (VALUES ('anon'),('authenticated')) AS roles(role_name) "
          "CROSS JOIN pg_attribute AS columns CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('REFERENCES')) AS privileges(privilege_name) "
          "WHERE columns.attrelid='public.connect_accounts'::regclass AND columns.attnum>0 AND NOT columns.attisdropped "
          "AND has_column_privilege(role_name,'public.connect_accounts',columns.attname::text,privilege_name);").stdout.strip() == '0')
    completed('column_and_table_identity_privileges_are_removed', tested_roles=3, inherited_public_grants=True)

    gate_before = gate_snapshot()
    gate_statements = [
        f"INSERT INTO public.connect_accounts(user_id,stripe_account_id) VALUES('{gate_acl_user}','acct_forbidden_insert');",
        f"UPDATE public.connect_accounts SET user_id=user_id WHERE user_id='{user}';",
        f"UPDATE public.connect_accounts SET stripe_account_id=stripe_account_id WHERE user_id='{user}';",
        f"UPDATE public.connect_accounts SET country=country WHERE user_id='{user}';",
        f"UPDATE public.connect_accounts SET created_at=created_at WHERE user_id='{user}';",
        f"DELETE FROM public.connect_accounts WHERE user_id='{user}';",
        'TRUNCATE public.connect_accounts;',
    ]
    for gate_role in ('anon', 'authenticated', 'service_role'):
        for gate_statement in gate_statements:
            gate_denied = query(f"SET ROLE {gate_role}; SET request.jwt.claim.sub='{user}'; " + gate_statement, expect_error=True)
            check(gate_denied.returncode != 0 and '42501' in gate_denied.stderr,
                  f'Expected permission denial for {gate_role}: {gate_statement}')
    check(gate_snapshot() == gate_before, 'Denied DML changed data.')
    completed('direct_binding_dml_is_denied_for_service_and_browser_roles', denied_attempts=21)

    gate_before = object_query(f"SELECT to_jsonb(b) FROM public.connect_accounts b WHERE user_id='{user}';")
    gate_status = object_query("SET ROLE service_role; UPDATE public.connect_accounts AS b SET "
        "onboarding_completed=true,payouts_enabled=true,charges_enabled=true,"
        "kyc_verified_at='2026-11-11T12:00:00Z',requirements='{" + '"fixture":"status-only"' + "}'::jsonb,"
        f"updated_at='2026-11-11T12:01:00Z' WHERE user_id='{user}' RETURNING to_jsonb(b); RESET ROLE;")
    check(all(gate_status[column] is True for column in ('onboarding_completed', 'payouts_enabled', 'charges_enabled')))
    check(gate_status['requirements'] == {'fixture': 'status-only'} and gate_status['kyc_verified_at'] is not None)
    check(all(gate_status[column] == gate_before[column] for column in ('user_id', 'stripe_account_id', 'country', 'created_at')))
    completed('service_status_updates_preserve_binding_identity', allowed_columns=6)

    check(int(query('SELECT count(*) FROM public.connect_accounts;').stdout.strip()) >= 2)
    gate_visible = object_query(f"SET ROLE authenticated; SET request.jwt.claim.sub='{user}'; "
        "SELECT coalesce(jsonb_agg(user_id::text ORDER BY user_id),'[]'::jsonb) FROM public.connect_accounts; RESET ROLE;")
    check(gate_visible == [user], 'Authenticated read lost owner scope or stopped working.')
    completed('authenticated_binding_read_remains_owner_scoped')

    reset()
    for role in ('anon', 'authenticated'):
        for sql in (claim_sql().replace('service_role', role), final_sql('00000000-0000-4000-8000-000000000099').replace('service_role', role)):
            denied = query(sql, expect_error=True)
            check(denied.returncode != 0 and '42501' in denied.stderr, 'Unprivileged RPC was not denied.')
    for role in ('anon', 'authenticated', 'service_role'):
        denied = query(f'SET ROLE {role}; SELECT * FROM public.connect_account_provisions;', expect_error=True)
        check(denied.returncode != 0 and '42501' in denied.stderr, 'Private journal directly readable.')
    completed('private_journal_and_rpc_privileges')

    first = object_query(claim_sql())
    check(first['decision'] == 'create')
    check(first['idempotency_key'] == 'connect-create:' + first['operation_id'])
    check(first['parameters']['metadata']['purama_connect_operation'] == first['operation_id'])
    check(first['parameters']['email'] == payload['email'])
    check(object_query(claim_sql())['decision'] == 'busy')
    completed('durable_operation_exists_before_provider_and_lease_blocks_overlap')

    fields = ["user_id='00000000-0000-4000-8000-000000000099'", "operation_id=gen_random_uuid()",
              "parameters='{}'::jsonb", "api_version='other'", "provider_context=repeat('b',64)",
              "created_at=created_at-interval '1 hour'", "retry_until=retry_until+interval '1 hour'"]
    for mutation in fields:
        refused = query(f'UPDATE public.connect_account_provisions SET {mutation};', expect_error=True)
        check(refused.returncode != 0 and 'connect_provision_immutable' in refused.stderr, mutation)
    completed('all_creation_identity_and_deadline_fields_are_immutable', fields=len(fields))

    check(object_query(claim_sql(credential='b'*64))['decision'] == 'reconcile')
    check(object_query(claim_sql(version='other-api'))['decision'] == 'reconcile')
    check(query('SELECT count(*) FROM public.connect_account_provisions;').stdout.strip() == '1')
    completed('provider_context_and_api_changes_do_not_start_another_operation')

    query("UPDATE public.connect_account_provisions SET lease_until=clock_timestamp()-interval '1 second';")
    replay = object_query(claim_sql(parameters={**payload, 'email': 'changed@example.invalid'}))
    check(replay['decision'] == 'create' and replay['operation_id'] == first['operation_id'])
    check(replay['parameters'] == first['parameters'] and replay['idempotency_key'] == first['idempotency_key'])
    completed('retry_keeps_frozen_payload_and_idempotency_key')

    # Finalization is a single real transaction. Ignore its successful receipt,
    # then read the committed binding exactly as a retrying handler would.
    final = object_query(final_sql(first['operation_id']))
    check(final['decision'] == 'bound')
    check(object_query(claim_sql())['decision'] == 'bound')
    check(object_query(final_sql(first['operation_id'])) == final)
    check(query('SELECT count(*) FROM public.connect_accounts;').stdout.strip() == '1')
    completed('committed_finalization_receipt_can_be_lost_and_replayed_idempotently')

    reset()
    values = overlap(claim_sql(), claim_sql())
    check(json.loads(values[0])['decision'] == 'create' and json.loads(values[1])['decision'] == 'busy')
    check(query('SELECT count(*) FROM public.connect_account_provisions;').stdout.strip() == '1')
    completed('concurrent_reservations_serialize', lock_wait_observed=True)

    operation = query('SELECT operation_id FROM public.connect_account_provisions;').stdout.strip()
    values = overlap(final_sql(operation), final_sql(operation))
    check(json.loads(values[0]) == json.loads(values[1]) and json.loads(values[1])['decision'] == 'bound')
    check(query('SELECT count(*) FROM public.connect_accounts;').stdout.strip() == '1')
    completed('concurrent_finalization_is_atomic_and_idempotent', lock_wait_observed=True)

    reset(); first = object_query(claim_sql())
    # Seed an expired intent as the owner; do not modify immutable timestamps.
    seed_deadline(first, '-2 hours')
    check(object_query(claim_sql())['decision'] == 'reconcile')
    check(query('SELECT operation_id FROM public.connect_account_provisions;').stdout.strip() == first['operation_id'])
    completed('expired_intent_cannot_start_or_replace_a_creation')
    check(object_query(final_sql(first['operation_id']))['decision'] == 'bound')
    completed('verified_late_receipt_can_finalize_without_another_provider_creation')

    reset(); first = object_query(claim_sql())
    query("UPDATE public.connect_account_provisions SET lease_until=clock_timestamp()+interval '2 seconds';")
    values = overlap(f"SELECT user_id FROM public.connect_account_provisions WHERE user_id='{user}' FOR UPDATE;", claim_sql(), hold_seconds=2.2,
      on_wait=lambda label: check(query("SELECT p.lease_until > a.query_start FROM public.connect_account_provisions p "
        f"CROSS JOIN pg_stat_activity a WHERE a.application_name='{label}';").stdout.strip() == 't', 'Lease already expired before the overlapping query.'))
    check(json.loads(values[1])['decision'] == 'create')
    completed('lease_clock_is_refreshed_after_waiting_for_lock', lock_wait_observed=True)

    reset(); first = object_query(claim_sql())
    seed_deadline(first, '18 seconds')
    values = overlap(f"SELECT user_id FROM public.connect_account_provisions WHERE user_id='{user}' FOR UPDATE;", claim_sql(), hold_seconds=3.2,
      on_wait=lambda label: check(query("SELECT p.retry_until - a.query_start > interval '15 seconds' FROM public.connect_account_provisions p "
        f"CROSS JOIN pg_stat_activity a WHERE a.application_name='{label}';").stdout.strip() == 't', 'Retry deadline already crossed before the overlapping query.'))
    check(json.loads(values[1])['decision'] == 'reconcile')
    completed('retry_deadline_is_refreshed_after_waiting_for_lock', lock_wait_observed=True)

    reset(); first = object_query(claim_sql())
    check(object_query(final_sql(first['operation_id'], verified=False))['decision'] == 'reconcile')
    check(object_query(final_sql(first['operation_id'], verified=True))['decision'] == 'reconcile')
    check(query('SELECT count(*) FROM public.connect_accounts;').stdout.strip() == '0')
    completed('unverified_receipt_requires_explicit_reconciliation')

    reset(); first = object_query(claim_sql())
    check(object_query(final_sql(first['operation_id']))['decision'] == 'bound')
    check(object_query(final_sql(first['operation_id'], account='acct_fixture_other'))['decision'] == 'reconcile')
    check(object_query(final_sql(first['operation_id']))['decision'] == 'reconcile')
    check(query('SELECT cardinality(observed_account_ids) FROM public.connect_account_provisions;').stdout.strip() == '2')
    check(query('SELECT stripe_account_id FROM public.connect_accounts;').stdout.strip() == 'acct_fixture_one')
    check(object_query(claim_sql())['decision'] == 'reconcile')
    completed('conflicting_receipts_are_retained_and_remain_blocked')

    reset(); first = object_query(claim_sql())
    query(f"INSERT INTO public.connect_accounts(user_id,stripe_account_id) VALUES('{other_user}','acct_fixture_one');")
    check(object_query(final_sql(first['operation_id']))['decision'] == 'reconcile')
    check(query(f"SELECT user_id FROM public.connect_accounts WHERE stripe_account_id='acct_fixture_one';").stdout.strip() == other_user)
    check(query('SELECT cardinality(observed_account_ids) FROM public.connect_account_provisions;').stdout.strip() == '1')
    completed('unique_external_account_collision_never_rebinds_another_user')

    reset(); first = object_query(claim_sql())
    query(f"INSERT INTO public.connect_accounts(user_id,stripe_account_id) VALUES('{user}','acct_historical');")
    check(object_query(final_sql(first['operation_id']))['decision'] == 'reconcile')
    check(query('SELECT stripe_account_id FROM public.connect_accounts;').stdout.strip() == 'acct_historical')
    check(query('SELECT stripe_account_id FROM public.connect_account_provisions;').stdout.strip() == 'acct_fixture_one')
    completed('historical_binding_is_never_overwritten_by_finalization')

    reset(); first = object_query(claim_sql())
    check(object_query(final_sql('00000000-0000-4000-8000-000000000099'))['decision'] == 'reconcile')
    check(object_query(final_sql(first['operation_id'], actor=other_user))['decision'] == 'reconcile')
    check(query('SELECT count(*) FROM public.connect_accounts;').stdout.strip() == '0')
    completed('wrong_operation_or_owner_cannot_finalize')

    reset(); first = object_query(claim_sql())
    query(f"DELETE FROM auth.users WHERE id='{user}';")
    check(object_query(final_sql(first['operation_id']))['decision'] == 'reconcile')
    check(query('SELECT cardinality(observed_account_ids) FROM public.connect_account_provisions;').stdout.strip() == '1')
    completed('deleted_user_keeps_private_uncertain_receipt_without_binding')

    reset(); first = object_query(claim_sql())
    values = overlap(f"DELETE FROM auth.users WHERE id='{user}' RETURNING id;", final_sql(first['operation_id']))
    check(json.loads(values[1])['decision'] == 'reconcile')
    check(query('SELECT cardinality(observed_account_ids) FROM public.connect_account_provisions;').stdout.strip() == '1')
    completed('auth_deletion_wins_before_finalization', lock_wait_observed=True)

    reset(); first = object_query(claim_sql())
    values = overlap(final_sql(first['operation_id']), f"DELETE FROM auth.users WHERE id='{user}' RETURNING id;")
    check(json.loads(values[0])['decision'] == 'bound' and values[1] == user)
    check(query('SELECT count(*) FROM public.connect_accounts;').stdout.strip() == '0')
    check(query('SELECT cardinality(observed_account_ids) FROM public.connect_account_provisions;').stdout.strip() == '1')
    completed('auth_deletion_waits_for_finalization_and_receipt_survives', lock_wait_observed=True)

    check(len(checks) == 31, 'Unexpected number of completed native scenarios.')
    report['status'] = 'PASS'
except BaseException as error:
    report['error'] = f'{type(error).__name__}: {error}'

finally:
    cleanup_errors = []
    for session in sessions:
        try:
            session.close()
        except BaseException as error:
            cleanup_errors.append(f'Client cleanup: {type(error).__name__}: {error}')
    stopped = not start_attempted
    if start_attempted:
        try:
            stop = command([str(bins / 'pg_ctl'), '-D', str(data), '-m', 'fast', '-w', '-t', '15', 'stop'], timeout=20)
            report['stop_exit_code'] = stop.returncode
        except BaseException as error:
            cleanup_errors.append(f'Cluster stop: {type(error).__name__}: {error}')
        try:
            status = command([str(bins / 'pg_ctl'), '-D', str(data), 'status'], timeout=5)
            stopped = status.returncode == 3 and not (data / 'postmaster.pid').exists()
        except BaseException as error:
            cleanup_errors.append(f'Cluster status: {type(error).__name__}: {error}')
            stopped = False
    report['cluster_stopped'] = stopped
    if owned is None:
        report['owned_cluster_created'] = False
        report['owned_cluster_removed'] = False
    elif report['cluster_stopped']:
        report['owned_cluster_created'] = True
        try:
            shutil.rmtree(owned)
            report['owned_cluster_removed'] = True
        except BaseException as error:
            cleanup_errors.append(f'Owned directory cleanup: {type(error).__name__}: {error}')
            report['owned_cluster_removed'] = False
    else:
        report['status'] = 'FAILED'
        report['owned_cluster_removed'] = False
        report['cleanup_required_at'] = str(owned)
    if cleanup_errors:
        report['status'] = 'FAILED'
        report['cleanup_errors'] = cleanup_errors
    output = Path(args.report).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))
raise SystemExit(0 if report['status'] == 'PASS' else 1)
