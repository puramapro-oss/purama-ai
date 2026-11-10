> Qualification historique du donneur PR33 `90d8f303`. Ses seuils et résultats ne qualifient pas la composition actuelle. Celle-ci conserve la persistance atomique preuve/audit de PR36, 64 000 octets de métadonnées, 16 MiB de PDF, un budget de 10 secondes et HTTP 504 à échéance. Ses preuves sont consignées séparément.

# Reconciliation of PR36 into the PR33 candidate

This integration starts at PR33 `a11b2d8298c5cd7f8ed8be3427a1c6b676310e3f`
and merges PR36 `cb5accbeac30bf43872c0a7a19233a619faed4ca`. Their common
ancestor is `58a85a9f7ae0c20abc37158ea0901243e0bf2acd`. Historical reports
under `qa/full-reconciliation-20261110` describe the donor's qualification;
they are not test results for this combined tree.

## Resolved contracts

- The PR33 voice/chat/creator request scopes retain cancellation, duplicate
  request exclusion, owner checks, edit preservation and autoplay identity.
  PR36 account-scoping changes in the other hooks and pages are retained.
  The Creator missing-response fixture expects PR33's existing explicit message
  `Impossible de charger cet agent.`; its alert, loading completion, retry and
  successful recovery assertions remain. The donor's `introuvable` wording was
  incompatible with the retained component and is not a new product behavior.
- The wellbeing dialog retains the local Escape fallback, the already-prevented
  event guard and the nested-dialog guard. No shared Radix primitive changes.
- Stamping uses the PR36 user RLS client and explicit `public.has_role` with
  a strictly boolean administrator result. Identity and authority are rechecked
  after provider work and before persistence. Full snapshot comparisons and
  conditional writes remain in place.
- Incoming limits remain 4 KiB for stamp requests, 64 KiB for the webhook and
  a five-second total body-read budget. A missing/invalid bearer without a
  syntactically valid HMAC is rejected before acquiring the request body.
  A cryptographically valid HMAC alone remains an admitted webhook credential.
- The webhook retains the PR33 checked database writes and the awaited OTS
  delivery with its existing 15-second bound. A failed or timed-out stamp is
  retryable and cannot become an HTTP success. Empty signer sets return 409.
  This does not make database writes/audits atomic or add a durable job queue.
- PR36 signed-PDF admission is intentionally stricter: only the exact configured
  HTTPS DocuSeal origin is fetched. Foreign storage and lookalike origins receive
  neither requests nor credentials. Supporting another storage authority needs
  an explicit deployment contract.
- Updated failure statuses are deliberate: contract-read errors use 503;
  missing signed submission uses 409; missing/refused PDF and calendar failures
  use 502. Proof/audit write failures retain their existing error outcomes.
  Response and log messages do not expose private provider errors.

## Transport correction

The incoming OTS and signed-PDF readers used an abort timer without bounding
the awaited transport promises. A shared portable deadline now races fetch and
body reads, checks monotonic elapsed time before and after awaits and before
successful returns, and cancels abandoned bodies without awaiting cancellation.
Late fetch responses are also cancelled. URL, status and byte-limit policies
are unchanged. The deadline tests use controlled clocks and inert transports;
their clock simulations are not measurements of external provider latency.

The limits are **10 seconds per OTS HTTP request** and **15 seconds shared by
signed-PDF metadata and document retrieval**. `verifyDigest` can make up to
12 requests; no ten-second global verification guarantee is claimed.

## Test preservation and discovery

`test:contracts-auth` retains its 24 admission, 62 integrity and 17 content
cases. `test:contracts-security` retains the 124 authorization, 15 content,
5 webhook-security, 30 body-reader and 21 delivery cases, and includes the
21 incoming DocuSeal GET and 21 new OTS/PDF deadline regressions. The content
and integrity suites intentionally overlap older coverage: these execution
counts must not be described as distinct business scenarios.

`test:contracts-native` executes all five historical native files (54 cases),
using the actual portable core and locked upstream proof primitives with only
the provider ports replaced. `test:contracts-ots` retains the incoming 42
native admission/body/webhook cases, 24 Node primitive/client cases and three
native production-bridge cases. Both native gates deny real network access.

The public Playwright selection remains the eight explicit public files.
The quality configuration collects its 49 historical cases plus the 29
commerce cases once. Founder, account isolation and contract browser fixtures
remain separate commands (16, 25 and seven cases). Existing async UI, mobile
auth, UI state, voice, wellbeing and chat commands remain available. Browser
fixtures use synthetic identities and local transports; they do not qualify
live authentication, real payments, signing providers or a production rollout.

Standalone incoming fixtures block service workers, external HTTP and WebSocket
connections and non-read requests to the local fixture server. Their Chromium
resolver is restricted to loopback. Founder evidence can be placed outside the
checkout with `FOUNDER_DASHBOARD_EVIDENCE`; the other fixtures retain their
existing evidence-path options.

Final qualification must bind every gate to this candidate's complete source
manifest and include raw logs, exit codes and before/after fingerprints. Local
merge commits or inherited reports alone do not establish a passing gate.
