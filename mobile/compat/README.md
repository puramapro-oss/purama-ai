# Compatibility adapters for the Expo 54 dependency graph

The application uses Expo 54, React 19.1 and React Native 0.81. The versions in
`package.json` follow Expo 54.0.38's published `bundledNativeModules.json`.
These adapters preserve interfaces used by the SDK and restrict unsafe config
data before merging. Their own names and versions identify
local Purama adapters; they do not claim to be upstream releases.

| Consumer | Required interface | Implementation |
| --- | --- | --- |
| `query-string` 7, through Expo Router 6 | `require('decode-uri-component')` returns a function | `decode-uri-component` 0.5.1, imported through an explicit npm alias |
| Metro 0.83 `src/Assets.js` | synchronous function accepting a Buffer or file path | `image-size` 2.0.3, imported through an explicit npm alias |
| `@expo/config` 12.0.14 config mutation | callable CommonJS merge function and `.all` | local input guard delegating to unchanged `deepmerge` 4.3.1 through an explicit npm alias |
| Expo config, Metro and glob consumers | modern Glob API and bounded Minimatch constructor | guarded `glob/raw` 14.0.6 and `minimatch` 11.0.9 aliases; legacy Glob 7 / Minimatch 3 consumers remain separate |

The decoder adapter only returns the upstream default export. It contains no
decoder implementation and does not catch or replace upstream errors. A direct
override to the upstream ESM package would change the CommonJS export shape
expected by `query-string` 7. Replacing `query-string` with its latest major
would also change the named exports used by Expo Router 6.

The image adapter reads at most 512 KiB from a file, closes the descriptor in a
`finally` block, and passes the header to the patched upstream parser. Buffer
input is passed directly to upstream. This preserves the synchronous interface
used by Metro, without retaining any old image parser. It does not implement
the old package's unrelated asynchronous callback API.

The config merge guard rejects enumerable own `__proto__` keys recursively in
both merge inputs, including arrays and plugin properties. It rejects enumerable
accessors without invoking them, so a getter cannot substitute unsafe data after
validation. It then delegates ordinary merges, array behavior and options to
the actual upstream implementation. This fixes the reproduced returned-object
prototype poisoning in Expo's `modifyConfigAsync` for inert configuration data;
it does not patch upstream `deepmerge` or remove its advisory. Executable options,
callbacks and proxies are trusted code, not a sandboxed input format. Cyclic data
and arbitrary dynamic-config execution are outside this guard's guarantee.

The root file dependencies make the local packages available to Node and
Metro. Scoped overrides replace only the consumers above, using references
to those root dependencies. `npm ci`, `npm ls --all`
and tests that resolve from the real consumer modules protect this layout.
Do not copy generated `node_modules` links or edit lockfile integrity fields.
The upstream aliases remain visible to `npm audit`.

The scoped PostCSS 8.5.32 override applies to `@expo/metro-config`; it retains
PostCSS's major version while correcting source-map path handling. Sharp is
updated to a patched release for the existing icon-generation script.
The Babel preset referenced by the existing configuration is declared directly
at version 54.0.12, matching Expo 54.0.38; relying on transitive hoisting failed
the first real Metro export.

## Verification and maintenance

Run from `mobile` with Node 24 and the lockfile resolver npm 11.9.0. The
2026-11-24 local qualification used Node 24.22.3; the preceding CI used
24.22.1. No global npm installation was changed.

```sh
npm ci --no-audit --no-fund
npm ls --all
npm run test:dependencies
npm run test:audit-snapshot
node --test tests/audit-ci-live.test.cjs
npm run check:dependencies
npm run typecheck
npm run export:android
npm run export:ios
npm run verify:audit-snapshot
npm exec --yes --package=expo-doctor@1.21.6 -- expo-doctor
```

