-- KARTA hardening: atomic daily counters + monotonic last-run state.
BEGIN;

CREATE TABLE IF NOT EXISTS purama_ai.karta_daily_counters (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  counter_key text NOT NULL,
  counter_day date NOT NULL,
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, counter_key, counter_day)
);

ALTER TABLE purama_ai.karta_daily_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.karta_daily_counters FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON purama_ai.karta_daily_counters TO service_role;

CREATE OR REPLACE FUNCTION purama_ai.karta_reserve_daily_counter(
  p_user_id uuid,
  p_counter_key text,
  p_day date,
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_counter_key IS NULL OR btrim(p_counter_key) = '' OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'Invalid counter reservation';
  END IF;

  INSERT INTO purama_ai.karta_daily_counters(user_id, counter_key, counter_day, count)
  VALUES (p_user_id, p_counter_key, p_day, 1)
  ON CONFLICT (user_id, counter_key, counter_day)
  DO UPDATE SET
    count = purama_ai.karta_daily_counters.count + 1,
    updated_at = now()
  WHERE purama_ai.karta_daily_counters.count < p_limit
  RETURNING count INTO v_count;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.karta_reserve_daily_counter(uuid,text,date,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.karta_reserve_daily_counter(uuid,text,date,integer)
  TO service_role;

CREATE OR REPLACE FUNCTION purama_ai.karta_record_run_outcome(
  p_user_id uuid,
  p_agent_type text,
  p_status text,
  p_started_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_started_at IS NULL OR p_status IS NULL THEN
    RAISE EXCEPTION 'Invalid run outcome';
  END IF;

  UPDATE purama_ai.karta_agent_state
  SET
    last_run_at = p_started_at,
    last_run_status = p_status,
    updated_at = now()
  WHERE user_id = p_user_id
    AND agent_type = p_agent_type
    AND (last_run_at IS NULL OR last_run_at <= p_started_at);

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.karta_record_run_outcome(uuid,text,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.karta_record_run_outcome(uuid,text,text,timestamptz)
  TO service_role;

COMMIT;
