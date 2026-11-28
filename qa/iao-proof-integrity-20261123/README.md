# IAO — strict evidence-preserving whitespace gate

## Problem and exact baseline

The Wealth engine continuity workflow failed at the comparison step for the
integration PR #40, before GitNexus could run:

- Base: `42d508b46dc7e7cda7efe3c6bfd4396450afedef`.
- Head: `1170ac3a91e2c828b893a7374f4271a06827d0d2`.
- Workflow run: https://github.com/puramapro-oss/purama-ai/actions/runs/45270456863.
- Original gate exit: **2**, reproduced locally.

Fourteen raw qualification records introduced by PR #102 contain original
trailing spaces or final blank lines. Editing these records would change their
archived evidence hashes.

## Correction

The existing finite archived-record list gains fourteen exact `(Git blob, path)`
pairs. The matching logic is unchanged: an exception requires the exact content,
exact path, mode `100644`, and no path at all in the comparison base. Existing
records, modified records, changed modes, other QA files and application sources
continue through the strict check. The unfiltered diagnostic remains in the log.
No wildcard exclusion or ignored failure is introduced.

The CI workflow now executes the regression harness before the comparison, saves
its result and fails normally on a regression. Both the harness and its immutable
fixture are included in the workflow path triggers. The new audit branch has an
explicit Vercel deployment exclusion.

## Verification completed in this session

- The same base/head comparison, using the corrected gate: **exit 0**, with 37
  exact initial archive exceptions (23 existing + 14 added).
- Ten regression scenarios: **10/10 PASS**, run against the real shell gate in
  disposable Git repositories. They cover unchanged content, the first exact
  archive, mutation, rename, an unlisted QA file, application whitespace, an
  exempt archive together with a bad source, a preexisting path, an executable
  archive and an invalid revision.
- The fourteen raw qualification archives remain byte-identical to the head,
  with both Git blob identities and SHA-256 values recorded.
- Workflow YAML parsing and fail-closed wiring checks: **PASS**.
- Source whitespace check on the patch: **PASS**.
- Independent static review: matching logic preserved; no product source is
  exempted by an archive match. This does not prove application correctness.

## Local analysis limitation and CI reception

GitNexus 1.6.12 indexing was attempted in the isolated checkout. Resource-limited
attempts ended with exit 137 or a V8 heap failure (134). `detect-changes --scope
all` was then invoked before preparing the commit and returned exit 1 because
no completed index was available. These outcomes are **NON VALIDÉ**, not PASS.
The working tree was also reviewed directly: no existing application function,
class or method changed. CI must perform its existing index and exact-base
change analysis before this correction is integrated. Its fresh workflow result
is the authority for that reception; local failure records stay preserved.

This change does not activate the IAO runtime, claim model inference success,
resolve the Fabric socket, or qualify the Android offline flow. It preserves the
shared dirty Mac checkout and the separate PR #99 work.

## Reproduce

```bash
python3 scripts/ci/test-wealth-diff.py
bash scripts/ci/check-wealth-diff.sh 42d508b46dc7e7cda7efe3c6bfd4396450afedef 1170ac3a91e2c828b893a7374f4271a06827d0d2
```

The second command deliberately uses the original exact consolidation comparison
with the gate from this correction. The PR workflow also validates its own fresh
base/head pair, test harness, immutable fixture and GitNexus changes.
