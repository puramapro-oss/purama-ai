# IAO interface contract — OPTION B

IAO is the product identity above KARTA, not a second engine. KARTA remains the sole lifecycle and execution owner. SMARANA remains the sole memory authority through the injected `SmaranaIaoPort`; this integration creates no store, queue, scheduler, worker or daemon.

`POST /iao/requests` (with `/pura/requests` as an incoming compatibility alias) accepts only `type`, `requestId`, `conversationId`, `prompt`, and the type-specific `memoryControl`. Tenant and actor come only from the server authenticator. Unknown fields, unknown types, oversized bodies/prompts, missing identity and mismatched identity fail closed. `GET /iao/requests/:id` is scoped to the authenticated tenant and actor.

Conversation execution is request-scoped: SMARANA supplies an authorized context pack and durable UUID receipt, then the injected local Compute Fabric returns a bounded strict response. KARTA derives an opaque idempotency key from tenant, actor and request identity and sends it as `idempotency_key`, alongside a `payload_digest` covering the request type, conversation and prompt. Any configured Compute Fabric completion port must durably deduplicate that stable key across retries and process restarts, return the prior result only when the digest matches, and reject a conflicting digest; a provider without those guarantees must not be configured. The receipt becomes KARTA evidence only after both stages succeed. Provider timeout, malformed response, missing receipt, conflict, or dependency throw becomes a generic blocked response.

Every SMARANA context or control operation receives an opaque idempotency key scoped by tenant, actor and request identity, plus a canonical payload digest. A configured SMARANA port must atomically deduplicate that stable key across retries and process restarts, return the prior receipt only when the digest matches, and reject a conflicting digest before any effect. An accepted action requires a strict allowlisted durable UUID receipt matching its KARTA proof; unknown fields, non-boolean replay markers and failed or malformed receipts fail closed. The facade deduplicates concurrent and sequential requests; a conflicting replay fails closed. SMARANA must atomically consume export delivery and withhold content on a durable replay. Export content is bounded, delivered once and never retained by the facade; KARTA rejects any replayed receipt that still carries export content. Terminal verified/blocked states are immutable.

No provider, database, migration, secret, remote service or SMARANA concrete implementation is configured by this local integration. Without an explicitly injected runtime the IAO routes return `503`.

## Revision 2 — interruption, effect knowledge and leases (2026-10-12)

Additive to revision 1; every revision-1 response shape remains valid.

`POST /iao/requests/:id/cancel` is scoped to the authenticated tenant and actor and is idempotent: a terminal request (`verified`, `blocked`, `cancelled`) is returned unchanged; a pending one becomes `cancelled`, a new terminal status. Cancellation aborts the `AbortSignal` KARTA hands to every SMARANA and Compute Fabric call. Because `submit` dispatches immediately, a cancelled request is reported with `effect: "uncertain"`: KARTA cannot know whether the provider or SMARANA completed the work. A late result never changes the terminal status; it only refines `effect` — `executed` when a KARTA proof (and, for controls, its durable receipt) arrives, `none` when the port confirms the interruption happened before any effect. A late export receipt is recorded without its content: the facade still never retains export content, so a cancelled export forfeits that one-shot delivery and its replay returns `replayed: true` with no content.

Timeouts share the same controller: when a stage exceeds the bound, KARTA aborts the ports and returns a generic blocked response carrying `effect` — `none` when only the SMARANA context build (a read with a durable receipt) was interrupted, `uncertain` once a completion or a memory control was in flight. An already-aborted signal is rejected before any dispatch. Ports accept an optional `signal`; a port that ignores it still terminates by the KARTA bound, only with less precise effect knowledge.

Every response carries `updatedAt` (ISO 8601) refreshed on each transition, so a poller can tell a live request from a stalled one. The facade holds requests under a lease: terminal requests expire `retentionMs` (default 15 min) after settling and the facade keeps at most `maxRequests` (default 10 000) entries, evicting the oldest terminal ones first; a pending request is never evicted. After eviction `GET` answers `404` and a resubmission with the same identity redispatches, which the SMARANA and Compute Fabric idempotency keys turn into a replay rather than a second effect. There is no streaming: `POST` answers `202` once the request is settled or `503` when blocked, and a client that disconnects mid-request loses nothing, since the settled state stays readable through `GET` until the lease expires.

## Revision 3 — session gate (2026-11-12)

