# Mounted contracts OTS integration

This suite mounts the production AdminContracts component under the production ProtectedRoute, with the common useRequestScope helper. React, MemoryRouter, Radix components and Sonner run in a real Chromium browser. Authentication, database rows and verification responses are synthetic ports; all external browser requests are blocked.

Run from the repository root after installing its pinned npm dependencies and a Playwright Chromium browser:

    npm run test:contracts-ots:browser

To use an existing Chrome installation, set PLAYWRIGHT_EXECUTABLE_PATH. CONTRACTS_OTS_BROWSER_EVIDENCE selects the directory for results.json; CI uses its temporary directory. The runner also accepts a repository root as its first argument.

The seven independent scenarios cover:

- a current verified proof and its displayed block;
- a legitimate pending response;
- an HTTP error that must never be displayed as pending;
- a late result after an account change, with a positive verification for the new account;
- a late result after a different contract is selected;
- a session read that finishes after the account changes, before any verification request;
- an A-B-A account cycle that must not revive the first lifetime's response.

Each run records source hashes before and after, browser and Node versions, external requests, uncaught page errors and individual outcomes. A successful exit requires all seven checks, unchanged sources, no external request and no page error.

CONTRACTS_OTS_ADMIN_SOURCE is reserved for a negative control against an explicitly selected historical AdminContracts file. Its absolute path and actual hash are recorded; it must be unset for qualification and CI. The production sources are never rewritten by the runner.

This suite is separate from the account-isolation suite and the OTS handler AST tests. It does not qualify deployed RLS, provider credentials, Bitcoin confirmation or a production backend.
