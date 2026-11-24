# Scoped Expo glob guard

Glob 14.0.6 and Minimatch 11.0.9 replace the vulnerable 13.0.7 / 10.2.6
upstream aliases. Glob's default entry bundles its own matcher, so the
qualification checks both the upstream entry and this adapter. The adapter
continues to use the supported `glob/raw` entry with the bounded constructor in
`../glob-minimatch`. CJS, ESM, `glob/raw` and the upstream function aliases share
that guarded implementation.

Expo CLI's separate Minimatch 9 requirement resolves to the patched registry
package 11.0.9. The test resolves it from the actual CLI consumer, checks a benign
match, and requires the same bounded adversarial pattern to throw. Legacy
Glob 7.2.3 / Minimatch 3.1.5 remain installed for `@react-native/codegen`,
`react-native`, `rimraf` and `test-exclude`. All four retain their callable
CommonJS interface and `makeRe` returning a RegExp.

The constructor bounds `**/..` expansion by `braceExpandMax` (100,000 when not
provided) and one million newly retained path cells. A rejected push has already
allocated one temporary row. Above 1,000 alternatives, the optional quadratic
deduplication pass is skipped without discarding any matching alternative.
Exceeding a limit throws; it never returns a partial match. These bounds follow
the upstream fixes for [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249),
including [the first bound and deduplication cutoff](https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8)
and [the cumulative-cell bound](https://github.com/isaacs/minimatch/commit/73f0e1b1abcb97edf97b7c7a4b9132a141496338).

The local guard is retained without changing its implementation. Functional
helpers and explicit `*-upstream` imports now use the patched upstream versions.
The upstream Glob counterproof requires the previously expanding pattern to
throw even without the local guard, with a benign pattern as a positive control.
The isolated memory/time limits, cancellation checks and Expo consumer probes
remain in the 19-test suite.

Minimatch 11 no longer exports modern `AST` or `makeRe`. The ESM adapter mirrors
the actual CommonJS/upstream namespace instead of exporting undefined names.
The 13 reviewed Expo/Metro JavaScript importer files contained no use of
either removed export. This does not remove legacy
Minimatch 3's `makeRe`, which is tested through its four real consumers.

The real registry audit completed on 2026-11-23 at 23:46:28.691 UTC with zero
reported entries for this graph. Its snapshot expires strictly 24 hours later;
it is dated registry evidence, not a guarantee that every dependency is safe.
The binding covers registry identities, versions, URLs and integrity values.
Local guard code, topology and actual resolution paths have separate tests.
See the [dated qualification](../../../docs/quality/mobile-dependency-upgrade-20261124.json)
for the checked scope and limitations.
