-- Coordinate with the preview-aware client and handler; drain older handlers.
-- An approval names an immutable server preview, never a mutable boolean alone.
BEGIN;

CREATE TABLE IF NOT EXISTS purama_ai.email_agent_draft_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  log_id UUID NOT NULL,
  payload JSONB NOT NULL,
  connection_updated_at TIMESTAMPTZ NOT NULL,
  observed_approval BOOLEAN,
  observed_feedback_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '10 minutes'),
  approved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS email_agent_draft_previews_owner_log
  ON purama_ai.email_agent_draft_previews(user_id,log_id);
ALTER TABLE purama_ai.email_agent_draft_previews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.email_agent_draft_previews FROM PUBLIC,anon,authenticated;
GRANT ALL ON purama_ai.email_agent_draft_previews TO service_role;
ALTER TABLE purama_ai.email_agent_dispatches ADD COLUMN IF NOT EXISTS approval_id UUID;

-- Retain the already-tested reservation and begin implementations privately.
-- No runtime role can call these helpers and bypass the new approval gate.
DO $$
BEGIN
  IF to_regprocedure('purama_ai.email_agent_send_reserve_unversioned_internal(uuid,uuid,uuid)') IS NULL THEN
    ALTER FUNCTION purama_ai.email_agent_send_reserve(UUID,UUID,UUID)
      RENAME TO email_agent_send_reserve_unversioned_internal;
  END IF;
  IF to_regprocedure('purama_ai.email_agent_send_begin_unversioned_internal(uuid,uuid,uuid,text,timestamp with time zone)') IS NULL THEN
    ALTER FUNCTION purama_ai.email_agent_send_begin(UUID,UUID,UUID,TEXT,TIMESTAMPTZ)
      RENAME TO email_agent_send_begin_unversioned_internal;
  END IF;