The regression tests exercise the real installed Router serializer and Metro
asset loader, export shapes and errors, bounded file reads, malformed percent
decoding, invalid ICNS blocks, and PostCSS source-map traversal. The isolated
parser probes have their own time limit so that a parser hang fails the test.
The mobile CI executes these gates independently of the web application.

### Audit snapshot binding

The fresh-snapshot path is named **audit snapshot binding — no registry request**.
It reads the received report in `qa/dependency-audit`, verifies its
exact SHA-256, and compares the full multiset of registry package names,
versions, tarball URLs and integrity values. Duplicate instances are retained;
npm aliases use their real upstream names. A change of installation position,
such as hoisting the same Babel preset, does not change this identity. Unknown
non-registry dependencies are refused; the five explicit local adapters are
reviewed separately.

The renewed registry multiset contains exactly 885 instances with SHA-256
`ef84dc12007e30407846c8a10e10d5cfdf4efe82221e2e5074b549633e930e83`.
This comparison does not cover dependency topology or local adapter code. The
adapter resolution, rejected attack, benign Expo/plugin mutations and upstream
identity have separate regression tests. Admitting the reviewed local package
is not an advisory exemption; its upstream alias remains visible to npm audit.

The gate requires zero high and critical entries in that report and refuses
invalid, future or expired dates. Its validity is strictly less than 24 hours.
It is a local reuse of dated evidence, not a new audit. The actual registry
audit completed at **2026-11-23 23:46:28.691 UTC** and reported zero entries
in every severity category. The report SHA-256 is
`4d0bac41e0a63520bbf55fca7aaa52e88e305183e32775b139ee2312bbc7d919`.
That result describes this response and dependency graph at that time; it is
not a claim that all installed code is free of vulnerabilities.

The CI qualifier can perform a fresh registry audit only when explicitly
enabled and when an authentic recorded report for the same graph has expired.
A changed graph, altered report, unsafe report or failed registry request is
refused. A fresh valid snapshot makes no registry request. This repair changes
the graph, so its renewal used a separately authorized real audit and recorded
the actual report, completion time and graph identity. The old snapshot was
also checked against the new graph and correctly refused it.

```sh
npm audit --audit-level=high --json
```

Renewal must record the actual new report, timestamp and dependency identity;
changing only the timestamp would not establish a new audit.

The new snapshot expires at **2026-11-24 23:46:28.691 UTC**. The resolver,
lockfile/report hashes and actual audit completion are recorded in
`qa/dependency-audit/capture.json`. See the
[current dependency qualification](../../docs/quality/mobile-dependency-upgrade-20261124.json)
and [scoped glob explanation](glob/README.md). The
[2026-11-12 consumer qualification](../../docs/dependency-reachability-2026-11-12.md)
remains historical evidence and includes a separate site/Elliptic scope that
this mobile repair does not requalify.

During an SDK upgrade, re-check all consumers before removing or changing the
adapters. Prefer native upstream support when it preserves the required
interfaces and passes the same tests. Do not apply a forced major override or
change the advisory regression assertions to accommodate an incompatible
replacement.

Metro exports qualify JavaScript and asset bundling for both platforms. They
do not qualify a native build, a device session, signing, store submission,
notifications, or real backend authentication. The iOS identifier is a
syntactically valid candidate (`dev.purama.purama-ai`); no existing Apple
registration has been verified. Android identity and the URL scheme are
unchanged. The deployment scripts remain outside this CI and are not executed
by this qualification.

## Primary references

- [Expo SDK 54](https://expo.dev/changelog/sdk-54)
- [Expo SDK upgrade procedure](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/)
- [Decoder advisory](https://github.com/advisories/GHSA-qr28-fpjm-wq7f)
- [Image parser advisory](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
- [PostCSS source-map advisory](https://github.com/advisories/GHSA-r28c-9q8g-f849)
- [Sharp advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)
- [Deepmerge returned-object prototype advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
- [Glob AbortSignal cancellation advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)
- [Minimatch amplification advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- [npm overrides and local dependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
