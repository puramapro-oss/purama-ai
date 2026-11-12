# Social Autopilot — Deployment

## 1. Apply database migration

```bash
supabase db push
# or, on the VPS-hosted Postgres directly:
psql "$DATABASE_URL" -f supabase/migrations/20260406120000_social_autopilot.sql
```

## 2. Set edge function secrets

Provision `ZERNIO_API_KEY` and `ANTHROPIC_API_KEY` from the deployment
environment's secret store. Never put provider credentials in this guide,
tracked environment files, shell history, CI output, or logs.

For a Supabase-managed project, prepare a private environment file **outside
the repository**, with permissions `0600`. This is a template only; replace
the placeholders through the secret store or a local editor without printing
the values:

```dotenv
ZERNIO_API_KEY=REPLACE_WITH_SECRET_FROM_ZERNIO
ZERNIO_BASE_URL=https://zernio.com/api/v1
ANTHROPIC_API_KEY=REPLACE_WITH_SECRET_FROM_ANTHROPIC
APP_URL=https://agentiapuramafr.lovable.app
```

After confirming the linked Supabase project is the intended target:

```bash
set +x
# This variable contains a path only, never a credential.
SOCIAL_SECRETS_FILE='/absolute/path/outside-repository/social-autopilot.env'
chmod 600 "$SOCIAL_SECRETS_FILE"
supabase secrets set --env-file "$SOCIAL_SECRETS_FILE"
```

Do not provision the placeholder values. For self-hosted edge functions,
use the existing deployment secret mechanism instead of the managed-project
command above.

Any real credential previously committed must be treated as exposed.
Removing it from this guide does not invalidate it or erase Git history.
The credential owner must coordinate replacement in dependent environments
and revocation of the old key; do not reuse a previously published value.

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
