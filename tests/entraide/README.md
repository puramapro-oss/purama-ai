# Entraide protocol verification

These tests exercise the existing Entraide page and four edge functions. They do
not connect to a production database or use real user credentials.

## Prerequisites

The application still uses the existing private sibling packages under
`../packages/`. Restore them from their authorized canonical checkout; do not
substitute a similarly named public npm package. The matching deployment copy is
prepared with `node scripts/build-entraide-matching.mjs`, which verifies its source
digest. See `supabase/functions/_shared/vendor/README.md`.

Install test-only database dependencies separately:

```sh
npm ci --ignore-scripts --prefix tests/entraide
```

## Local PostgreSQL WASM, HTTP and SDK checks

With the application's existing dependencies installed and matching prepared:

```sh
node --max-old-space-size=384 --wasm-num-compilation-tasks=1 \
  --test --test-concurrency=1 tests/entraide/*.test.mjs
```

`ENTRAIDE_PGLITE_MODULE` may point to an existing PGlite module instead of installing
another copy. The engine executes the real baseline and new SQL migrations,
roles, grants, policies and transactions. It is a single-connection engine: three
native concurrency tests explicitly skip in this mode. Sequential RPC calls must
never be reported as proof of independent concurrent transactions.

The HTTP suite uses real Request/Response handlers and the real shared burst
limiter. SDK tests use the actual pinned Supabase client with only provider HTTP
responses substituted. They verify URL, schema, payload, auth and error behavior,
but do not prove hosted Supabase availability or deployed credentials.

## Native PostgreSQL, including real concurrency

Use an isolated local PostgreSQL service with an administration database named
`entraide_test_admin`, listening on an explicit non-default loopback port. Set
`ENTRAIDE_DATABASE_URL`; optionally set `ENTRAIDE_PG_MODULE` to an existing `pg`
module. The harness creates a unique disposable database for every fixture,
checks existing test-role privileges and closes its connections before cleanup.
It refuses remote hosts, the normal port 5432, arbitrary database names and URL
query parameters.

```sh
npm run test:native --prefix tests/entraide
```

The three races hold a witness transaction until `pg_stat_activity` shows distinct
backend PIDs actually waiting for locks. They then release the contenders and
inspect the committed rows: final mission place, duplicate contact command, and
the daily contact quota. The dedicated GitHub workflow runs these checks against
a disposable PostgreSQL service; no application secret is required.

## Real page in Firefox

With Firefox installed for Playwright, run:

```sh
node tests/entraide/fixtures/run-browser.mjs
```

`ENTRAIDE_BROWSER_EXECUTABLE` may identify an existing compatible Firefox binary.
The launcher applies the same bounded V8 compilation settings. There is one worker,
no automatic retry and a stop at the first failed scenario.

The fixture mounts the actual Entraide page, existing UI primitives and React Query.
Requests reach the actual HTTP handlers and SQL RPCs. Two clearly identified test
actors replace the authentication provider, and profile ports use the test database
directly. Consequently, these checks cover the local UI→HTTP→SQL→UI flow, not the
full application login shell or deployed Supabase Auth/PostgREST.

Scenarios cover private creation/publication/join/start/completion, contact consent
and revocation, lost confirmations with stable IDs, draft preservation, and a
390-pixel viewport. Traces, screenshots and HTTP evidence remain in ignored local
`test-results/`; they must not be committed as user-data artifacts.

## Integration boundaries

- `terminee` is an organizer's declaration. It does not verify real-world delivery
  and never triggers a payment.
- New mission records and legacy records are private after the new migration.
  Existing participants retain access through the RPC.
- The RPC `entraide_mission_mutate(uuid,text,uuid,jsonb,bigint)` from another repair
  protocol must be reconciled before installing this migration. The migration
  explicitly refuses coexistence because an authenticated definer RPC could bypass
  the new visibility protocol. It does not delete or revoke that other work.
- Frontend, edge functions and schema must be released together in staging first.
  Old clients lacking stable creation IDs must refresh; direct mission-table reads
  are intentionally no longer the client API.
- Matching scans at most 500 candidate profiles and returns `truncated` explicitly.
  Mission/contact lists still require pagination before large-scale use.
- Worker-local burst limiting supplements the transactional daily contact limit;
  it is not a distributed quota for every endpoint.
