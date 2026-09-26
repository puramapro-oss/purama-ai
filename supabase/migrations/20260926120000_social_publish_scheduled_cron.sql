-- Cron wiring for the social_posts scheduled-publish consumer.
--
-- Context: social-publish/index.ts inserts social_posts rows with
-- status='scheduled' when a user picks a future date, but nothing in this
-- project ever revisited those rows to actually publish them (the only
-- existing crons — contracts-auto-cancel/contracts-reminders/
-- contracts-weekly-report, see 20260423113000_contracts_crons.sql — are pure
-- SQL functions unrelated to social_posts). The new
-- supabase/functions/social-publish-scheduled edge function closes that gap:
-- it claims due rows atomically and performs the real publish via the same
-- Zernio logic as the immediate path.
--
-- Unlike the 3 existing crons, this consumer MUST run inside a Deno edge
-- function (it performs a real outbound HTTP call to Zernio via fetch),
-- not a plpgsql function callable directly by pg_cron. Reaching it from
-- pg_cron therefore requires pg_net (already installed by this project,
-- see 20260122233530_..., specifically "to enable ... HTTP calls to edge
-- functions" per the comment atop 20260423113000_contracts_crons.sql — this
-- migration is the first to actually exercise that intent).
--
-- IMPORTANT — one-time manual bootstrap required before this schedule can
-- succeed (not run by this migration, on purpose: secrets are never
-- committed to migrations per CLAUDE.md law 7):
--   1. Set the CRON_SECRET function secret for social-publish-scheduled
--      (same value as the CRON_SECRET env var used by the rest of the
--      ecosystem, see CLAUDE.md §5).
--   2. Register that same value in Supabase Vault so this SQL can read it:
--        select vault.create_secret('<CRON_SECRET value>', 'social_publish_cron_secret');
--   3. Requires the `vault` extension enabled (Supabase projects have it
--      available by default; not yet enabled in this repo's migrations —
--      enable via `create extension if not exists supabase_vault;` if
--      `vault.create_secret` errors with "schema vault does not exist").
-- Until step 2 is done, cron.schedule below will still run every 5 minutes
-- but net.http_post will send an empty/invalid Authorization header, and
-- social-publish-scheduled will reply 401 — it fails closed, it does not
-- silently skip auth.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.unschedule('social-publish-scheduled')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'social-publish-scheduled');

-- Every 5 minutes: ask social-publish-scheduled to claim + publish any
-- social_posts row whose scheduled_at is now due.
SELECT cron.schedule(
    'social-publish-scheduled',
    '*/5 * * * *',
    $$
    SELECT net.http_post(
        url := 'https://ylkkmvihffblfhsvabqa.supabase.co/functions/v1/social-publish-scheduled',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || COALESCE(
                (SELECT decrypted_secret FROM vault.decrypted_secrets
                  WHERE name = 'social_publish_cron_secret' LIMIT 1),
                ''
            )
        ),
        body := '{}'::jsonb
    ) AS request_id;
    $$
);

-- Verify
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'social-publish-scheduled';
