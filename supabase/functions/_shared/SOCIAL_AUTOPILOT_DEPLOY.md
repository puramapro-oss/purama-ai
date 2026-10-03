# Social Autopilot — Deployment

## 1. Apply database migration

```bash
supabase db push
# or, on the VPS-hosted Postgres directly:
psql "$DATABASE_URL" -f supabase/migrations/20260406120000_social_autopilot.sql
```

## 2. Set edge function secrets

```bash
supabase secrets set \
  ZERNIO_API_KEY='REPLACE_WITH_SECRET_FROM_PROVIDER' \
  ZERNIO_BASE_URL='https://zernio.com/api/v1' \
  ANTHROPIC_API_KEY='sk-ant-...' \
  APP_URL='https://agentiapuramafr.lovable.app'
```

`social-connect` and `social-callback` are intentionally disabled by default. Do not enable them
until a staging OAuth round trip proves that Zernio preserves the complete callback URL query string.
After that proof, generate a fresh random secret and configure both controls:

```bash
supabase secrets set \
  SOCIAL_CALLBACK_ENABLED='true' \
  SOCIAL_CALLBACK_SHARED_SECRET='REPLACE_WITH_RANDOM_32_PLUS_CHARACTER_SECRET'
```

Never put the secret in source control, screenshots, client environment variables, or support logs.

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are
auto-injected by the Supabase platform.

## 3. Deploy the 5 functions

```bash
supabase functions deploy social-connect
supabase functions deploy social-callback   # verify_jwt = false (config.toml)
supabase functions deploy social-accounts
supabase functions deploy social-publish
supabase functions deploy social-autopilot-config
```

## 4. Configure Zernio callback URL

In the Zernio dashboard add the following allowed callback host:

```
https://ksbshqxhutavsueawjrs.supabase.co/functions/v1/social-callback
```

## 5. Frontend route

The page is mounted at `/dashboard/social` (see `src/App.tsx`) and a
sidebar entry has been added in `DashboardLayout.tsx`.

## 6. Smoke test

1. Open `/dashboard/social`, click `Connecter` on YouTube → OAuth flow → ✅
2. Toggle `Autopilot` ON, then `Caption IA`.
3. Trigger any agent that imports `maybeAutopilot` from `@/lib/social`
   after generating content. The post is created in `social_posts` and
   the response from Zernio is stored in `zernio_response`.
4. The `PublishEverywhereButton` can also be added next to any agent
   output for manual one-click cross-posting.
