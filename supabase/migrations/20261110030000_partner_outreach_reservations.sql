-- Durable, tenant-scoped outreach admission. No historical row is deleted.
BEGIN;

CREATE TABLE IF NOT EXISTS purama_ai.partner_outreach_suppressions (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email_normalized text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, email_normalized)
);
ALTER TABLE purama_ai.partner_outreach_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.partner_outreach_suppressions FROM PUBLIC, anon, authenticated;
GRANT ALL ON purama_ai.partner_outreach_suppressions TO service_role;

-- The existing reply handler represents unsubscribe/not_interested as rejected.
-- Keep that exclusion after a later pipeline edit, deletion or reimport.
CREATE OR REPLACE FUNCTION purama_ai.partner_remember_outreach_suppression()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
BEGIN
  IF NEW.status = 'rejected' AND NULLIF(btrim(NEW.email), '') IS NOT NULL THEN
    INSERT INTO purama_ai.partner_outreach_suppressions(user_id, email_normalized)
    VALUES (NEW.user_id, lower(btrim(NEW.email))) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION purama_ai.partner_remember_outreach_suppression() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS partner_remember_outreach_suppression ON purama_ai.partner_prospects;
CREATE TRIGGER partner_remember_outreach_suppression AFTER INSERT OR UPDATE OF status, email, user_id
  ON purama_ai.partner_prospects FOR EACH ROW
  EXECUTE FUNCTION purama_ai.partner_remember_outreach_suppression();
INSERT INTO purama_ai.partner_outreach_suppressions(user_id, email_normalized)
SELECT user_id, lower(btrim(email)) FROM purama_ai.partner_prospects
WHERE status = 'rejected' AND NULLIF(btrim(email), '') IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS purama_ai.partner_outreach_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Preserve the action identity if a client deletes the prospect/email history.
  -- Ownership/existence is rechecked in every admission function below.
  prospect_id uuid NOT NULL,
  step text NOT NULL CHECK (step IN ('outreach','relance_1','relance_2','relance_3')),
  status text NOT NULL CHECK (status IN ('preparing','ready','pending_approval','sending','sent','failed','unknown','blocked')),
  claim_token uuid NOT NULL,
  recipient text NOT NULL,
  generation_attempts integer NOT NULL DEFAULT 1 CHECK (generation_attempts BETWEEN 1 AND 3),
  lease_until timestamptz,
  email_id uuid REFERENCES purama_ai.partner_emails(id) ON DELETE SET NULL,
  payload jsonb,
  approval_version uuid NOT NULL DEFAULT gen_random_uuid(),
  approved_at timestamptz,
  provider_message_id text,
  dispatch_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, prospect_id, step),
  CHECK (status <> 'sent' OR NULLIF(btrim(provider_message_id), '') IS NOT NULL)
);
ALTER TABLE purama_ai.partner_outreach_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.partner_outreach_dispatches FROM PUBLIC, anon, authenticated;
GRANT ALL ON purama_ai.partner_outreach_dispatches TO service_role;
CREATE INDEX IF NOT EXISTS partner_outreach_daily_dispatches
  ON purama_ai.partner_outreach_dispatches(user_id, dispatch_started_at);
CREATE INDEX IF NOT EXISTS partner_outreach_recipient_history
  ON purama_ai.partner_outreach_dispatches(user_id, lower(btrim(recipient)), step);

ALTER TABLE purama_ai.partner_emails DROP CONSTRAINT IF EXISTS partner_emails_status_check;
ALTER TABLE purama_ai.partner_emails ADD CONSTRAINT partner_emails_status_check
  CHECK (status IN ('draft','pending_approval','approved','sending','sent','failed','unknown','blocked'));

