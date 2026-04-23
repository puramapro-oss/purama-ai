-- CRONs for contracts lifecycle — pg_cron + pg_net (HTTP calls to edge functions).
-- Daily 09:00 UTC: reminders J+3, J+7, auto-cancel J+14.
-- Hourly: OTS upgrade attempts for pending proofs.

-- ─── Auto-cancel contracts with 'sent' status > 14 days ──────────────
CREATE OR REPLACE FUNCTION purama_ai.cron_auto_cancel_stale_contracts()
RETURNS INT AS $$
DECLARE
    v_count INT := 0;
BEGIN
    WITH to_cancel AS (
        SELECT id FROM purama_ai.contracts
         WHERE status IN ('sent', 'opened')
           AND sent_at < now() - INTERVAL '14 days'
    )
    UPDATE purama_ai.contracts c
       SET status = 'cancelled', cancelled_at = now()
      FROM to_cancel
     WHERE c.id = to_cancel.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    INSERT INTO purama_ai.contract_events (contract_id, event_type, payload, actor_type)
    SELECT id, 'cancelled', jsonb_build_object('reason', 'auto_cancel_j14'), 'cron'
      FROM purama_ai.contracts
     WHERE status = 'cancelled' AND cancelled_at > now() - INTERVAL '1 minute';

    RETURN v_count;
END $$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── Mark contracts pending > 3 days for reminder (used by weekly_report) ──
CREATE OR REPLACE FUNCTION purama_ai.cron_reminder_stale_contracts()
RETURNS INT AS $$
DECLARE
    v_count INT := 0;
BEGIN
    -- Log reminder events (actual email send is handled by edge function via HTTP trigger)
    INSERT INTO purama_ai.contract_events (contract_id, event_type, payload, actor_type)
    SELECT c.id, 'reminded', jsonb_build_object(
              'day_offset', EXTRACT(DAY FROM now() - c.sent_at)::INT,
              'scheduled_by', 'cron'
           ), 'cron'
      FROM purama_ai.contracts c
     WHERE c.status = 'sent'
       AND c.sent_at < now() - INTERVAL '3 days'
       AND c.sent_at >= now() - INTERVAL '14 days'
       AND NOT EXISTS (
           SELECT 1 FROM purama_ai.contract_events e
            WHERE e.contract_id = c.id AND e.event_type = 'reminded'
              AND e.created_at > now() - INTERVAL '4 days'
       );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END $$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── Weekly admin report (Monday 09:00) ──────────────────────────────
CREATE OR REPLACE FUNCTION purama_ai.cron_weekly_contracts_report()
RETURNS JSONB AS $$
DECLARE
    v_report JSONB;
BEGIN
    SELECT jsonb_build_object(
        'period_start', (now() - INTERVAL '7 days')::date,
        'period_end', now()::date,
        'created', COUNT(*) FILTER (WHERE c.created_at > now() - INTERVAL '7 days'),
        'signed',  COUNT(*) FILTER (WHERE c.signed_at > now() - INTERVAL '7 days'),
        'cancelled', COUNT(*) FILTER (WHERE c.cancelled_at > now() - INTERVAL '7 days'),
        'pending', COUNT(*) FILTER (WHERE c.status IN ('sent', 'opened')),
        'by_template', (
            SELECT jsonb_object_agg(template_slug, cnt)
              FROM (SELECT template_slug, COUNT(*) AS cnt
                      FROM purama_ai.contracts
                     WHERE created_at > now() - INTERVAL '7 days'
                     GROUP BY template_slug) t
        )
    ) INTO v_report
      FROM purama_ai.contracts c;
    RETURN v_report;
END $$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── Schedule CRONs via pg_cron ──────────────────────────────────────
SELECT cron.unschedule('contracts-auto-cancel') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='contracts-auto-cancel');
SELECT cron.unschedule('contracts-reminders') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='contracts-reminders');
SELECT cron.unschedule('contracts-weekly-report') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='contracts-weekly-report');

-- Daily 09:00 UTC
SELECT cron.schedule('contracts-auto-cancel', '0 9 * * *',
    $$SELECT purama_ai.cron_auto_cancel_stale_contracts()$$);

SELECT cron.schedule('contracts-reminders', '0 9 * * *',
    $$SELECT purama_ai.cron_reminder_stale_contracts()$$);

-- Monday 09:00 UTC
SELECT cron.schedule('contracts-weekly-report', '0 9 * * 1',
    $$SELECT purama_ai.cron_weekly_contracts_report()$$);

-- Verify
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'contracts-%' ORDER BY jobname;
