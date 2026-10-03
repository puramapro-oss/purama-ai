# Social callback OAuth hardening — blocked implementation plan

`social-callback` currently trusts `platform` and `user_id` query parameters embedded in the callback
URL passed to Zernio. That permits account reassignment if the callback URL is forged. The endpoint
must not be changed until Zernio's callback contract is verified to preserve an opaque `state` value
or arbitrary callback query parameters unchanged.

## Required compatible design

1. Confirm in Zernio's authoritative API documentation or a staging capture that the exact callback
   URL, including an opaque `state` query parameter, is returned unchanged after provider OAuth.
2. Add a `purama_ai.social_oauth_states` table containing only `nonce_hash`, `user_id`, `platform`,
   `expires_at`, and `consumed_at`; enable RLS and grant no client access.
3. In authenticated `social-connect`, create a random 256-bit nonce, store only its SHA-256 hash with
   a maximum lifetime of ten minutes, and sign claims containing issuer, audience, authenticated user
   id, allowlisted platform, nonce, issued-at, and expiry with a dedicated
   `SOCIAL_OAUTH_STATE_SECRET` of at least 32 characters.
4. Put only the signed state in the callback URL. Do not put `user_id` or trust a callback-supplied
   platform.
5. In `social-callback`, verify signature, issuer, audience, expiry, platform allowlist, and claim
   types; atomically consume the matching unused nonce before any account write. Reject replay,
   missing configuration, invalid state, and expired state before creating a service-role client.
6. Derive `social_accounts.user_id` and `platform` exclusively from the verified claims. Validate all
   Zernio identifiers and bound their lengths before upsert.
7. Add tests for tampering, expiry, replay, wrong audience, wrong platform, missing secret, and a
   successful one-time callback. Then perform one staging OAuth round trip before production rollout.

Until step 1 is proven, `social-callback` remains a deployment blocker and must not be exposed as a
trusted production OAuth callback.
