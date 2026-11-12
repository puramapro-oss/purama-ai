# Scoped Expo glob guard

Glob 13.0.7's default entry bundles its own Minimatch. Overriding the external
package alone therefore does not protect Expo's glob calls. This adapter uses
the same tarball's supported `glob/raw` entry, with the bounded constructor in
`../glob-minimatch`. CJS, ESM, `glob/raw` and the upstream function aliases share
that implementation. Legacy Glob 7 / Minimatch 3 and Expo CLI's Minimatch 9 are
not replaced.

The constructor bounds `**/..` expansion by `braceExpandMax` (100,000 when not
provided) and one million newly retained path cells. A rejected push has already
allocated one temporary row. Above 1,000 alternatives, the optional quadratic
deduplication pass is skipped without discarding any matching alternative.
Exceeding a limit throws; it never returns a partial match. These bounds follow
the upstream fixes for [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249),
including [the first bound and deduplication cutoff](https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8)
and [the cumulative-cell bound](https://github.com/isaacs/minimatch/commit/73f0e1b1abcb97edf97b7c7a4b9132a141496338).

This is a guard for the constructor reached by the tested Expo consumers, not a
complete backport of Minimatch 11. Functional helpers exported by Minimatch and
explicit `*-upstream` imports are unchanged. They must not be used for untrusted
patterns with optimization level 2. The original package versions and advisory
remain present. The dated audit report and its 24-hour expiry are unchanged;
the snapshot only binds registry package identities, versions, URLs and bytes.
Local code and actual resolution paths are qualified by the consumer tests.
