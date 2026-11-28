-- Deploy before either OAuth handler. Old browser-created states deliberately
-- have no admission record and must restart authorization.
CREATE TABLE purama_ai.oauth_connection_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('google_connections', 'email_agent_gmail')),
  provider text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (
    (purpose = 'google_connections' AND provider IN ('google_sheets', 'gmail', 'google_calendar', 'google_drive'))
    OR (purpose = 'email_agent_gmail' AND provider = 'gmail')
  ),
  CHECK (expires_at > created_at)
);

CREATE INDEX oauth_connection_states_user_expiry
  ON purama_ai.oauth_connection_states(user_id, expires_at);

ALTER TABLE purama_ai.oauth_connection_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE purama_ai.oauth_connection_states FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE purama_ai.oauth_connection_states TO service_role;
CREATE POLICY oauth_connection_states_service
  ON purama_ai.oauth_connection_states FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE FUNCTION purama_ai.create_oauth_connection_state(
  p_state_hash text,
  p_user_id uuid,
  p_purpose text,
  p_provider text
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
  created timestamptz := pg_catalog.clock_timestamp();
  expires timestamptz := created + interval '10 minutes';
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$' OR p_user_id IS NULL
     OR p_purpose IS NULL OR p_provider IS NULL
     OR NOT (
       (p_purpose = 'google_connections' AND p_provider IN ('google_sheets', 'gmail', 'google_calendar', 'google_drive'))
       OR (p_purpose = 'email_agent_gmail' AND p_provider = 'gmail')
     ) THEN
    RAISE EXCEPTION 'Invalid OAuth state request' USING ERRCODE = '22023';
  END IF;

  -- Reclaim this actor's expired receipts when a fresh flow starts. No live
  -- state from another tab/provider is invalidated by this maintenance step.
  DELETE FROM purama_ai.oauth_connection_states AS s
  WHERE s.user_id = p_user_id AND s.expires_at <= created;

  INSERT INTO purama_ai.oauth_connection_states(state_hash, user_id, purpose, provider, created_at, expires_at)
  VALUES (p_state_hash, p_user_id, p_purpose, p_provider, created, expires);
  RETURN expires;
END;
$function$;

CREATE FUNCTION purama_ai.consume_oauth_connection_state(
  p_state_hash text,
  p_purpose text,
  p_actor_id uuid
) RETURNS TABLE(user_id uuid, provider text, return_path text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$'
     OR p_purpose IS NULL OR p_purpose NOT IN ('google_connections', 'email_agent_gmail')
     OR p_actor_id IS NULL THEN
    RETURN;
  END IF;

  -- UPDATE's row lock and predicate recheck admit only one concurrent caller.
  -- Both flows require the same verified human actor. The unauthenticated
  -- provider GET callback is only a relay to the browser, never an admission.
  RETURN QUERY
  UPDATE purama_ai.oauth_connection_states AS s
  SET consumed_at = pg_catalog.clock_timestamp()
  WHERE s.state_hash = p_state_hash AND s.purpose = p_purpose
    AND s.consumed_at IS NULL AND s.expires_at > pg_catalog.clock_timestamp()
    AND s.user_id = p_actor_id
  RETURNING s.user_id, s.provider,
    CASE s.purpose WHEN 'google_connections' THEN '/mes-connexions'::text
      ELSE '/dashboard/email-agent'::text END;
END;
$function$;

REVOKE ALL ON FUNCTION purama_ai.create_oauth_connection_state(text, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.consume_oauth_connection_state(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.create_oauth_connection_state(text, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.consume_oauth_connection_state(text, text, uuid) TO service_role;
