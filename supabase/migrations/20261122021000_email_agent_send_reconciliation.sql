-- Reconcile provider evidence without ever granting a new send attempt.
-- The server is the only caller; user input is not a provider receipt.
BEGIN;

ALTER TABLE purama_ai.email_agent_dispatches
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciliation_proof JSONB;

CREATE OR REPLACE FUNCTION purama_ai.email_agent_reconcile_context(
  p_user_id UUID, p_log_id UUID
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  cfg purama_ai.email_agent_config;
  item purama_ai.email_agent_logs;
  dispatch purama_ai.email_agent_dispatches;
  matches BOOLEAN;
  eligible BOOLEAN;
  reason TEXT;
BEGIN
  IF p_user_id IS NULL OR p_log_id IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','invalid_identity','eligible',false);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('email-agent-send:' || p_user_id::TEXT,0));
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  SELECT * INTO item FROM purama_ai.email_agent_logs WHERE id=p_log_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','blocked','reason','log_not_found','eligible',false);
  END IF;
  SELECT * INTO dispatch FROM purama_ai.email_agent_dispatches
    WHERE user_id=p_user_id AND gmail_message_id=item.gmail_message_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','blocked','reason','no_dispatch_to_reconcile','eligible',false);
  END IF;
  matches := coalesce(purama_ai.email_agent_send_payload(item)=dispatch.payload-'gmail_email'
    AND cfg.gmail_email=dispatch.payload->>'gmail_email',false);
  eligible := dispatch.status='unknown' OR (dispatch.status='sending'
    AND dispatch.dispatch_started_at < clock_timestamp()-interval '2 minutes');
  reason := CASE WHEN dispatch.status='sent' THEN NULL ELSE 'dispatch_not_reconcilable' END;
  IF eligible THEN
    IF dispatch.dispatch_started_at IS NULL OR nullif(dispatch.payload->>'gmail_email','') IS NULL THEN
      eligible:=false; reason:='historical_connection_unverified';
    ELSIF cfg.id IS NULL OR cfg.gmail_email IS DISTINCT FROM dispatch.payload->>'gmail_email' THEN
      eligible:=false; reason:='gmail_connection_changed';
    ELSE reason:=NULL;
    END IF;
  END IF;
  RETURN jsonb_build_object('status',dispatch.status,'reason',reason,'action_id',dispatch.id,
    'eligible',eligible,'matches_current_preview',matches,
    'provider_message_id',dispatch.provider_message_id,
    'payload',CASE WHEN eligible THEN dispatch.payload ELSE NULL END,
    'dispatch_updated_at',dispatch.updated_at,'dispatch_started_at',dispatch.dispatch_started_at);
END
$$;

CREATE OR REPLACE FUNCTION purama_ai.email_agent_reconcile_finish(
  p_user_id UUID, p_action_id UUID, p_dispatch_updated_at TIMESTAMPTZ,
  p_connection_email TEXT, p_connection_updated_at TIMESTAMPTZ,
  p_provider_message_id TEXT, p_raw_sha256 TEXT, p_provider_internal_date_ms BIGINT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  cfg purama_ai.email_agent_config;
  item purama_ai.email_agent_logs;
  dispatch purama_ai.email_agent_dispatches;
  log_key UUID;
  matches BOOLEAN;
BEGIN
  IF p_user_id IS NULL OR p_action_id IS NULL OR p_dispatch_updated_at IS NULL
    OR p_provider_message_id IS NULL OR p_provider_message_id !~ '^[A-Za-z0-9_-]{1,512}$'
    OR p_raw_sha256 IS NULL OR p_raw_sha256 !~ '^[0-9a-f]{64}$'
    OR p_provider_internal_date_ms IS NULL OR p_provider_internal_date_ms<=0 THEN
    RETURN jsonb_build_object('status','blocked','reason','invalid_provider_evidence');
  END IF;
  -- Same owner lock and config -> log -> ledger order as reserve/begin/finish.
  PERFORM pg_advisory_xact_lock(hashtextextended('email-agent-send:' || p_user_id::TEXT,0));
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  SELECT log_id INTO log_key FROM purama_ai.email_agent_dispatches WHERE id=p_action_id AND user_id=p_user_id;
  SELECT * INTO item FROM purama_ai.email_agent_logs WHERE id=log_key AND user_id=p_user_id FOR UPDATE;
  SELECT * INTO dispatch FROM purama_ai.email_agent_dispatches WHERE id=p_action_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','dispatch_not_found'); END IF;
  matches:=coalesce(item.id IS NOT NULL AND purama_ai.email_agent_send_payload(item)=dispatch.payload-'gmail_email'
    AND cfg.gmail_email=dispatch.payload->>'gmail_email',false);
  IF dispatch.status='sent' THEN
    RETURN purama_ai.email_agent_send_result(dispatch)||jsonb_build_object('matches_current_preview',matches);
  END IF;
  IF dispatch.updated_at IS DISTINCT FROM p_dispatch_updated_at THEN
    RETURN jsonb_build_object('status',dispatch.status,'reason','dispatch_changed','action_id',dispatch.id);
  END IF;
  IF dispatch.status NOT IN ('unknown','sending') OR dispatch.dispatch_started_at IS NULL
    OR (dispatch.status='sending' AND dispatch.dispatch_started_at>=clock_timestamp()-interval '2 minutes') THEN
    RETURN jsonb_build_object('status',dispatch.status,'reason','dispatch_not_reconcilable','action_id',dispatch.id);
  END IF;
  IF cfg.id IS NULL OR cfg.gmail_email IS DISTINCT FROM p_connection_email
    OR cfg.updated_at IS DISTINCT FROM p_connection_updated_at
    OR dispatch.payload->>'gmail_email' IS DISTINCT FROM p_connection_email THEN
    RETURN jsonb_build_object('status',dispatch.status,'reason','gmail_connection_changed','action_id',dispatch.id);
  END IF;
  IF dispatch.provider_message_id IS NOT NULL AND dispatch.provider_message_id<>p_provider_message_id THEN
    RETURN jsonb_build_object('status',dispatch.status,'reason','provider_receipt_changed','action_id',dispatch.id);
  END IF;
  IF dispatch.provider_message_id IS NULL AND p_provider_internal_date_ms
    < floor(extract(epoch FROM dispatch.dispatch_started_at)*1000)-5000 THEN
    RETURN jsonb_build_object('status',dispatch.status,'reason','provider_evidence_predates_dispatch','action_id',dispatch.id);
  END IF;
  IF p_provider_internal_date_ms > floor(extract(epoch FROM clock_timestamp())*1000)+300000 THEN
    RETURN jsonb_build_object('status',dispatch.status,'reason','provider_evidence_in_future','action_id',dispatch.id);
  END IF;
  IF EXISTS(SELECT 1 FROM purama_ai.email_agent_dispatches
    WHERE user_id=p_user_id AND id<>p_action_id AND provider_message_id=p_provider_message_id) THEN
    RETURN jsonb_build_object('status',dispatch.status,'reason','provider_receipt_already_used','action_id',dispatch.id);
  END IF;
  UPDATE purama_ai.email_agent_dispatches SET status='sent',provider_message_id=p_provider_message_id,
    reason=NULL,reconciled_at=clock_timestamp(),updated_at=clock_timestamp(),
    reconciliation_proof=jsonb_build_object('source','gmail_messages_get','evidence','message_marked_sent',
      'provider_message_id',p_provider_message_id,'raw_sha256',p_raw_sha256,
      'internal_date_ms',p_provider_internal_date_ms,'matched_snapshot',true,
      'known_receipt',dispatch.provider_message_id IS NOT NULL)
    WHERE id=p_action_id RETURNING * INTO dispatch;
  -- Preserve a later edit/revocation. Only the exact original log is updated.
  IF matches THEN
    UPDATE purama_ai.email_agent_logs SET action_taken='auto_reply'
      WHERE id=dispatch.log_id AND user_id=p_user_id AND gmail_message_id=dispatch.gmail_message_id;
  END IF;
  UPDATE purama_ai.email_agent_config SET total_auto_replied=coalesce(total_auto_replied,0)+1 WHERE user_id=p_user_id;
  RETURN purama_ai.email_agent_send_result(dispatch)||jsonb_build_object('matches_current_preview',matches);
END
$$;

REVOKE ALL ON FUNCTION purama_ai.email_agent_reconcile_context(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.email_agent_reconcile_finish(UUID,UUID,TIMESTAMPTZ,TEXT,TIMESTAMPTZ,TEXT,TEXT,BIGINT)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.email_agent_reconcile_context(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.email_agent_reconcile_finish(UUID,UUID,TIMESTAMPTZ,TEXT,TIMESTAMPTZ,TEXT,TEXT,BIGINT)
  TO service_role;

COMMIT;