-- Approval previews come from the frozen server-owned payload, never from the
-- legacy email row which remains editable through its historical client policy.
CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_result(p_action_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
  SELECT jsonb_build_object('action_id',id,'status',status,'email_id',email_id,
    'provider_message_id',provider_message_id,'claimed',false,
    'approval',CASE WHEN status = 'pending_approval' THEN jsonb_build_object(
      'version',approval_version,'from',payload->>'from','to',payload->>'to',
      'subject',payload->>'subject','body_html',payload->>'html') ELSE NULL END)
  FROM purama_ai.partner_outreach_dispatches WHERE id = p_action_id;
$$;

-- All callers acquire config then prospect locks, before a dispatch lock.
-- The config row also serializes per-account quota admission across prospects.
CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_reason(
  p_user_id uuid, p_prospect_id uuid, p_step text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  cfg purama_ai.partner_agent_config%ROWTYPE;
  prospect purama_ai.partner_prospects%ROWTYPE;
  step_number integer;
BEGIN
  IF p_step IS NULL OR p_step NOT IN ('outreach','relance_1','relance_2','relance_3') THEN RETURN 'invalid_step'; END IF;
  SELECT * INTO cfg FROM purama_ai.partner_agent_config WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'config_missing'; END IF;
  SELECT * INTO prospect FROM purama_ai.partner_prospects
    WHERE id = p_prospect_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'prospect_not_found'; END IF;
  IF cfg.is_active IS NOT TRUE THEN RETURN 'agent_inactive'; END IF;
  IF prospect.status = 'rejected' OR EXISTS (
    SELECT 1 FROM purama_ai.partner_outreach_suppressions
    WHERE user_id = p_user_id AND email_normalized = lower(btrim(prospect.email))
  ) THEN RETURN 'contact_suppressed'; END IF;
  IF prospect.has_replied IS DISTINCT FROM false THEN RETURN 'contact_has_replied'; END IF;
  IF prospect.email IS NULL OR btrim(prospect.email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    THEN RETURN 'invalid_recipient'; END IF;
  IF cfg.sender_email IS NULL OR btrim(cfg.sender_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR NULLIF(btrim(cfg.sender_name), '') IS NULL OR cfg.sender_name ~ E'[\r\n]'
    THEN RETURN 'invalid_sender'; END IF;
  IF cfg.require_approval_new_prospect IS NOT false AND prospect.status = 'identified'
    THEN RETURN 'prospect_approval_required'; END IF;
  -- Old code could send before recording the result or updating the prospect.
  -- Do not interpret an unlinked historical draft/failed row as safe to resend.
  IF EXISTS (SELECT 1 FROM purama_ai.partner_emails e
    WHERE e.user_id = p_user_id AND e.prospect_id = p_prospect_id AND e.type = p_step
      AND NOT EXISTS (SELECT 1 FROM purama_ai.partner_outreach_dispatches d WHERE d.email_id = e.id))
    THEN RETURN 'previous_attempt_requires_review'; END IF;
  -- A delete/reimport may assign a new prospect UUID. The account lock above
  -- serializes this recipient-history check with every reservation creation.
  IF EXISTS (SELECT 1 FROM purama_ai.partner_outreach_dispatches d
    WHERE d.user_id = p_user_id AND d.step = p_step AND d.prospect_id <> p_prospect_id
      AND lower(btrim(d.recipient)) = lower(btrim(prospect.email)))
    THEN RETURN 'previous_attempt_requires_review'; END IF;
  IF p_step = 'outreach' THEN
    IF prospect.status NOT IN ('identified','ready_to_contact') OR prospect.status IS NULL
      OR prospect.first_contact_at IS NOT NULL THEN RETURN 'already_contacted'; END IF;
  ELSE
    step_number := right(p_step, 1)::integer;
    IF step_number > COALESCE(cfg.max_relances, 0)
      OR COALESCE(prospect.relance_count, 0) <> step_number - 1
      OR prospect.status IS DISTINCT FROM (CASE WHEN step_number = 1 THEN 'contacted' ELSE 'relance_' || (step_number - 1)::text END)
      OR prospect.next_action_at IS NULL OR prospect.next_action_at > now()
      THEN RETURN 'followup_not_due'; END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_reserve(
  p_user_id uuid, p_prospect_id uuid, p_step text, p_claim_token uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  reason text;
  action purama_ai.partner_outreach_dispatches%ROWTYPE;
  cfg purama_ai.partner_agent_config%ROWTYPE;
  prospect purama_ai.partner_prospects%ROWTYPE;
BEGIN
  IF p_claim_token IS NULL THEN RAISE EXCEPTION 'Missing claim token'; END IF;
  reason := purama_ai.partner_outreach_reason(p_user_id, p_prospect_id, p_step);
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches
    WHERE user_id = p_user_id AND prospect_id = p_prospect_id AND step = p_step FOR UPDATE;
  IF FOUND AND (action.status IN ('sent','sending','unknown','pending_approval','blocked')
    OR (action.status = 'failed' AND (action.dispatch_started_at IS NOT NULL OR action.generation_attempts >= 3))
    OR (action.status = 'preparing' AND action.lease_until > now())) THEN
    IF action.status = 'sending' AND action.dispatch_started_at < now() - interval '2 minutes' THEN
      UPDATE purama_ai.partner_outreach_dispatches SET status = 'unknown', updated_at = now()
        WHERE id = action.id RETURNING * INTO action;
      UPDATE purama_ai.partner_emails SET status = 'unknown' WHERE id = action.email_id AND user_id = p_user_id;
    END IF;
    RETURN purama_ai.partner_outreach_result(action.id);
  END IF;
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked','reason',reason); END IF;
  SELECT * INTO cfg FROM purama_ai.partner_agent_config WHERE user_id = p_user_id;
  SELECT * INTO prospect FROM purama_ai.partner_prospects WHERE id = p_prospect_id AND user_id = p_user_id;
  IF action.id IS NOT NULL AND action.status = 'ready' THEN
    RETURN jsonb_build_object('action_id',action.id,'status','ready','email_id',action.email_id,'claimed',false);
  END IF;
  IF action.id IS NOT NULL THEN
    IF action.generation_attempts >= 3 THEN RETURN jsonb_build_object('status','blocked','reason','preparation_attempts_exhausted'); END IF;
    UPDATE purama_ai.partner_outreach_dispatches SET status = 'preparing', claim_token = p_claim_token,
      generation_attempts = generation_attempts + 1, lease_until = now() + interval '5 minutes', updated_at = now()
      WHERE id = action.id RETURNING * INTO action;
  ELSE
    INSERT INTO purama_ai.partner_outreach_dispatches(user_id, prospect_id, step, status, claim_token, recipient, lease_until)
      VALUES (p_user_id, p_prospect_id, p_step, 'preparing', p_claim_token, btrim(prospect.email), now() + interval '5 minutes')
      RETURNING * INTO action;
  END IF;
  RETURN jsonb_build_object('action_id',action.id,'status','preparing','claimed',true,
    'prospect',to_jsonb(prospect),'config',to_jsonb(cfg));
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_save_draft(
  p_user_id uuid, p_action_id uuid, p_claim_token uuid, p_subject text, p_body_html text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  action purama_ai.partner_outreach_dispatches%ROWTYPE;
  cfg purama_ai.partner_agent_config%ROWTYPE;
  prospect purama_ai.partner_prospects%ROWTYPE;
  reason text;
  email_uuid uuid;
  new_state text;
BEGIN
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches WHERE id = p_action_id AND user_id = p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','action_not_found'); END IF;
  reason := purama_ai.partner_outreach_reason(p_user_id, action.prospect_id, action.step);
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches WHERE id = p_action_id AND user_id = p_user_id FOR UPDATE;
  IF action.status <> 'preparing' OR action.claim_token IS DISTINCT FROM p_claim_token OR action.lease_until <= now()
    THEN RETURN jsonb_build_object('status','blocked','reason','stale_claim'); END IF;
  SELECT * INTO prospect FROM purama_ai.partner_prospects WHERE id = action.prospect_id AND user_id = p_user_id;
  IF reason IS NULL AND action.recipient IS DISTINCT FROM btrim(prospect.email) THEN reason := 'recipient_changed'; END IF;
  IF reason IS NOT NULL THEN
    UPDATE purama_ai.partner_outreach_dispatches SET status = 'blocked', updated_at = now() WHERE id = action.id;
    RETURN jsonb_build_object('status','blocked','reason',reason);
  END IF;
  IF NULLIF(btrim(p_subject),'') IS NULL OR length(p_subject) > 200 OR p_subject ~ E'[\r\n]'
    OR NULLIF(btrim(p_body_html),'') IS NULL OR length(p_body_html) > 50000 THEN RAISE EXCEPTION 'Invalid draft'; END IF;
  SELECT * INTO cfg FROM purama_ai.partner_agent_config WHERE user_id = p_user_id;
  new_state := CASE WHEN cfg.require_approval_outreach IS NOT false THEN 'pending_approval' ELSE 'ready' END;
  INSERT INTO purama_ai.partner_emails(user_id, prospect_id, type, subject, body_html, status)
    VALUES (p_user_id, action.prospect_id, action.step, p_subject, p_body_html,
      CASE WHEN new_state = 'pending_approval' THEN 'pending_approval' ELSE 'draft' END)
    RETURNING id INTO email_uuid;
  UPDATE purama_ai.partner_outreach_dispatches SET status = new_state, email_id = email_uuid,
    payload = jsonb_build_object(
      'from', regexp_replace(cfg.sender_name, '[<>"]', '', 'g') || ' <' || btrim(cfg.sender_email) || '>',
      'to', action.recipient, 'subject', p_subject, 'html', p_body_html, 'reply_to', btrim(cfg.sender_email)
    ), updated_at = now() WHERE id = action.id;
  RETURN purama_ai.partner_outreach_result(action.id) || jsonb_build_object('claimed',true);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_approve(
  p_user_id uuid, p_email_id uuid, p_approval_version uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  action purama_ai.partner_outreach_dispatches%ROWTYPE;
  reason text;
BEGIN
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches
    WHERE email_id = p_email_id AND user_id = p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','action_not_found'); END IF;
  reason := purama_ai.partner_outreach_reason(p_user_id, action.prospect_id, action.step);
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches
    WHERE email_id = p_email_id AND user_id = p_user_id FOR UPDATE;
  IF p_approval_version IS NULL OR action.approval_version IS DISTINCT FROM p_approval_version THEN
    RETURN jsonb_build_object('status','blocked','reason','stale_approval');
  END IF;
  IF action.status IN ('sent','sending','unknown') THEN RETURN purama_ai.partner_outreach_result(action.id); END IF;
  IF reason IS NOT NULL THEN
    UPDATE purama_ai.partner_outreach_dispatches SET status='blocked',updated_at=now() WHERE id=action.id;
    UPDATE purama_ai.partner_emails SET status='blocked' WHERE id=action.email_id AND user_id=p_user_id;
    RETURN jsonb_build_object('status','blocked','reason',reason,'email_id',action.email_id);
  END IF;
  IF action.status = 'ready' AND action.approved_at IS NOT NULL THEN RETURN purama_ai.partner_outreach_result(action.id); END IF;
  IF action.status <> 'pending_approval' THEN RETURN jsonb_build_object('status','blocked','reason','approval_not_pending'); END IF;
  UPDATE purama_ai.partner_outreach_dispatches SET status='ready',approved_at=now(),updated_at=now() WHERE id=action.id;
  UPDATE purama_ai.partner_emails SET status='approved',approved_at=now() WHERE id=action.email_id AND user_id=p_user_id;
  RETURN purama_ai.partner_outreach_result(action.id);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_begin_send(
  p_user_id uuid, p_action_id uuid, p_claim_token uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  action purama_ai.partner_outreach_dispatches%ROWTYPE;
  cfg purama_ai.partner_agent_config%ROWTYPE;
  prospect purama_ai.partner_prospects%ROWTYPE;
  reason text;
  sent_today bigint;
BEGIN
  IF p_claim_token IS NULL THEN RAISE EXCEPTION 'Missing claim token'; END IF;
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches WHERE id = p_action_id AND user_id = p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','action_not_found'); END IF;
  reason := purama_ai.partner_outreach_reason(p_user_id, action.prospect_id, action.step);
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches WHERE id = p_action_id AND user_id = p_user_id FOR UPDATE;
  IF action.status <> 'ready' THEN RETURN purama_ai.partner_outreach_result(action.id); END IF;
  SELECT * INTO cfg FROM purama_ai.partner_agent_config WHERE user_id = p_user_id;
  SELECT * INTO prospect FROM purama_ai.partner_prospects WHERE id = action.prospect_id AND user_id = p_user_id;
  IF reason IS NULL AND action.recipient IS DISTINCT FROM btrim(prospect.email) THEN reason := 'recipient_changed'; END IF;
  IF reason IS NULL AND (action.payload->>'reply_to' IS DISTINCT FROM btrim(cfg.sender_email)
    OR action.payload->>'from' IS DISTINCT FROM regexp_replace(cfg.sender_name, '[<>"]', '', 'g') || ' <' || btrim(cfg.sender_email) || '>')
    THEN reason := 'sender_changed'; END IF;
  IF reason IS NOT NULL THEN
    UPDATE purama_ai.partner_outreach_dispatches SET status = 'blocked', updated_at = now() WHERE id = action.id;
    UPDATE purama_ai.partner_emails SET status = 'blocked' WHERE id = action.email_id AND user_id = p_user_id;
    RETURN jsonb_build_object('status','blocked','reason',reason,'email_id',action.email_id);
  END IF;
  IF cfg.require_approval_outreach IS NOT false AND action.approved_at IS NULL THEN
    UPDATE purama_ai.partner_outreach_dispatches SET status = 'pending_approval', updated_at = now() WHERE id = action.id;
    UPDATE purama_ai.partner_emails SET status = 'pending_approval' WHERE id = action.email_id AND user_id = p_user_id;
    RETURN purama_ai.partner_outreach_result(action.id);
  END IF;
  SELECT count(*) INTO sent_today FROM purama_ai.partner_outreach_dispatches
    WHERE user_id = p_user_id AND dispatch_started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  -- Include pre-migration sends without counting linked new sends twice.
  SELECT sent_today + count(*) INTO sent_today FROM purama_ai.partner_emails e
    WHERE e.user_id = p_user_id AND e.type IN ('outreach','relance_1','relance_2','relance_3')
      AND e.sent_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      AND NOT EXISTS (SELECT 1 FROM purama_ai.partner_outreach_dispatches d WHERE d.email_id = e.id);
  IF COALESCE(cfg.daily_outreach_limit, 0) <= sent_today THEN
    RETURN jsonb_build_object('status','blocked','reason','daily_limit','email_id',action.email_id);
  END IF;
  UPDATE purama_ai.partner_outreach_dispatches SET status = 'sending', claim_token = p_claim_token,
    dispatch_started_at = now(), updated_at = now() WHERE id = action.id;
  UPDATE purama_ai.partner_emails SET status = 'sending' WHERE id = action.email_id AND user_id = p_user_id;
  RETURN jsonb_build_object('action_id',action.id,'status','sending','email_id',action.email_id,'claimed',true,
    'payload',action.payload,'idempotency_key','partner-outreach/' || action.id::text);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_finish(
  p_user_id uuid, p_action_id uuid, p_claim_token uuid, p_outcome text, p_provider_message_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  action purama_ai.partner_outreach_dispatches%ROWTYPE;
  cfg purama_ai.partner_agent_config%ROWTYPE;
  prospect purama_ai.partner_prospects%ROWTYPE;
  delay_days integer;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent','failed','unknown') THEN RAISE EXCEPTION 'Invalid outcome'; END IF;
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches WHERE id = p_action_id AND user_id = p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','action_not_found'); END IF;
  SELECT * INTO cfg FROM purama_ai.partner_agent_config WHERE user_id = p_user_id FOR UPDATE;
  SELECT * INTO prospect FROM purama_ai.partner_prospects WHERE id = action.prospect_id AND user_id = p_user_id FOR UPDATE;
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches WHERE id = p_action_id AND user_id = p_user_id FOR UPDATE;
  IF action.claim_token IS DISTINCT FROM p_claim_token THEN RETURN jsonb_build_object('status','blocked','reason','stale_claim'); END IF;
  IF action.status = 'sent' THEN RETURN jsonb_build_object('status','sent','email_id',action.email_id,
    'provider_message_id',action.provider_message_id); END IF;
  IF NOT (action.status IN ('sending','unknown') OR (action.status = 'preparing' AND p_outcome = 'failed'))
    THEN RETURN jsonb_build_object('status',action.status,'email_id',action.email_id); END IF;
  IF p_outcome = 'sent' AND NULLIF(btrim(p_provider_message_id), '') IS NULL THEN RAISE EXCEPTION 'Provider proof required'; END IF;
  UPDATE purama_ai.partner_outreach_dispatches SET status = p_outcome,
    provider_message_id = CASE WHEN p_outcome = 'sent' THEN p_provider_message_id ELSE provider_message_id END,
    lease_until = NULL, updated_at = now() WHERE id = action.id;
  UPDATE purama_ai.partner_emails SET status = p_outcome,
    sent_at = CASE WHEN p_outcome = 'sent' THEN now() ELSE sent_at END,
    resend_message_id = CASE WHEN p_outcome = 'sent' THEN p_provider_message_id ELSE resend_message_id END
    WHERE id = action.email_id AND user_id = p_user_id;
  IF p_outcome = 'sent' THEN
    UPDATE purama_ai.partner_prospects SET first_contact_at = COALESCE(first_contact_at, now()), last_contact_at = now()
      WHERE id = action.prospect_id AND user_id = p_user_id;
    -- A late acceptance must never undo a reply or an opposition received in flight.
    IF prospect.has_replied IS false AND prospect.status <> 'rejected' AND cfg.is_active IS true
      AND NOT EXISTS (SELECT 1 FROM purama_ai.partner_outreach_suppressions
        WHERE user_id = p_user_id AND email_normalized = lower(btrim(prospect.email))) THEN
      delay_days := CASE action.step WHEN 'outreach' THEN cfg.relance_1_delay_days
        WHEN 'relance_1' THEN cfg.relance_2_delay_days ELSE cfg.relance_3_delay_days END;
      UPDATE purama_ai.partner_prospects SET
        status = CASE WHEN action.step = 'outreach' THEN 'contacted' ELSE action.step END,
        relance_count = CASE WHEN action.step = 'outreach' THEN COALESCE(relance_count, 0) ELSE right(action.step, 1)::integer END,
        next_action_at = CASE WHEN action.step = 'relance_3' THEN NULL ELSE now() + make_interval(days => greatest(0, COALESCE(delay_days, 0))) END
        WHERE id = action.prospect_id AND user_id = p_user_id;
    END IF;
  END IF;
  RETURN jsonb_build_object('status',p_outcome,'email_id',action.email_id,
    'provider_message_id',CASE WHEN p_outcome = 'sent' THEN p_provider_message_id ELSE NULL END);
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.partner_outreach_reason(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_result(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_reserve(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_save_draft(uuid,uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_begin_send(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_finish(uuid,uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_approve(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.partner_outreach_reserve(uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.partner_outreach_save_draft(uuid,uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.partner_outreach_begin_send(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.partner_outreach_finish(uuid,uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.partner_outreach_approve(uuid,uuid,uuid) TO service_role;

COMMIT;
