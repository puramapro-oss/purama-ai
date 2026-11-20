# KARTA — durable recovery and runtime lifecycle

This candidate extends `ca2f92b2887c711d152cbfd7e3615c3264a875a8` from PR36. It preserves the canonical execution fingerprints, authorization, trigger provenance, privacy and budget protocols. The older Mac candidate `fb7bf355` is a separate recovery archive; its migration numbers must not be applied to this lineage.

## Acceptance evidence

The machine-readable validation receipt and source manifest in this directory identify the exact tested files. Test counts are scoped: targeted tests overlap the full suite and must not be added to it. Native PostgreSQL checks are separate. An accepted queue job or a matching SQL run is not a claim of business success.

- Approval resolution and minimal continuation intent commit together. Restart, Redis failure or lost publication acknowledgement never requires repeating the approved effect.
- A leased relay uses the canonical identity and fingerprint. SQL receipts, stale leases, conflicting payloads, retained terminal jobs and missing evidence are distinguished. Historical resolved actions are not backfilled.
- Notification success requires actual channel receipts. Missing credentials, rejected responses, malformed receipts and partial delivery are visible. One ten-second budget covers response bodies and recipient lookup, with no late email after expiry.
- Configuration and read-only schema/Redis checks precede execution. `/live` reports process liveness; `/health` reports fresh dependency readiness. Authenticated emergency stops remain available during dependency outages; re-enabling execution requires readiness.
- Shutdown stops admission, waits for HTTP, scheduled work, relay and worker, then closes queue/Redis resources. An incomplete thirty-second drain returns failure. Core schedules reject late callbacks and clean up partial startup. The existing custom scheduler is preserved.

## Native defect and correction

`native-outbox-setof-lock-red.json` records a PostgreSQL table lock exceeding eight seconds despite a function-level two-second lock timeout. Resolving a table-row return type occurred before entering that function. Migration027 uses an explicit output record for outbox claims and a JSONB wrapper for pending-action claims. The original SETOF claim contract required by migration026 remains intact. `native-outbox-results.json` records the corrected behaviour with independent sessions and the `service_role` role, including relation locks and process restart.

The fixture creates a private PostgreSQL cluster with a Unix socket and no TCP listener, then stops and removes only that cluster. No production database, provider, email recipient or trading account is used.

## Reproduce

Use Node22, matching `karta/Dockerfile` and the existing CI job. From `karta/`:

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm run build
NODE_OPTIONS=--max-old-space-size=256 npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
```

The native fixture script documents its arguments and requires PostgreSQL18 binaries. Its JSON result includes its own SHA256 and the exact migration hashes. Notification and Redis transport failure tests use inert doubles; real Redis recovery and external delivery remain outside these receipts.

## Integration boundary

This is a reviewable candidate, not a production deployment. Before rollout, identify the actual running revision and applied migrations; stop and drain old workers and producers; apply canonical migration027 after026; refresh the PostgREST schema cache using the deployment's existing mechanism; verify `purama_ai.karta_approval_outbox_health()` with the service role; start the matching runtime and verify readiness and the existing jobs. Never run the old and new approval publishers together.

Keep blocked/ambiguous intents for reconciliation. A deliberate stop, unknown original trigger, failed business run or unconfirmed provider effect must not be reset to fabricate successful autonomous operation. Production availability, provider delivery, latency, cost and continuous 24/7 operation require production measurements and are not established by these tests.

Reference behaviour checked against the official [BullMQ connection guide](https://docs.bullmq.io/guide/connections), [shutdown guide](https://docs.bullmq.io/guide/workers/graceful-shutdown) and [PostgreSQL SELECT locking documentation](https://www.postgresql.org/docs/current/sql-select.html).
