# Entraide — verification of the 10 November 2026 candidate

> Historical receipt for the PR #23 baseline ending at `eb09c6d`. Its counts,
> build and remote CI observations were not re-executed by the later reconciliation.
> For the current code, use [RECONCILIATION-20261110.md](RECONCILIATION-20261110.md).
> The conflicting-protocol refusal described below is now preceded by an explicit,
> source-checked #17 transition; unknown implementations remain refused.

## Scope and outcome

The existing `/dashboard/entraide` page, four edge endpoints and the existing
`purama_ai` tables have been repaired together. No new product, wallet, payment
engine or messaging service is introduced. This is a review candidate, not a
production deployment.

The original endpoints passed a ResponseInit object to a helper requiring a
numeric status, and passed a Supabase client to a string-key rate limiter. Both
faults were reproduced before editing. Other corrections cover owner-only profile
coordinates, bidirectional blocks, atomic membership changes, organizer rights,
stable creation IDs, conditional revisions, explicit visibility and truthful
completion wording.

## Results observed locally

| Check | Status | Evidence and limit |
|---|---|---|
| Node protocol/HTTP/transport/SDK suite | PASS | 92 registered tests: 89 passed, 0 failed, 3 explicitly skipped; exit 0, 13.07 s |
| Contact SQL | PASS | 22 scenarios plus their parent test; real PGlite roles, grants, RLS, transaction rollback, UTC/DST boundaries |
| Mission SQL | PASS | 24 scenarios including privacy, capacity, owner transitions, visibility, initial-visibility replay and conflicting-RPC migration refusal |
| Browser transport | PASS | 13 tests, including the application's actual `VITE_SUPABASE_PUBLISHABLE_KEY` setting and legacy ANON fallback |
| HTTP integration | PASS | 9 tests, including actual handler→SQL lifecycle/contact flows and bounded matching |
| Response contracts | PASS | 12 tests; malformed or mismatched mission/contact DTOs never return success |
| Real Supabase SDK | PASS | 8 tests using SDK 2.91.0; only provider HTTP responses substituted; no hosted-provider validation claimed |
| Application production build | PASS | `npm run build`, Vite 5.4.21, 15.38 s; Entraide chunk 28.78 kB / 8.34 kB gzip |
| Focused TypeScript check | PASS | Page, browser transport and legacy compatibility adapter, with their real dependencies |
| Deno type/import check | PASS | All four edge entry points, Deno 2.9.6, pinned npm Supabase SDK, existing local dependencies |
| Targeted ESLint | PASS | Page and browser helpers; final checks recorded in the candidate handoff |
| GitNexus change detection | PASS with coverage limit | Final pre-commit comparison: 34 files, 61 indexed symbols, one resolved Entraide flow, medium risk; newly added symbols and dynamic SQL are not fully represented |
| Native concurrent SQL races | NON TESTÉ / CI BLOQUÉ | Three explicit local skips. The local namespace maps only UID/GID 0, so native PostgreSQL cannot be started as a permitted non-root user. The first remote CI attempt failed without any reported job steps or accessible log; no native SQL test pass is claimed |
| Real browser scenarios and mobile viewport | BLOQUÉ / NON TESTÉ | Firefox cannot create even an empty page in this runtime; no product action executed |
| Hosted Supabase auth, deployed edge runtime, production data | NON TESTÉ | No production credentials, migration or deployment was exercised |

The protocol log SHA-256 is
`234fcc8ab3b357141c823a1f412555407a295feecf0f719eca8e385edc5ec380`.
The production build log SHA-256 is
`826be31b03cbc68ac3b057975df4e0842de0f5908b674b56b35dc8fd2d8f0929`.

Earlier parallel build/check attempts were killed by shared memory pressure. The
successful runs above used bounded heap settings and one WebAssembly compilation
task; failures were not relabeled as passes. The full-project TypeScript run also
reported errors in files outside this change. Focused TypeScript success and a
successful Vite build do not establish a globally clean typecheck.

## Published candidate and remote CI observation

[Draft PR #23](https://github.com/puramapro-oss/purama-ai/pull/23) contains the
candidate. Its initial commit is
`bf0be2bfd1cb53f7490be8da48f3002ee9acc620`, with Git tree
`dce8b6ba3b3b9d9d15b0004df789299700625add`, exactly matching the locally checked
tree. Later evidence-only documentation updates do not change the tested code.

The first [PostgreSQL workflow run](https://github.com/puramapro-oss/purama-ai/actions/runs/42744686344)
was created at 02:43:24 UTC on 10 November 2026 and completed with `failure` at
02:43:28 UTC. Job `postgres` (129593857387) exposes an empty steps array; its log
download returns `404 BlobNotFound`. The check output has no summary or text. The
available connector rejects the annotation endpoint, so the underlying cause is
not established. No billing, image, YAML or SQL fault is inferred from this.

The workflow remains supplied for a compatible, permitted runner. Native
concurrency verification is **not complete**, and this failed attempt contributes
no passing product tests. No identical manual rerun was requested without a
diagnosed cause to address.

## Browser limitation established separately from product behavior

The test harness's initial data-URL loading problem was corrected with temporary
`.mjs` files and cleanup. The real page then remained unreachable because Firefox
could not create its first page. An isolated `about:blank` probe using the
compatible Playwright 1.62.1 / Firefox 1538 pair produced:

```text
Sandbox: writing /proc/self/uid_map: EPERM
content process exited on signal 11
ERROR: cannot find session with id ...
NEW_PAGE_TIMEOUT_15000
```

The browser report contains an empty API transcript and empty profile, mission,
participant, contact and block tables. Thus no UI action, visual assertion or mobile
assertion passed. No sandbox protection was disabled, and no functional assertion
was removed. The three complete scenarios remain ready for a compatible test
environment.

## Integration with other ongoing work

[PR #17](https://github.com/puramapro-oss/purama-ai/pull/17) is a separate draft
touching the same module. It was detected during this work after the initially
clean neighboring checkout changed. Its `entraide_mission_mutate` authenticated
definer protocol and `version` counter must be reconciled with this candidate's
service-only command protocol, `revision` and visibility rules before integration.

Do not apply both protocols cumulatively. This candidate's migration refuses to
run when the exact conflicting RPC signature exists, before changing tables or
privileges. Its rollback test preserves the other function, grants and existing
rows. This is an explicit integration gate; it is not a silent removal of another
branch's work. No other checkout or pull request was modified.

## Remaining release gates

1. Review and reconcile the overlapping mission change into one canonical protocol.
2. Require native PostgreSQL CI, including actual lock waiters, to pass.
3. Execute the three browser scenarios in a compatible environment, including 390 px
   layout and lost-confirmation recovery.
4. Validate the actual hosting configuration, exposed schema, authentication and
   service-only RPC access in staging. The browser must receive only a publishable
   key; the service role remains in the edge runtime.
5. Release UI, functions and migrations together with a client refresh plan. Legacy
   direct mission-table reads and creation commands without stable IDs must not be
   retained as an alternate write path.

No local test proves universal novelty, real-world project completion, payment
execution or readiness of the entire HUMAN ONE / ONE ecosystem. `terminee` remains
an organizer declaration; accepted contact remains consent, not a new chat channel.
