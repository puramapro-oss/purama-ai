# Entraide — isolated integration on the qualified core

## Source selection

Base: `f7660e43bb72b29408611593d62c1bcee53ce4a1`. Donor: PR23 at
`f69b2a9a4af0e866848bf3ab860817df8b97c527`. The integration retains 78 of its 80
paths and the two baseline migrations from `d116dc8`. It does not merge all main.

The two omitted files are the historical `src/lib/entraide.ts` adapter and its
2 compatibility tests. They were absent from the base, have no application
consumer and are not a published package API. Their original blobs and receipts
remain in PR23; `selection.json` records their hashes. No private transitions,
replacement matching algorithm or permissive type declarations are introduced.

The five migrations are exact source copies. The #17/#23 reconciliation remains
one mission protocol; #17 SQL appears only as inert historical test fixtures.
The protected route and navigation reuse current authentication. No root or KARTA
dependency manifest/lock is changed.

## Defect reproduced and corrected

An old mutation response could update cache and display a success after A→B,
logout, or A→B→A. The existing `useRequestScope` lifetime guard now protects all
seven mutation callbacks. The requests, intent IDs, expected revisions and JSX
remain unchanged. On the same nine real-component cases, the donor produced
3 PASS / 6 FAIL; the integrated page produces 9 PASS / 0 FAIL. See the before/after logs.
The test uses real React 18.3.1, React Query 5.83.0, transport and UI components with
synthetic auth and inert HTTP in JSDOM 26.1.0. It is not a hosted-login test.

## Measured qualification

- 92/92 PostgreSQL native scenarios, including four witnessed concurrent races;
 zero failures, skips, cancellations or todos.
- 30/30 additional HTTP/real-SDK/transport scenarios; zero failures or skips.
- 22/22 cases in the new public CI command: 13 transport cases already included
 in those 30, plus 9 account-scope cases. These are not added as 22 new scenarios.
- Site types and Vite build PASS with the private frontend package absent;
 the Entraide chunk is 33.74 kB before gzip. Lint: 0 errors / 21 existing warnings.
- Four Edge entries pass Deno check with cached dependencies and the exact
 ignored canonical matching bundle. Both modified workflows pass actionlint.

The native receipt records Node 22.23.4, PostgreSQL 18.4, pg 8.23.0 and exact source
hashes before/after. The fresh 0700 cluster was identified through its private
socket and loopback endpoint, contained no prior application state, and was
stopped. Status 3, absent PID/postmaster/socket and a free port were proved before
removing only the marked fixture. No existing database was accessed.

## CI and runtime boundaries

The dedicated Entraide workflow retains the 92 native tests with its existing
PostgreSQL 18.6 and pg 8.16.3 lock. Only `--no-audit` is added to installation.
CHEF gains one explicit public transport/account-isolation step; all previous
steps are byte-identical after removing that addition. No mobile audit is added.

The public site does not require `@purama/entraide`. Server matching still requires
its private canonical source and `scripts/build-entraide-matching.mjs`. The
builder checks SHA256 `a81b93a2d14c5ebcc9fe3b2fa86eca982c04aeda30c1b6cd8e5f433b25b20e24`.
Generated output is ignored and no private implementation is committed. Public
CI therefore does not independently qualify the HTTP/SDK adapter or all four
Edge entries: CHEF's Deno list is explicit and omits them. The local evidence
records this private prerequisite, rather than treating native SQL or site green
as deployed matching evidence.

Hosted Supabase Auth/PostgREST, deployed functions, physical devices and production
load remain untested here. The schema, four functions and prepared private bundle
must be qualified together in staging before deployment. This work performs no
installation, provider action, push or deployment.

## Evidence

`RECEIPT.json` maps each result to its log. Native full result/logs, independent UI
before/after receipts, site build/type/lint logs and Edge/workflow checks are kept
here. `native-runner-evidence.py.txt` is the exact local launcher archive; its
original command/location are recorded in the native receipt. Historical PR23
receipts elsewhere remain provenance, not results for this integrated tree.
GitNexus's initial 150-second timeout is preserved; the final change-analysis
result is recorded separately before the local commit.

The generated-contracts `--check` also passes with the existing KARTA PGlite 0.5.8.
Its catalogue explicitly includes only `p3_schema.sql` and the 20260422180000
Stripe/OpenTimestamps migration; it does not discover every Entraide migration.
No generated contract was rewritten. The warm GitNexus index completed in 118.37s
using the existing parse cache; graph coverage limitations remain in its receipt.

Final staged analysis reports HIGH risk across 113 changed paths, 819 reported
symbols and 15 affected flows. These are bounded graph observations, not an
exhaustive proof. The 113 paths are 78 selected donor paths, 2 baseline SQL,
4 route/navigation paths, 1 new UI test, 1 CHEF addition and 27 new QA files.
Only the five pre-existing route/navigation/workflow files change in the core.
75 selected donor paths are byte-identical; the page, native workflow and README
have the three explicitly documented differences. Targeted impacts and full
staged CLI output are embedded in RECEIPT.json. Historical results remain dated.
