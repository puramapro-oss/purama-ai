-- KARTA tool-safety hardening: atomic Gmail quota + incremental Gmail cursor.
BEGIN;

ALTER TABLE purama_ai.email_agent_config
  ADD COLUMN IF NOT EXISTS gmail_history_id text;

CREATE TABLE IF NOT EXISTS purama_ai.karta_gmail_daily_usage (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  usage_day date NOT NULL,
  reserved_count integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, usage_day)
);

ALTER TABLE purama_ai.karta_gmail_daily_usage ENABLE ROW LEVEL SECURITY;
-- No client policy: this counter is a server-side safety invariant and must not
-- be reset by the same user whose sends it limits.

CREATE OR REPLACE FUNCTION purama_ai.karta_reserve_gmail_send(
  p_user_id uuid,
  p_limit integer DEFAULT 400
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE next_count integer;
BEGIN
  IF p_user_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'INVALID_GMAIL_QUOTA_REQUEST';
  END IF;

  INSERT INTO purama_ai.karta_gmail_daily_usage(user_id, usage_day, reserved_count)
  VALUES (p_user_id, CURRENT_DATE, 1)
  ON CONFLICT (user_id, usage_day) DO UPDATE
    SET reserved_count = purama_ai.karta_gmail_daily_usage.reserved_count + 1,
        updated_at = now()
    WHERE purama_ai.karta_gmail_daily_usage.reserved_count < p_limit
  RETURNING reserved_count INTO next_count;

  IF next_count IS NULL THEN
    RAISE EXCEPTION 'GMAIL_DAILY_LIMIT_REACHED';
  END IF;
  RETURN next_count;
END;
$$;

REVOKE ALL ON TABLE purama_ai.karta_gmail_daily_usage FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.karta_reserve_gmail_send(uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE purama_ai.karta_gmail_daily_usage TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.karta_reserve_gmail_send(uuid,integer) TO service_role;

COMMIT;