Additive to revisions 1 and 2. Response bodies are unchanged. This revision does not create an issuer, a tenant directory, or a module-open policy decision point.

Before `POST /iao/requests`, `POST /pura/requests`, `GET /iao/requests/:id`, and `POST /iao/requests/:id/cancel`, KARTA rechecks the authenticator result. A missing runtime still returns `503` and does not call the authenticator. Any other failure of this recheck returns `401` with `IAO authentication required`. The authenticator remains responsible for validating the credential and its current revocation.

The recheck accepts the result only when all of the following hold:

- `tenantId` and `actorId` are non-empty strings.
- `session.tenantId` equals `tenantId`, and `session.userId` equals `actorId`.
- `session.appSlug` is exactly `purama-ai`. A ONE launch offer is not an IAO session.
- `session.sessionId` is a canonical UUID: eight, four, four, four, then twelve hex digits, with version nibble 1 through 5 and RFC 4122 variant nibble 8, 9, a, or b. Nil and non-canonical forms are rejected.
- `session.issuedAt` and `session.expiresAt` are finite numbers, `issuedAt` is not in the future, `expiresAt` is still ahead, and `expiresAt - issuedAt` is at most 15 minutes.

KARTA freezes that tenant, actor, and session before reading the body or dispatching. IAO responses on these routes set `Cache-Control: no-store`. Routes that are not IAO routes keep their existing cache header and are not authenticated by this gate.

This revision is implemented on `codex/t03-iao-local-transport-20261014`. It is not present on pull request 45. No ONE authority is designated to issue these sessions.

## Revision 4 — final admission and bounded context (2026-11-24)

For either submission path, authentication is checked twice: before reading the body and again immediately before `facade.submit`, after the final dependency probe. Both checks, the body read and the probes share the original 15-second monotonic admission deadline; reauthentication does not restart that budget. The final identity must retain the original tenant, actor and session ID, and the originally bound session must still be unexpired. Revocation, identity substitution, an expired admission deadline or a disconnected/shutting-down route prevents new dispatch. Lookup and cancellation retain one authentication check. This adds one call to the existing authority for an admitted submission; it creates no issuer and is not a guarantee against revocation after work has already been admitted.

The local Compute Fabric prompt still accepts only authorized memory sources of sensitivity `normal`, in relevance order and under the existing text budget. The full context pack is validated before filtering or truncation. When eligible text must be shortened or omitted, the prompt includes a fixed notice that its memory context is partial. Excluded sources do not affect this notice. Both memory excerpts and the user request are JSON payloads whose opening delimiter character is escaped, so embedded source text cannot form the outer section delimiters. Truncation does not split a complete UTF-16 surrogate pair. The budget remains a text-character budget, not an exact tokenizer or complete-envelope limit. These structural guarantees do not establish model answer quality or general resistance to instruction injection.

An accepted final KARTA receipt also closes a superseded request internally. Its public response remains `partial` with `stale: true`, without exposing its proof as a current verified answer. The existing completion timestamp starts its retention lease. Later callbacks and cancellation leave that completed response unchanged and cannot renew its lease or deliver an export again. A still-running port remains protected from eviction until it drains; an unfinished partial response without a final receipt remains open. No new public status, memory store or authority is introduced.

The production composition requirements of revisions 1–3 remain unchanged: an existing authenticated session authority, a qualified durable SMARANA port and the strict local Compute Fabric RPC/2 port must be supplied. The default CLI is not activated by these corrections, and an absent runtime continues to return `503`.

## Revision 5 — unique eligible memory excerpts (2026-11-24)

After validating the entire context pack, filtering authorization and sensitivity, and ranking by relevance, the local Compute Fabric prompt includes each exactly equal complete text only once. The highest-ranked eligible occurrence retains its position. Only this prompt projection is deduplicated: SMARANA sources, receipts, stored history and the user request remain unchanged. Whitespace, case, Unicode normalization and overlapping but different text remain distinct.

The existing character budget therefore covers distinct eligible text rather than repeated copies. A shortened or omitted distinct excerpt still triggers the partial-context notice; removing only an exact repetition does not. Every source is validated before this selection, including malformed, excluded or repeated records. Existing UTF-16 boundaries, data delimiters, cancellation, transport bounds and local-only execution policy remain intact. This change makes no claim about real-model answer quality, latency or billing, and does not activate the absent production ports described above.
