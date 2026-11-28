-- Deploy only after draining every previous email-agent-send-draft instance.
-- This ledger protects the manual draft endpoint, not other email producers.
-- An abandoned/ambiguous attempt is NEVER reclaimed automatically.
BEGIN;

CREATE TABLE IF NOT EXISTS purama_ai.email_agent_send_policy (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  legacy_backfill_completed BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO purama_ai.email_agent_send_policy(singleton) VALUES (true)
  ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS purama_ai.email_agent_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  -- No FK to mutable logs: deleting/reimporting a log must not erase history.
  log_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing','sending','sent','failed','unknown','blocked')),
  reason TEXT,
  claim_token UUID,
  lease_until TIMESTAMPTZ,
  payload JSONB NOT NULL,
  provider_message_id TEXT,
  dispatch_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, gmail_message_id),
  CHECK (status <> 'sent' OR nullif(btrim(provider_message_id), '') IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS email_agent_dispatches_log
  ON purama_ai.email_agent_dispatches(user_id,log_id);

ALTER TABLE purama_ai.email_agent_send_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.email_agent_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.email_agent_send_policy, purama_ai.email_agent_dispatches
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON purama_ai.email_agent_send_policy, purama_ai.email_agent_dispatches TO service_role;

CREATE OR REPLACE FUNCTION purama_ai.email_agent_send_payload(p_log purama_ai.email_agent_logs)
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, purama_ai AS $$
  SELECT jsonb_build_object(
    'gmail_message_id', p_log.gmail_message_id,
    'gmail_thread_id', p_log.gmail_thread_id,
    'gmail_draft_id', p_log.gmail_draft_id,
    'recipient', p_log.from_email,
    'subject', coalesce(nullif(p_log.ai_subject,''), 'Re: ' || coalesce(p_log.subject,'')),
    'body', p_log.ai_response
  )
$$;

CREATE OR REPLACE FUNCTION purama_ai.email_agent_send_result(
  p_dispatch purama_ai.email_agent_dispatches, p_claimed BOOLEAN DEFAULT false
) RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, purama_ai AS $$
  SELECT jsonb_build_object('action_id',p_dispatch.id,'status',p_dispatch.status,
    'reason',p_dispatch.reason,'claimed',p_claimed,
    'provider_message_id',p_dispatch.provider_message_id,
    'payload',CASE WHEN p_claimed THEN p_dispatch.payload ELSE NULL END)
$$;

-- The old endpoint could send before persisting any approval/status. NULL approval
-- is therefore not evidence of no prior send. Reconcile these rows with Gmail;
-- do not turn a new approval or a log delete/reimport into a retry permission.
INSERT INTO purama_ai.email_agent_dispatches
  (user_id,gmail_message_id,log_id,status,reason,payload)
SELECT l.user_id,l.gmail_message_id,l.id,'unknown','historical_outcome_unverified',
  purama_ai.email_agent_send_payload(l)
FROM purama_ai.email_agent_logs l
CROSS JOIN purama_ai.email_agent_send_policy p
WHERE p.legacy_backfill_completed IS false AND l.action_taken IN ('draft','auto_reply')
ON CONFLICT (user_id,gmail_message_id) DO NOTHING;
-- Capture all pre-existing drafts even if their client-writable created_at is
-- in the future. Subsequent migration runs must not quarantine new drafts.
UPDATE purama_ai.email_agent_send_policy SET legacy_backfill_completed=true
  WHERE singleton AND legacy_backfill_completed IS false;

CREATE OR REPLACE FUNCTION purama_ai.email_agent_send_reserve(
  p_user_id UUID, p_log_id UUID, p_claim_token UUID
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  cfg purama_ai.email_agent_config;
  item purama_ai.email_agent_logs;
  dispatch purama_ai.email_agent_dispatches;
  cutoff TIMESTAMPTZ;
BEGIN
  IF p_user_id IS NULL OR p_log_id IS NULL OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','invalid_identity','claimed',false);
  END IF;
  -- All three RPCs serialize by owner, then lock config -> log -> ledger.
  PERFORM pg_advisory_xact_lock(hashtextextended('email-agent-send:' || p_user_id::TEXT,0));
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  SELECT * INTO item FROM purama_ai.email_agent_logs WHERE id=p_log_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','blocked','reason','log_not_found','claimed',false);
  END IF;
  SELECT * INTO dispatch FROM purama_ai.email_agent_dispatches
    WHERE user_id=p_user_id AND gmail_message_id=item.gmail_message_id FOR UPDATE;
  IF FOUND THEN
    -- No lease takeover, no failed/unknown reset, even after deletion/reimport.
    RETURN purama_ai.email_agent_send_result(dispatch);
  END IF;
  SELECT installed_at INTO cutoff FROM purama_ai.email_agent_send_policy WHERE singleton;
  IF cutoff IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','policy_missing','claimed',false);
  END IF;
  IF item.created_at IS NULL OR item.created_at <= cutoff THEN
    INSERT INTO purama_ai.email_agent_dispatches
      (user_id,gmail_message_id,log_id,status,reason,payload)
      VALUES(p_user_id,item.gmail_message_id,item.id,'unknown','historical_outcome_unverified',
        purama_ai.email_agent_send_payload(item)) RETURNING * INTO dispatch;
    RETURN purama_ai.email_agent_send_result(dispatch);
  END IF;
  IF item.action_taken <> 'draft' OR item.user_approved IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('status','blocked','reason','approval_required','claimed',false);
  END IF;
  IF cfg.id IS NULL OR nullif(btrim(cfg.gmail_email),'') IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','gmail_not_connected','claimed',false);
  END IF;
  INSERT INTO purama_ai.email_agent_dispatches
    (user_id,gmail_message_id,log_id,status,claim_token,lease_until,payload)
    VALUES(p_user_id,item.gmail_message_id,item.id,'preparing',p_claim_token,
      clock_timestamp()+interval '2 minutes',
      purama_ai.email_agent_send_payload(item) || jsonb_build_object('gmail_email',cfg.gmail_email))
    RETURNING * INTO dispatch;
  RETURN purama_ai.email_agent_send_result(dispatch,true);
END
$$;

CREATE OR REPLACE FUNCTION purama_ai.email_agent_send_begin(
  p_user_id UUID, p_action_id UUID, p_claim_token UUID,
  p_connection_email TEXT, p_connection_updated_at TIMESTAMPTZ
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  cfg purama_ai.email_agent_config;
  item purama_ai.email_agent_logs;
  dispatch purama_ai.email_agent_dispatches;
  log_key UUID;
  invalid_reason TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('email-agent-send:' || p_user_id::TEXT,0));
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  SELECT log_id INTO log_key FROM purama_ai.email_agent_dispatches WHERE id=p_action_id AND user_id=p_user_id;
  SELECT * INTO item FROM purama_ai.email_agent_logs WHERE id=log_key AND user_id=p_user_id FOR UPDATE;
  SELECT * INTO dispatch FROM purama_ai.email_agent_dispatches WHERE id=p_action_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','blocked','reason','dispatch_not_found','claimed',false);
  END IF;
  IF dispatch.claim_token IS DISTINCT FROM p_claim_token OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','claim_mismatch','claimed',false);
  END IF;
  IF dispatch.status <> 'preparing' THEN RETURN purama_ai.email_agent_send_result(dispatch); END IF;
  IF dispatch.lease_until IS NULL OR dispatch.lease_until <= clock_timestamp() THEN
    invalid_reason := 'claim_expired';
  ELSIF item.id IS NULL OR item.user_approved IS DISTINCT FROM true OR item.action_taken <> 'draft' THEN
    invalid_reason := 'approval_or_log_changed';
  ELSIF purama_ai.email_agent_send_payload(item) IS DISTINCT FROM (dispatch.payload-'gmail_email') THEN
    invalid_reason := 'approved_payload_changed';
  ELSIF cfg.id IS NULL OR nullif(btrim(cfg.gmail_email),'') IS NULL
    OR cfg.gmail_email IS DISTINCT FROM (dispatch.payload->>'gmail_email')
    OR cfg.gmail_email IS DISTINCT FROM p_connection_email
    OR p_connection_updated_at IS NULL OR cfg.updated_at IS DISTINCT FROM p_connection_updated_at THEN
    invalid_reason := 'gmail_connection_changed';
  ELSIF EXISTS (SELECT 1 FROM unnest(coalesce(cfg.excluded_emails,'{}'::TEXT[])) e
    WHERE lower(btrim(e))=lower(btrim(item.from_email)))
    OR EXISTS (SELECT 1 FROM unnest(coalesce(cfg.excluded_domains,'{}'::TEXT[])) d
      WHERE lower(btrim(d))=lower(split_part(item.from_email,'@',2)))
    OR EXISTS (SELECT 1 FROM purama_ai.email_agent_memory m WHERE m.user_id=p_user_id
      AND lower(btrim(m.contact_email))=lower(btrim(item.from_email)) AND m.is_blocked IS true) THEN
    invalid_reason := 'recipient_blocked';
  END IF;
  IF invalid_reason IS NOT NULL THEN
    UPDATE purama_ai.email_agent_dispatches SET status='blocked',reason=invalid_reason,
      updated_at=clock_timestamp() WHERE id=dispatch.id RETURNING * INTO dispatch;
    RETURN purama_ai.email_agent_send_result(dispatch);
  END IF;
  UPDATE purama_ai.email_agent_dispatches SET status='sending',dispatch_started_at=clock_timestamp(),
    updated_at=clock_timestamp() WHERE id=dispatch.id RETURNING * INTO dispatch;
  RETURN purama_ai.email_agent_send_result(dispatch,true);
END
$$;

CREATE OR REPLACE FUNCTION purama_ai.email_agent_send_finish(
  p_user_id UUID, p_action_id UUID, p_claim_token UUID,
  p_outcome TEXT, p_provider_message_id TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  dispatch purama_ai.email_agent_dispatches;
  log_key UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('email-agent-send:' || p_user_id::TEXT,0));
  PERFORM 1 FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  SELECT log_id INTO log_key FROM purama_ai.email_agent_dispatches WHERE id=p_action_id AND user_id=p_user_id;
  PERFORM 1 FROM purama_ai.email_agent_logs WHERE id=log_key AND user_id=p_user_id FOR UPDATE;
  SELECT * INTO dispatch FROM purama_ai.email_agent_dispatches WHERE id=p_action_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','blocked','reason','dispatch_not_found','claimed',false);
  END IF;
  IF dispatch.claim_token IS DISTINCT FROM p_claim_token OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','claim_mismatch','claimed',false);
  END IF;
  -- In particular, an uncertain completion after a lost COMMIT acknowledgement
  -- must not downgrade a durable sent result or increment the counter twice.
  IF dispatch.status NOT IN ('preparing','sending') THEN
    RETURN purama_ai.email_agent_send_result(dispatch);
  END IF;
  IF p_outcome NOT IN ('sent','failed','unknown') OR p_outcome IS NULL THEN
    RAISE EXCEPTION 'Invalid email dispatch outcome';
  END IF;
  IF p_outcome='sent' AND (dispatch.status <> 'sending'
    OR dispatch.dispatch_started_at IS NULL OR nullif(btrim(p_provider_message_id),'') IS NULL
    OR length(p_provider_message_id)>512 OR p_provider_message_id ~ '[[:space:][:cntrl:]]') THEN
    RAISE EXCEPTION 'A sent dispatch requires a provider receipt after begin';
  END IF;
  IF p_outcome='unknown' AND dispatch.status <> 'sending' THEN
    RAISE EXCEPTION 'An unknown dispatch requires a send attempt';
  END IF;
  IF p_provider_message_id IS NOT NULL AND (nullif(btrim(p_provider_message_id),'') IS NULL
    OR length(p_provider_message_id)>512 OR p_provider_message_id ~ '[[:space:][:cntrl:]]') THEN
    RAISE EXCEPTION 'Invalid provider receipt';
  END IF;
  UPDATE purama_ai.email_agent_dispatches SET status=p_outcome,
    -- A known receipt can survive an unsuccessful sent transaction for manual
    -- reconciliation, while status unknown still prohibits retry and success UI.
    provider_message_id=CASE WHEN p_outcome IN ('sent','unknown') THEN p_provider_message_id ELSE NULL END,
    reason=CASE WHEN p_outcome='sent' THEN NULL WHEN p_outcome='unknown' THEN 'provider_outcome_unverified'
      WHEN dispatch.dispatch_started_at IS NULL THEN 'preparation_failed' ELSE 'provider_rejected' END,
    updated_at=clock_timestamp() WHERE id=dispatch.id RETURNING * INTO dispatch;
  IF p_outcome='sent' THEN
    UPDATE purama_ai.email_agent_logs SET action_taken='auto_reply',user_approved=true,feedback_at=clock_timestamp()
      WHERE id=dispatch.log_id AND user_id=p_user_id AND gmail_message_id=dispatch.gmail_message_id;
    UPDATE purama_ai.email_agent_config SET total_auto_replied=coalesce(total_auto_replied,0)+1
      WHERE user_id=p_user_id;
  END IF;
  RETURN purama_ai.email_agent_send_result(dispatch);
END
$$;

REVOKE ALL ON FUNCTION purama_ai.email_agent_send_payload(purama_ai.email_agent_logs) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.email_agent_send_result(purama_ai.email_agent_dispatches,BOOLEAN) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.email_agent_send_reserve(UUID,UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.email_agent_send_begin(UUID,UUID,UUID,TEXT,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.email_agent_send_finish(UUID,UUID,UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.email_agent_send_reserve(UUID,UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.email_agent_send_begin(UUID,UUID,UUID,TEXT,TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.email_agent_send_finish(UUID,UUID,UUID,TEXT,TEXT) TO service_role;

COMMIT;
