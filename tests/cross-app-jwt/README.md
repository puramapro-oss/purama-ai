# Cross-app JWT contract regression tests

These tests execute the application's real JWT helpers with synthetic identities,
local HMAC keys and the real Web Crypto implementation. They make no provider,
database or HTTP requests. Node transpiles only the two helper modules and their
schema; it uses the installed Zod module. Deno imports and type-checks the real
Edge TypeScript directly, with network and process execution explicitly denied.

## Commands

```sh
npm run test:cross-app-jwt
npm run test:cross-app-jwt:deno
```

The first command uses the repository's Node dependencies and runs in the existing
site CI job. The second requires Deno on `PATH`; it is an explicit native-runtime
gate and downloads no modules. No environment file is loaded. The Deno fixture
sets only its three allowed DocuSeal environment names to synthetic values before
importing the helper. A private `DENO_DIR` can be supplied for isolated caching.

## Existing application contract

Both verifiers require the declared algorithm to be `HS256`, matching the HMAC
operation. The existing payload contract requires the audience
`purama-contracts-hub`, non-blank string `iss` and `app_slug`, finite numeric `iat`
and `exp`, and a string `jti` when supplied. String values are preserved; validation
does not trim or rewrite the verified identity.

The existing 30-second clock tolerance remains inclusive at its boundaries.
Fractional NumericDate values remain valid. The tests preserve key rotation, an
optional `typ` header, optional `jti`, an issuer distinct from the application slug,
and a configurable validity duration. They impose no issuer allowlist, issuer/slug
equality, new maximum lifetime or change to the signer.

These application claims are required by `CrossAppJwtPayload`; they are not
described as mandatory in every JWT protocol. See
[RFC 7519, NumericDate and registered claims](https://www.rfc-editor.org/rfc/rfc7519.html)
and [RFC 8725 §3.1, algorithm verification](https://www.rfc-editor.org/rfc/rfc8725.html#section-3.1).

## Coverage and counting

`cases.mjs` contains 48 shared token scenarios. Node runs them against both the
Edge and SDK verifiers, then runs two real SDK signer roundtrips: 98 executions.
Deno runs the same 48 Edge cases and a permissions check: 49 executions. Runtime
repetitions are not additional distinct functional scenarios.

Negative fixtures are deliberately HMAC-signed, including malformed claims and
misleading header labels. The former acceptance defects therefore demonstrate
insufficient validation of signed service tokens, not arbitrary unsigned forgery.
Fixture creation happens outside the expected-rejection handler so a signing or
fixture error cannot pass a rejection test. A fixed clock makes both sides of the
30-second boundary deterministic.

This suite does not qualify provider integration, the full `contracts-create`
handler, deployment, rate limits, issuer admission or the storage of signing keys.
