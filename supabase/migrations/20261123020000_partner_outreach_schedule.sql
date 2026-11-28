-- Respect each account's explicit wall-clock schedule at admission and dispatch.
-- UTC is the explicit migration default because no prior account timezone was stored.
-- No deployment timezone or browser locale is silently treated as user consent.
BEGIN;

ALTER TABLE purama_ai.partner_agent_config
  ADD COLUMN IF NOT EXISTS outreach_timezone text NOT NULL DEFAULT 'UTC';

-- [start,end), in the named timezone. An overnight window belongs to the day
-- on which it starts. Empty days or equal endpoints mean no sending window.
-- PostgreSQL resolves both occurrences of a repeated DST hour consistently;
-- durable prospect/step reservations prevent duplicate sends across that hour.
CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_schedule_reason(
  p_timezone text, p_start time, p_end time, p_days text[], p_at timestamptz
) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  local_at timestamp;
  local_time time;
  day_index integer;
  day_keys text[] := ARRAY['MO','TU','WE','TH','FR','SA','SU'];
BEGIN
  -- text[] also accepts multidimensional arrays. Reject these before calling
  -- array_position, which would throw and stop discovery for other accounts.
  IF p_days IS NULL OR COALESCE(array_ndims(p_days), 1) <> 1 OR cardinality(p_days) > 7
    THEN RETURN 'invalid_outreach_schedule'; END IF;
  IF p_at IS NULL OR p_timezone IS NULL OR length(p_timezone) > 100
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = p_timezone)
    OR p_start IS NULL OR p_end IS NULL OR p_start >= time '24:00'
    OR array_position(p_days, NULL) IS NOT NULL
    OR NOT (p_days <@ day_keys) THEN RETURN 'invalid_outreach_schedule'; END IF;
  IF cardinality(p_days) = 0 OR p_start = p_end THEN RETURN 'outside_outreach_hours'; END IF;
  local_at := p_at AT TIME ZONE p_timezone;
  local_time := local_at::time;
  day_index := extract(isodow FROM local_at)::integer;
  IF p_start < p_end THEN
    IF day_keys[day_index] = ANY(p_days) AND local_time >= p_start AND local_time < p_end THEN RETURN NULL; END IF;
  ELSE
    IF local_time >= p_start AND day_keys[day_index] = ANY(p_days) THEN RETURN NULL; END IF;
    IF local_time < p_end AND day_keys[CASE WHEN day_index = 1 THEN 7 ELSE day_index - 1 END] = ANY(p_days) THEN RETURN NULL; END IF;
  END IF;
  RETURN 'outside_outreach_hours';
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_daily_count(
  p_user_id uuid, p_timezone text, p_at timestamptz
) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
  -- Include uncertain/in-flight dispatches and unlinked historical sends.
  -- Midnight is calculated in the selected timezone, including 23/25-hour days.
  SELECT (SELECT count(*) FROM purama_ai.partner_outreach_dispatches d
    WHERE d.user_id = p_user_id
      AND d.dispatch_started_at >= date_trunc('day', p_at AT TIME ZONE p_timezone) AT TIME ZONE p_timezone)
    + (SELECT count(*) FROM purama_ai.partner_emails e
      WHERE e.user_id = p_user_id AND e.type IN ('outreach','relance_1','relance_2','relance_3')
        AND e.sent_at >= date_trunc('day', p_at AT TIME ZONE p_timezone) AT TIME ZONE p_timezone
        AND NOT EXISTS (SELECT 1 FROM purama_ai.partner_outreach_dispatches d WHERE d.email_id = e.id));
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
  reason := purama_ai.partner_outreach_schedule_reason(cfg.outreach_timezone, cfg.outreach_hours_start,
    cfg.outreach_hours_end, cfg.outreach_days, clock_timestamp());
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked','reason',reason); END IF;
  IF COALESCE(cfg.daily_outreach_limit, 0) <= purama_ai.partner_outreach_daily_count(p_user_id, cfg.outreach_timezone, clock_timestamp()) THEN
    RETURN jsonb_build_object('status','blocked','reason','daily_limit');
  END IF;
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

CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_begin_send(
  p_user_id uuid, p_action_id uuid, p_claim_token uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  action purama_ai.partner_outreach_dispatches%ROWTYPE;
  cfg purama_ai.partner_agent_config%ROWTYPE;
  prospect purama_ai.partner_prospects%ROWTYPE;
  reason text;
  sent_today bigint;
  admitted_at timestamptz;
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
  -- Locks can wait across local midnight. Record the same wall-clock instant
  -- used for admission rather than the older transaction start timestamp.
  admitted_at := clock_timestamp();
  -- Schedule/quota are temporary admission gates. Keep the frozen draft and
  -- existing approval so a later admitted run can resume the same action.
  reason := purama_ai.partner_outreach_schedule_reason(cfg.outreach_timezone, cfg.outreach_hours_start,
    cfg.outreach_hours_end, cfg.outreach_days, admitted_at);
  IF reason IS NOT NULL THEN
    RETURN jsonb_build_object('status','blocked','reason',reason,'email_id',action.email_id);
  END IF;
  IF cfg.require_approval_outreach IS NOT false AND action.approved_at IS NULL THEN
    UPDATE purama_ai.partner_outreach_dispatches SET status = 'pending_approval', updated_at = now() WHERE id = action.id;
    UPDATE purama_ai.partner_emails SET status = 'pending_approval' WHERE id = action.email_id AND user_id = p_user_id;
    RETURN purama_ai.partner_outreach_result(action.id);
  END IF;
  sent_today := purama_ai.partner_outreach_daily_count(p_user_id, cfg.outreach_timezone, admitted_at);
  IF COALESCE(cfg.daily_outreach_limit, 0) <= sent_today THEN
    RETURN jsonb_build_object('status','blocked','reason','daily_limit','email_id',action.email_id);
  END IF;
  UPDATE purama_ai.partner_outreach_dispatches SET status = 'sending', claim_token = p_claim_token,
    dispatch_started_at = admitted_at, updated_at = admitted_at WHERE id = action.id;
  UPDATE purama_ai.partner_emails SET status = 'sending' WHERE id = action.email_id AND user_id = p_user_id;
  RETURN jsonb_build_object('action_id',action.id,'status','sending','email_id',action.email_id,'claimed',true,
    'payload',action.payload,'idempotency_key','partner-outreach/' || action.id::text);
END;
$$;

-- n8n discovers bounded candidates here; it does not decide whether sending is
-- authorized. Reserve and begin_send independently repeat authoritative checks.
CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_due(p_kind text, p_limit integer DEFAULT 100)
RETURNS TABLE(prospect_id uuid, user_id uuid, step text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  admitted_at timestamptz := clock_timestamp();
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('outreach','followup')
    OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'Invalid scheduler query'; END IF;
  RETURN QUERY
  WITH scheduled AS MATERIALIZED (
    SELECT c.* FROM purama_ai.partner_agent_config c WHERE c.is_active IS true
      AND btrim(c.sender_email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      AND NULLIF(btrim(c.sender_name), '') IS NOT NULL AND c.sender_name !~ E'[\r\n]'
      AND purama_ai.partner_outreach_schedule_reason(c.outreach_timezone, c.outreach_hours_start,
        c.outreach_hours_end, c.outreach_days, admitted_at) IS NULL
  ), eligible AS MATERIALIZED (
    SELECT c.*, COALESCE(c.daily_outreach_limit, 0)
      - purama_ai.partner_outreach_daily_count(c.user_id, c.outreach_timezone, admitted_at) AS remaining
      FROM scheduled c
  ), candidates AS (
  SELECT p.id AS candidate_id, p.user_id AS account_id, next_step.value AS candidate_step,
    COALESCE(d.updated_at, p.created_at) AS queued_at, p.ai_score, c.remaining,
    row_number() OVER (PARTITION BY p.user_id ORDER BY COALESCE(d.updated_at, p.created_at),
      p.ai_score DESC NULLS LAST, p.id) AS account_rank
    FROM eligible c JOIN purama_ai.partner_prospects p ON p.user_id = c.user_id
    CROSS JOIN LATERAL (SELECT CASE WHEN p_kind = 'outreach' THEN 'outreach'
      ELSE 'relance_' || (COALESCE(p.relance_count, 0) + 1)::text END AS value) next_step
    LEFT JOIN purama_ai.partner_outreach_dispatches d ON d.user_id = p.user_id
      AND d.prospect_id = p.id AND d.step = next_step.value
    WHERE c.remaining > 0 AND p.has_replied IS false
      AND btrim(p.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      AND NOT EXISTS (SELECT 1 FROM purama_ai.partner_outreach_suppressions s
        WHERE s.user_id = p.user_id AND s.email_normalized = lower(btrim(p.email)))
      AND NOT EXISTS (SELECT 1 FROM purama_ai.partner_emails e WHERE e.user_id = p.user_id
        AND e.prospect_id = p.id AND e.type = next_step.value
        AND NOT EXISTS (SELECT 1 FROM purama_ai.partner_outreach_dispatches linked WHERE linked.email_id = e.id))
      AND NOT EXISTS (SELECT 1 FROM purama_ai.partner_outreach_dispatches prior WHERE prior.user_id = p.user_id
        AND prior.step = next_step.value AND prior.prospect_id <> p.id
        AND lower(btrim(prior.recipient)) = lower(btrim(p.email)))
      AND ((p_kind = 'outreach' AND p.first_contact_at IS NULL
          AND (p.status = 'ready_to_contact'
            OR (p.status = 'identified' AND d.status = 'ready' AND c.require_approval_new_prospect IS false)))
        OR (p_kind = 'followup' AND p.status IN ('contacted','relance_1','relance_2')
          AND p.status = CASE WHEN COALESCE(p.relance_count, 0) = 0 THEN 'contacted' ELSE 'relance_' || p.relance_count::text END
          AND p.next_action_at <= admitted_at AND COALESCE(p.relance_count, 0) < LEAST(COALESCE(c.max_relances, 0), 3)))
      AND (d.id IS NULL OR d.status = 'ready'
        OR (d.status = 'failed' AND d.dispatch_started_at IS NULL AND d.generation_attempts < 3)
        OR (d.status = 'preparing' AND d.lease_until <= admitted_at AND d.generation_attempts < 3))
  )
  SELECT c.candidate_id, c.account_id, c.candidate_step FROM candidates c
    WHERE c.account_rank <= LEAST(c.remaining, 5)
    ORDER BY c.account_rank, c.queued_at, c.ai_score DESC NULLS LAST, c.candidate_id
    LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.partner_outreach_schedule_reason(text,time,time,text[],timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_daily_count(uuid,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_due(text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_reserve(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_begin_send(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.partner_outreach_due(text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.partner_outreach_reserve(uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.partner_outreach_begin_send(uuid,uuid,uuid) TO service_role;

COMMIT;