END $$;
REVOKE ALL ON FUNCTION purama_ai.email_agent_send_reserve_unversioned_internal(UUID,UUID,UUID)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION purama_ai.email_agent_send_begin_unversioned_internal(UUID,UUID,UUID,TEXT,TIMESTAMPTZ)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION purama_ai.email_agent_draft_preview(p_user_id UUID,p_log_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE
  cfg purama_ai.email_agent_config;
  item purama_ai.email_agent_logs;
  dispatch purama_ai.email_agent_dispatches;
  preview purama_ai.email_agent_draft_previews;
  snapshot JSONB;
BEGIN
  IF p_user_id IS NULL OR p_log_id IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','invalid_identity');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('email-agent-send:'||p_user_id::TEXT,0));
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  SELECT * INTO item FROM purama_ai.email_agent_logs WHERE id=p_log_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','log_not_found'); END IF;
  SELECT * INTO dispatch FROM purama_ai.email_agent_dispatches
    WHERE user_id=p_user_id AND gmail_message_id=item.gmail_message_id FOR UPDATE;
  IF FOUND THEN RETURN purama_ai.email_agent_send_result(dispatch); END IF;
  IF item.action_taken <> 'draft' OR item.user_approved IS FALSE THEN
    RETURN jsonb_build_object('status','blocked','reason','draft_not_pending');
  END IF;
  IF cfg.id IS NULL OR nullif(btrim(cfg.gmail_email),'') IS NULL OR cfg.updated_at IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','gmail_not_connected');
  END IF;
  snapshot := purama_ai.email_agent_send_payload(item)||jsonb_build_object('gmail_email',cfg.gmail_email);
  IF nullif(btrim(snapshot->>'body'),'') IS NULL OR length(snapshot->>'body')>1000000 THEN
    RETURN jsonb_build_object('status','blocked','reason','draft_content_unverified');
  END IF;
  -- Reopening the same unchanged preview does not create unbounded active copies.
  SELECT * INTO preview FROM purama_ai.email_agent_draft_previews
    WHERE user_id=p_user_id AND log_id=p_log_id AND approved_at IS NULL
      AND expires_at>clock_timestamp() AND payload=snapshot
      AND connection_updated_at=cfg.updated_at
      AND observed_approval IS NOT DISTINCT FROM item.user_approved
      AND observed_feedback_at IS NOT DISTINCT FROM item.feedback_at
    ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO purama_ai.email_agent_draft_previews
      (user_id,log_id,payload,connection_updated_at,observed_approval,observed_feedback_at)
      VALUES(p_user_id,p_log_id,snapshot,cfg.updated_at,item.user_approved,item.feedback_at)
      RETURNING * INTO preview;
  END IF;
  RETURN jsonb_build_object('status','ready','approval_id',preview.id,'user_id',p_user_id,
    'log_id',p_log_id,'expires_at',preview.expires_at,'payload',preview.payload);
END $$;

CREATE OR REPLACE FUNCTION purama_ai.email_agent_draft_approve(
  p_user_id UUID,p_log_id UUID,p_approval_id UUID,p_feedback TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE
  cfg purama_ai.email_agent_config;
  item purama_ai.email_agent_logs;
  preview purama_ai.email_agent_draft_previews;
  dispatch purama_ai.email_agent_dispatches;
  approved TIMESTAMPTZ;
BEGIN
  IF p_user_id IS NULL OR p_log_id IS NULL OR p_approval_id IS NULL OR length(p_feedback)>4000 THEN
    RETURN jsonb_build_object('status','blocked','reason','invalid_approval');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('email-agent-send:'||p_user_id::TEXT,0));
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  SELECT * INTO item FROM purama_ai.email_agent_logs WHERE id=p_log_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','log_not_found'); END IF;
  SELECT * INTO dispatch FROM purama_ai.email_agent_dispatches
    WHERE user_id=p_user_id AND gmail_message_id=item.gmail_message_id FOR UPDATE;
  IF FOUND THEN RETURN purama_ai.email_agent_send_result(dispatch); END IF;
  SELECT * INTO preview FROM purama_ai.email_agent_draft_previews
    WHERE id=p_approval_id AND user_id=p_user_id AND log_id=p_log_id FOR UPDATE;
  IF NOT FOUND OR preview.expires_at<=clock_timestamp() THEN
    RETURN jsonb_build_object('status','blocked','reason','approval_expired_or_missing');
  END IF;
  IF item.action_taken<>'draft' OR item.user_approved IS FALSE OR cfg.id IS NULL
    OR preview.payload IS DISTINCT FROM
      (purama_ai.email_agent_send_payload(item)||jsonb_build_object('gmail_email',cfg.gmail_email))
    OR preview.connection_updated_at IS DISTINCT FROM cfg.updated_at THEN
    RETURN jsonb_build_object('status','blocked','reason','stale_approval');
  END IF;
  IF preview.approved_at IS NOT NULL THEN
    IF item.user_approved IS DISTINCT FROM TRUE OR item.feedback_at IS DISTINCT FROM preview.approved_at THEN
      RETURN jsonb_build_object('status','blocked','reason','stale_approval');
    END IF;
  ELSE
    IF preview.observed_approval IS DISTINCT FROM item.user_approved
      OR preview.observed_feedback_at IS DISTINCT FROM item.feedback_at THEN
      RETURN jsonb_build_object('status','blocked','reason','stale_approval');
    END IF;
    approved := clock_timestamp();
    UPDATE purama_ai.email_agent_draft_previews SET approved_at=approved WHERE id=preview.id;
    UPDATE purama_ai.email_agent_logs SET user_approved=TRUE,user_feedback=p_feedback,feedback_at=approved
      WHERE id=p_log_id AND user_id=p_user_id;
  END IF;
  RETURN jsonb_build_object('status','approved','approval_id',preview.id,'user_id',p_user_id,'log_id',p_log_id);
END $$;

-- Keep old clients closed even if a legacy bool was set directly on the log.
CREATE OR REPLACE FUNCTION purama_ai.email_agent_send_reserve(
  p_user_id UUID,p_log_id UUID,p_claim_token UUID
) RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
  SELECT jsonb_build_object('status','blocked','reason','versioned_approval_required','claimed',false)
$$;

CREATE OR REPLACE FUNCTION purama_ai.email_agent_send_reserve(
  p_user_id UUID,p_log_id UUID,p_claim_token UUID,p_approval_id UUID
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE
  cfg purama_ai.email_agent_config;
  item purama_ai.email_agent_logs;
  dispatch purama_ai.email_agent_dispatches;
  preview purama_ai.email_agent_draft_previews;
  result JSONB;
BEGIN
  IF p_user_id IS NULL OR p_log_id IS NULL OR p_claim_token IS NULL OR p_approval_id IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','versioned_approval_required','claimed',false);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('email-agent-send:'||p_user_id::TEXT,0));
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  SELECT * INTO item FROM purama_ai.email_agent_logs WHERE id=p_log_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','log_not_found','claimed',false); END IF;
  SELECT * INTO dispatch FROM purama_ai.email_agent_dispatches
    WHERE user_id=p_user_id AND gmail_message_id=item.gmail_message_id FOR UPDATE;
  IF FOUND THEN
    IF dispatch.approval_id IS NOT NULL AND dispatch.approval_id IS DISTINCT FROM p_approval_id THEN
      RETURN jsonb_build_object('status','blocked','reason','approval_mismatch','claimed',false);
    END IF;
    IF dispatch.status='sent' AND dispatch.payload IS DISTINCT FROM
        (purama_ai.email_agent_send_payload(item)||jsonb_build_object('gmail_email',cfg.gmail_email)) THEN
      RETURN jsonb_build_object('status','blocked','reason','previous_send_differs','claimed',false);
    END IF;
    RETURN purama_ai.email_agent_send_result(dispatch)||
      jsonb_build_object('matches_current_preview',dispatch.status='sent');
  END IF;
  SELECT * INTO preview FROM purama_ai.email_agent_draft_previews
    WHERE id=p_approval_id AND user_id=p_user_id AND log_id=p_log_id FOR UPDATE;
  IF NOT FOUND OR preview.approved_at IS NULL OR preview.expires_at<=clock_timestamp() THEN
    RETURN jsonb_build_object('status','blocked','reason','versioned_approval_required','claimed',false);
  END IF;
  IF item.user_approved IS DISTINCT FROM TRUE OR item.feedback_at IS DISTINCT FROM preview.approved_at THEN
    RETURN jsonb_build_object('status','blocked','reason','approval_required','claimed',false);
  END IF;
  IF preview.payload IS DISTINCT FROM
      (purama_ai.email_agent_send_payload(item)||jsonb_build_object('gmail_email',cfg.gmail_email))
    OR preview.connection_updated_at IS DISTINCT FROM cfg.updated_at THEN
    RETURN jsonb_build_object('status','blocked','reason','stale_approval','claimed',false);
  END IF;
  result := purama_ai.email_agent_send_reserve_unversioned_internal(p_user_id,p_log_id,p_claim_token);
  IF (result->>'claimed')::BOOLEAN IS TRUE THEN
    UPDATE purama_ai.email_agent_dispatches SET approval_id=preview.id WHERE id=(result->>'action_id')::UUID;
  END IF;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION purama_ai.email_agent_send_begin(
  p_user_id UUID,p_action_id UUID,p_claim_token UUID,p_connection_email TEXT,p_connection_updated_at TIMESTAMPTZ
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE
  cfg purama_ai.email_agent_config;
  item purama_ai.email_agent_logs;
  dispatch purama_ai.email_agent_dispatches;
  preview purama_ai.email_agent_draft_previews;
  log_key UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('email-agent-send:'||p_user_id::TEXT,0));
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  SELECT log_id INTO log_key FROM purama_ai.email_agent_dispatches WHERE id=p_action_id AND user_id=p_user_id;
  SELECT * INTO item FROM purama_ai.email_agent_logs WHERE id=log_key AND user_id=p_user_id FOR UPDATE;
  SELECT * INTO dispatch FROM purama_ai.email_agent_dispatches WHERE id=p_action_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','dispatch_not_found','claimed',false); END IF;
  IF dispatch.claim_token IS DISTINCT FROM p_claim_token OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','claim_mismatch','claimed',false);
  END IF;
  IF dispatch.status='preparing' THEN
    SELECT * INTO preview FROM purama_ai.email_agent_draft_previews
      WHERE id=dispatch.approval_id AND user_id=p_user_id AND log_id=dispatch.log_id;
    IF NOT FOUND OR preview.approved_at IS NULL OR preview.expires_at<=clock_timestamp()
      OR preview.payload IS DISTINCT FROM dispatch.payload
      OR preview.approved_at IS DISTINCT FROM item.feedback_at THEN
      UPDATE purama_ai.email_agent_dispatches SET status='blocked',reason='versioned_approval_changed',
        updated_at=clock_timestamp() WHERE id=dispatch.id RETURNING * INTO dispatch;
      RETURN purama_ai.email_agent_send_result(dispatch);
    END IF;
    IF cfg.id IS NULL OR preview.connection_updated_at IS DISTINCT FROM cfg.updated_at THEN
      UPDATE purama_ai.email_agent_dispatches SET status='blocked',reason='gmail_connection_changed',
        updated_at=clock_timestamp() WHERE id=dispatch.id RETURNING * INTO dispatch;
      RETURN purama_ai.email_agent_send_result(dispatch);
    END IF;
  END IF;
  RETURN purama_ai.email_agent_send_begin_unversioned_internal(p_user_id,p_action_id,p_claim_token,
    p_connection_email,p_connection_updated_at);
END $$;

-- An accepted Gmail POST still belongs to its frozen dispatch if a review or
-- edit occurs while the provider responds. Never overwrite that later review,
-- nor mark different current content as sent. Receipt and counter stay atomic.
CREATE OR REPLACE FUNCTION purama_ai.email_agent_send_finish(
  p_user_id UUID,p_action_id UUID,p_claim_token UUID,
  p_outcome TEXT,p_provider_message_id TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE
  cfg purama_ai.email_agent_config;
  item purama_ai.email_agent_logs;
  dispatch purama_ai.email_agent_dispatches;
  log_key UUID;
  matches_current BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('email-agent-send:'||p_user_id::TEXT,0));
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
  matches_current := item.id IS NOT NULL AND cfg.id IS NOT NULL
    AND (purama_ai.email_agent_send_payload(item)||jsonb_build_object('gmail_email',cfg.gmail_email))
      IS NOT DISTINCT FROM dispatch.payload;
  -- A lost acknowledgement cannot downgrade a durable receipt or count twice.
  IF dispatch.status NOT IN ('preparing','sending') THEN
    RETURN purama_ai.email_agent_send_result(dispatch)||
      jsonb_build_object('matches_current_preview',dispatch.status='sent' AND matches_current);
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
    provider_message_id=CASE WHEN p_outcome IN ('sent','unknown') THEN p_provider_message_id ELSE NULL END,
    reason=CASE WHEN p_outcome='sent' THEN NULL WHEN p_outcome='unknown' THEN 'provider_outcome_unverified'
      WHEN dispatch.dispatch_started_at IS NULL THEN 'preparation_failed' ELSE 'provider_rejected' END,
    updated_at=clock_timestamp() WHERE id=dispatch.id RETURNING * INTO dispatch;
  IF p_outcome='sent' THEN
    UPDATE purama_ai.email_agent_logs SET action_taken='auto_reply'
      WHERE id=dispatch.log_id AND user_id=p_user_id AND gmail_message_id=dispatch.gmail_message_id
        AND matches_current;
    UPDATE purama_ai.email_agent_config SET total_auto_replied=coalesce(total_auto_replied,0)+1
      WHERE user_id=p_user_id;
  END IF;
  RETURN purama_ai.email_agent_send_result(dispatch)||
    jsonb_build_object('matches_current_preview',dispatch.status='sent' AND matches_current);
END $$;

REVOKE ALL ON FUNCTION purama_ai.email_agent_draft_preview(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.email_agent_draft_approve(UUID,UUID,UUID,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.email_agent_send_reserve(UUID,UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.email_agent_send_reserve(UUID,UUID,UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.email_agent_send_begin(UUID,UUID,UUID,TEXT,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.email_agent_send_finish(UUID,UUID,UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.email_agent_draft_preview(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.email_agent_draft_approve(UUID,UUID,UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.email_agent_send_reserve(UUID,UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.email_agent_send_reserve(UUID,UUID,UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.email_agent_send_begin(UUID,UUID,UUID,TEXT,TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.email_agent_send_finish(UUID,UUID,UUID,TEXT,TEXT) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
