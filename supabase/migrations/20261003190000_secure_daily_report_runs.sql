-- Global idempotence/lease for the public-JWT-disabled daily-report Edge Function.
-- No user-facing policy: only service_role may claim or update a run.
CREATE TABLE IF NOT EXISTS purama_ai.daily_report_runs (
  report_date DATE PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  reports_sent INTEGER NOT NULL DEFAULT 0 CHECK (reports_sent >= 0),
  emails_sent INTEGER NOT NULL DEFAULT 0 CHECK (emails_sent >= 0)
);

ALTER TABLE purama_ai.daily_report_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.daily_report_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON purama_ai.daily_report_runs TO service_role;

CREATE OR REPLACE FUNCTION purama_ai.claim_daily_report_run(
  p_report_date DATE,
  p_lease_minutes INTEGER DEFAULT 30
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = purama_ai, pg_temp
AS $$
DECLARE
  claimed BOOLEAN;
  lease_minutes INTEGER := LEAST(GREATEST(COALESCE(p_lease_minutes, 30), 5), 120);
BEGIN
  INSERT INTO purama_ai.daily_report_runs (report_date, status, started_at, completed_at)
  VALUES (p_report_date, 'running', now(), NULL)
  ON CONFLICT (report_date) DO UPDATE
    SET status = 'running',
        started_at = now(),
        completed_at = NULL,
        reports_sent = 0,
        emails_sent = 0
    WHERE daily_report_runs.status IN ('failed', 'running')
      AND daily_report_runs.started_at < now() - make_interval(mins => lease_minutes)
  RETURNING TRUE INTO claimed;

  RETURN COALESCE(claimed, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.claim_daily_report_run(DATE, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.claim_daily_report_run(DATE, INTEGER) TO service_role;
