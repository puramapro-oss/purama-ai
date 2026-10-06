# IAO interface contract — OPTION B

IAO is the product identity above KARTA, not a second engine. KARTA remains the sole lifecycle and execution owner. SMARANA remains the sole memory authority through the injected `SmaranaIaoPort`; this integration creates no store, queue, scheduler, worker or daemon.

`POST /iao/requests` (with `/pura/requests` as an incoming compatibility alias) accepts only `type`, `requestId`, `conversationId`, `prompt`, and the type-specific `memoryControl`. Tenant and actor come only from the server authenticator. Unknown fields, unknown types, oversized bodies/prompts, missing identity and mismatched identity fail closed. `GET /iao/requests/:id` is scoped to the authenticated tenant and actor.

Conversation execution is request-scoped: SMARANA supplies an authorized context pack and durable UUID receipt, then the injected local Compute Fabric returns a bounded strict response. The receipt becomes KARTA evidence only after both stages succeed. Provider timeout, malformed response, missing receipt, or dependency throw becomes a generic blocked response.

Memory controls are delegated to SMARANA with the request id as idempotency key. An accepted action requires a durable UUID receipt matching its KARTA proof. The facade deduplicates concurrent and sequential requests; a conflicting replay fails closed. Export content is delivered once and never retained by the facade. Terminal verified/blocked states are immutable.

No provider, database, migration, secret, remote service or SMARANA concrete implementation is configured by this local integration. Without an explicitly injected runtime the IAO routes return `503`.
