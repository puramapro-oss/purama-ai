# Entraide protocol verification

These tests exercise the existing Entraide page and four edge functions. They do
not connect to a production database or use real user credentials.

## Prerequisites

The active page and its public HTTP client have no private package dependency.
The server-side matching adapter requires the existing private canonical package
under `../packages/purama-entraide`. Restore it from its authorized checkout; do
not substitute a similarly named public npm package. Prepare its ignored matching
deployment copy with `node scripts/build-entraide-matching.mjs`, which verifies
the source digest. See `supabase/functions/_shared/vendor/README.md`.

Install test-only database dependencies separately:

```sh
npm ci --ignore-scripts --no-audit --prefix tests/entraide
```

## Local PostgreSQL WASM, HTTP and SDK checks

With the application's existing dependencies installed and matching prepared:

```sh
node --max-old-space-size=384 --wasm-num-compilation-tasks=1 \
  --test --test-concurrency=1 tests/entraide/*.test.mjs
```

`ENTRAIDE_PGLITE_MODULE` may point to an existing PGlite module instead of installing
another copy. The engine executes the real baseline and new SQL migrations,
roles, grants, policies and transactions. It is a single-connection engine: four
native concurrency tests explicitly skip in this mode. Sequential RPC calls must
never be reported as proof of independent concurrent transactions.

`reconciliation-db.test.mjs` applies the exact PR #17 migrations stored as inert
fixtures, executes their authenticated RPC, then applies the explicit bridge and
canonical migrations. It checks preserved receipts, counter translation and
current access checks on replay. `applied-pr23-db.test.mjs` installs the exact
historical #23 SQL, skips its recorded migration versions, and applies only the
new `022000` upgrade; known reapplication and unknown-schema refusal are checked.
`preflight-db.test.mjs` runs the first pending contact migration with its own
`BEGIN/COMMIT`, without an outer test transaction. It checks that incompatible
histories leave functions, grants, policies, schema, rows and receipts unchanged,
and that an exact contact-only partial installation can resume normally.

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

The command refuses to run without `ENTRAIDE_DATABASE_URL`; it cannot silently
qualify PGlite as native PostgreSQL. The four races hold a witness transaction until `pg_stat_activity` shows distinct
backend PIDs actually waiting for locks. They then release the contenders and
inspect the committed rows: final mission place, duplicate contact command, and
the daily contact quota, plus one durable mission receipt for simultaneous retries.
The dedicated GitHub workflow is configured to run these checks against
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
- The first pending `020000` migration inspects compatibility before committing
  any contact RPC or grant changes. It refuses known private protocol footprints,
  foreign authorities and incompatible #17 receipts without rewriting them.
  An exact contact-only partial installation may retry this step.
  The pending `021000` migration recognizes the exact PR #17 RPC and retires
  its definer authority. The additive `022000` migration translates its counter
  to `revision = version - 1` and preserves request identities and stored
  responses. An existing #23 installation applies only `022000`; no applied
  historical migration is replayed. Unknown installations fail closed.
  See [the reconciliation receipt](RECONCILIATION-20261110.md) and
  [the first-migration refusal qualification](PREFLIGHT-20261110.md).
- First-party mission mutations carry `request_id` and their captured revision.
  Replays return current accessible state; historical receipts never grant access
  after a member leaves a private mission. Earlier #23 calls without `request_id`
  retain their original behavior and do not gain durable retry guarantees.
- Frontend, edge functions and schema must be released together in staging first.
  In-flight #17 writes can translate `expected_version` and request-only creation
  IDs, but current reads expose `revision`; old browser builds must refresh.
  Direct mission-table reads and the old SQL definer are no longer client APIs.
- Matching scans at most 500 candidate profiles and returns `truncated` explicitly.
  Mission/contact lists still require pagination before large-scale use.
- Worker-local burst limiting supplements the transactional daily contact limit;
  it is not a distributed quota for every endpoint.

## Integration on the qualified core (11 November 2026)

The integration selects 78 of the 80 paths from PR #23 at
`f69b2a9a4af0e866848bf3ab860817df8b97c527`. The historical `src/lib/entraide.ts`
adapter and its two `compatibility-client.test.mjs` cases are not imported.
Neither file existed in the core, no application module consumes that adapter,
and the application is private with no package export surface. The active page
uses `src/lib/entraide-http.ts`. The original PR and historical receipts remain
intact; their older compatibility results do not describe this selected tree.
No private transition implementation or permissive type stub replaces it.

The two baseline migrations dated 4 and 5 September are required before the
three reconciled migrations `020000`, `021000` and `022000`. The protected route
and navigation preserve the core authentication boundary.

CI coverage has distinct boundaries:

- `entraide-project-flow.yml` executes the 92 native PostgreSQL scenarios. They
  need no private package and cover SQL, concurrency and the HTTP response
  contract; they do not execute the private matching adapter.
- The site workflow compiles and tests the active application. Its Deno check
  lists specific existing Edge functions; it does not discover every function
  and does not qualify the four new Entraide deployment entries automatically.
- The HTTP/SDK adapter suite, four-entry Deno check and browser harness require
  the hash-verified ignored matching bundle. Local evidence records that exact
  private prerequisite; a public CI checkout alone cannot reproduce those gates.
- A deployment must prepare the canonical matching bundle and qualify the four
  routes with the migrations in staging. No hosted Auth, production database,
  deployed Edge function or real user flow is certified by these local tests.
