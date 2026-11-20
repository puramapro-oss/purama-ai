# Dependency consumer qualification — 2026-11-12

Baseline: `b170fcb647f8f70851ee918bff795de3a45b0328` (common PR45 branch).
This document records bounded consumer evidence. It is not a new npm audit,
an advisory suppression list, or a claim that every installed package is safe.

| Advisory and installed dependency | Reachable consumer | Qualification and remaining limit |
| --- | --- | --- |
| [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84), LOW, Elliptic 6.6.1 | site: OpenTimestamps 0.4.9 → bitcore-lib 8.25.47 | The affected operation is ECDSA signing. The actual contract proof wrappers stamp hashes, parse proofs and compare Merkle roots. A regression tripwire forbids `EC.prototype.sign` while these operations execute. No signing occurs in the tested contract proof paths; the advisory remains applicable to the installed library. No patched upstream version was published at review time. |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), MODERATE, mobile minimatch 9.0.9/10.2.6 | `@expo/fingerprint` defaults; glob 13.0.7 build tooling | Fingerprint's real path helpers use the default optimization level; a tripwire confirms they do not enter the vulnerable level-two preprocessing. Glob forces level two and bundles its own matcher. Its default and raw exports both expand a bounded six-segment adversarial pattern to 64 alternatives. Overriding only external minimatch leaves the bundled path vulnerable. This remains unresolved in this candidate. |
| [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), LOW, mobile deepmerge 4.3.1 | `@expo/config` 12.0.14 `modifyConfigAsync` | A temporary app config containing an own `__proto__` property makes the original consumer return an object with an inherited synthetic marker. The scoped local guard now refuses that input, nested input and plugin properties before upstream merging. Benign config/plugin merges retain their behavior. Ordinary `getConfig` does not call the merger. The upstream package remains vulnerable and visible in the dated report. |

The site test is in `tests/opentimestamps-content.mjs`; mobile consumer tests
are in `mobile/tests/dependency-compat.test.cjs`. The cryptographic tripwire
includes a positive control, pending proof validation, altered content,
malformed proof refusal and a real Bitcoin attestation Merkle comparison.
Calendar HTTP responses use test fixtures; production calendar availability and
live Bitcoin confirmation are not established by this test.

Android and iOS Metro exports were inspected with a read-only module-load trace
and source maps. The tested exports load Expo config and glob, but call no glob
API and load neither deepmerge nor minimatch separately. Those four build
packages are absent from both client source maps. This bounds the tested export
path only: native execution, future commands, arbitrary plugins and attacker
access to build patterns are not qualified.

A separate experiment with glob 14.0.6 and minimatch 11.0.8 fixes the bounded
amplification probe while preserving legacy glob 7/minimatch 3 consumers. Its
registry multiset changes, so the existing audit snapshot refuses it. It is not
included here or represented as an audited upgrade. There is no compatible
patched 9.x/10.x release in the registry metadata retrieved for this review;
the advisory identifies 11.0.1 as the first patched version.

The local deepmerge guard is covered by separate source review and consumer
tests. Its alias retains the exact upstream version, tarball URL and integrity.
The existing snapshot comparison checks only the full registry package
multiset, including duplicate instances; it does not assess topology or local
code. The report, capture receipt, advisory entries and validity dates are
unchanged. It expires **2026-11-13 03:59:42.234 UTC** and requires an authorized
real renewal. An expired or changed snapshot continues to fail closed.
