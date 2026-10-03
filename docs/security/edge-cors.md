# Edge Function CORS policy

Browser access to Edge Functions is denied by default. Configure the exact production frontend
origin as an Edge Function secret:

```bash
supabase secrets set CORS_ALLOWED_ORIGIN='https://purama-ai.purama.dev'
```

The value must be one serialized origin: scheme, host, and optional port, with no path. Do not use
`*`. An unset value or `*` produces an empty `Access-Control-Allow-Origin`, so browsers cannot read
responses. This fail-closed default also applies to sensitive payment, notification, scheduler, and
webhook endpoints; server-to-server calls do not require CORS.

The Google OAuth Edge Function uses a request-aware allowlist instead. Configure its comma-separated
origins separately:

```bash
supabase secrets set OAUTH_ALLOWED_ORIGINS='https://purama-ai.purama.dev,https://purama.dev'
```

Origins not present in that list receive no usable allow-origin value. Preflight requests remain
implemented by each browser-facing handler. None of these policies enables credentialed wildcard
CORS; authorization and CSRF controls remain independently required.
