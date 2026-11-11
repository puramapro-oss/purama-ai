# Compatibility adapters for the Expo 54 dependency graph

The application uses Expo 54, React 19.1 and React Native 0.81. The versions in
`package.json` follow Expo 54.0.38's published `bundledNativeModules.json`.
These adapters preserve two interfaces used by the SDK while delegating all
parsing to patched upstream packages. Their own names and versions identify
local Purama adapters; they do not claim to be upstream releases.

| Consumer | Required interface | Patched implementation |
| --- | --- | --- |
| `query-string` 7, through Expo Router 6 | `require('decode-uri-component')` returns a function | `decode-uri-component` 0.5.1, imported through an explicit npm alias |
| Metro 0.83 `src/Assets.js` | synchronous function accepting a Buffer or file path | `image-size` 2.0.3, imported through an explicit npm alias |

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

The root file dependencies make the local packages available to Node and
Metro. Scoped overrides replace only the two consumers above, using references
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

Run from `mobile` with Node 24.22.1:

```sh
npm ci --no-audit --no-fund
npm ls --all
npm run test:dependencies
npm run test:audit-snapshot
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

The automated gate is named **audit snapshot binding — no registry request**.
It reads the previously received report in `qa/dependency-audit`, verifies its
exact SHA-256, and compares the full multiset of registry package names,
versions, tarball URLs and integrity values. Duplicate instances are retained;
npm aliases use their real upstream names. A change of installation position,
such as hoisting the same Babel preset, does not change this identity. Unknown
non-registry dependencies are refused; the two explicit local adapters are
reviewed separately.

The gate requires zero high and critical entries in that report and refuses
invalid, future or expired dates. Its validity is strictly less than 24 hours.
It is a local reuse of dated evidence, not a new audit. The received report
still contains three unique advisories concerning deepmerge, glob and
minimatch, represented by sixteen affected package entries. Their risk is not
declared absent. No automatic major update outside the SDK ranges is applied.

An automatic approval review blocked a subsequent registry audit request.
The workflow therefore makes no `npm audit` request and has no ignored audit
failure. A changed or expired snapshot fails the job and requires an authorized
renewal. The standard command remains available for an explicitly authorized
registry audit:

```sh
npm audit --audit-level=high --json
```

Renewal must record the actual new report, timestamp and dependency identity;
changing only the timestamp would not establish a new audit.

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
- [npm overrides and local dependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
