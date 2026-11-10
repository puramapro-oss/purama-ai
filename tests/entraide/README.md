# Mission transaction tests on PostgreSQL

These tests execute the four versioned entraide migrations and the real RPCs on a
disposable PostgreSQL service. No application server, private shared package,
Supabase account, model API, or production credential is used.

## Run

Use Node 22 and a fresh PostgreSQL 15 service. `DATABASE_URL` must identify its
administrative connection on `localhost`, `127.0.0.1`, `::1`, or the CI service
hostname `postgres`. The connection needs permission to create a test database
and the roles `anon`, `authenticated`, and `service_role` if absent.

```sh
npm ci --prefix tests/entraide --ignore-scripts --no-audit --no-fund
npm test --prefix tests/entraide
```

The runner creates a uniquely named `entraide_test_*` database, applies the
migrations there, and removes that database during cleanup. Roles created by the
runner are also removed. Never point this test command at a production service.

`auth.uid()` is a test fixture backed by `request.jwt.claim.sub`. Actor operations
use explicit transactions with `SET LOCAL ROLE authenticated` and
`set_config(..., true)`. This exercises database permissions and RPC behaviour; it
does not validate real JWT issuance, PostgREST, or provider authentication.

## Coverage

- RPC privileges, fixed search path, authentication and RLS boundaries.
- Private idempotence ledger and denied direct mission writes.
- Own-profile coordinates available only through the caller-scoped RPC, without
  changing public profile policies or direct coordinate column privileges.
- Owner permissions, optimistic versions, quorum and terminal states.
- Voluntary departures during active missions, including the organiser.
- Stored response replay, conflicting requests and actor-scoped request keys.
- Late trigger failure with rollback of membership, version and request state.
- Last-place competition, simultaneous join/leave and duplicate/conflicting
  request keys with distinct PostgreSQL backends.

Concurrency assertions observe actual `pg_stat_activity` lock waiters before
releasing a transaction. They do not use two queued queries on one connection or
replace PostgreSQL with a mock. A missing server or failed setup is a test failure,
not a skipped or passing test.
