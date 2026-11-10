# Mobile authentication regression harness

These tests mount the actual mobile `AuthProvider` and `useAuth` in React with controlled Supabase promises. Expo linking, the browser launcher, React Native's platform value and transport are local mocks. No real identity provider, database, email, payment or external network call is permitted.

Run from the repository root with existing root dependencies:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium \
  node node_modules/@playwright/test/cli.js test --config tests/mobile-auth/playwright.config.ts
node node_modules/typescript/bin/tsc -p tests/mobile-auth/tsconfig.json
```

Vite owns port 4199 and a private cache under this directory. The config runner avoids temporary config bundles under `node_modules/.vite-temp`, and the explicit cache avoids a shared `node_modules/.vite` directory. `MOBILE_AUTH_RESULTS` optionally selects the JSON evidence output path.

The scenarios control the order of startup snapshots, auth events, profile requests, refreshes, sign-out completion and unmount. The lock fixture holds the auth callback's lock until its return value settles; profile results cannot complete while that lock is held. This reproduces the documented Supabase deadlock when a listener awaits profile work.

This qualifies provider logic using the repository's existing React browser runtime. It does not qualify an Expo/React Native build, native storage, iOS/Android, OAuth redirects or the mobile package's separate React runtime.

Primary reference: https://supabase.com/kb/troubleshooting/why-is-my-supabase-api-call-not-returning-PGzXw0
