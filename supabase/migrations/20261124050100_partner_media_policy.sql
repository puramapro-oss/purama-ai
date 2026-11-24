-- Media/editorial qualification augments the existing partner pipeline.
-- No historical commission, consent or signed contract is inferred or rewritten.
BEGIN;

ALTER TABLE purama_ai.partner_agent_config
  ADD COLUMN IF NOT EXISTS outreach_identity_mode text NOT NULL DEFAULT 'assistant'
    CHECK (outreach_identity_mode IN ('assistant','human_reviewed')),
  ADD COLUMN IF NOT EXISTS media_contract_terms jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(media_contract_terms) = 'object');
ALTER TABLE purama_ai.partner_prospects
  ADD COLUMN IF NOT EXISTS outreach_profile text NOT NULL DEFAULT 'legacy'
    CHECK (outreach_profile IN ('legacy','media_affiliate','editorial')),
  ADD COLUMN IF NOT EXISTS contact_qualification jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(contact_qualification) = 'object'),
  ADD COLUMN IF NOT EXISTS email_permission jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(email_permission) = 'object'),
  ADD COLUMN IF NOT EXISTS outreach_offer jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(outreach_offer) = 'object');
ALTER TABLE purama_ai.partner_outreach_dispatches
  ADD COLUMN IF NOT EXISTS policy_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS rfc_message_id text;

-- Public source/product URLs are bounded absolute URLs without credentials,
-- header controls or browser backslash normalization. Unicode hosts use punycode.
CREATE OR REPLACE FUNCTION purama_ai.partner_public_url_valid(p_value text,p_https boolean DEFAULT true)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(length(p_value) BETWEEN 8 AND 2048
    AND p_value !~ '[[:space:][:cntrl:]<>"\\]'
    AND p_value ~ ('^https' || CASE WHEN p_https THEN '' ELSE '?' END ||
      '://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(:[0-9]{1,5})?([/?#].*)?$')
    AND (substring(p_value FROM '^https?://[^/:?#]+:([0-9]{1,5})')::integer BETWEEN 1 AND 65535) IS NOT false, false);
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_media_offer_valid(p_offer jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, purama_ai AS $$
  SELECT COALESCE(jsonb_typeof(p_offer)='object'
    AND jsonb_typeof(p_offer->'name')='string'
    AND length(btrim(p_offer->>'name')) BETWEEN 1 AND 200
    AND p_offer->>'name' !~ '[[:cntrl:]]'
    AND jsonb_typeof(p_offer->'url')='string'
    AND purama_ai.partner_public_url_valid(p_offer->>'url',true)
    AND jsonb_typeof(p_offer->'summary')='string'
    AND length(btrim(p_offer->>'summary')) BETWEEN 10 AND 1500
    AND regexp_replace(p_offer->>'summary',E'[\t\r\n]','','g') !~ '[[:cntrl:]]',false);
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_prospect_qualify(p_prospect_id uuid, p_qualification jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  owner_id uuid := auth.uid();
  prospect purama_ai.partner_prospects%ROWTYPE;
  permission_at timestamptz;
  profile text;
  role_name text;
  recipient text;
  offer jsonb;
BEGIN
  IF owner_id IS NULL THEN RETURN jsonb_build_object('status','blocked','reason','authentication_required'); END IF;
  PERFORM 1 FROM purama_ai.partner_agent_config WHERE user_id = owner_id FOR UPDATE;
  SELECT * INTO prospect FROM purama_ai.partner_prospects
    WHERE id = p_prospect_id AND user_id = owner_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','prospect_not_found'); END IF;
  IF jsonb_typeof(p_qualification) IS DISTINCT FROM 'object' OR octet_length(p_qualification::text) > 16000
    THEN RETURN jsonb_build_object('status','blocked','reason','qualification_invalid'); END IF;
  IF p_qualification->'withdraw_permission' = 'true'::jsonb THEN
    UPDATE purama_ai.partner_prospects SET email_permission = email_permission ||
      jsonb_build_object('status','withdrawn','withdrawn_at',clock_timestamp()), next_action_at = NULL
      WHERE id = prospect.id RETURNING * INTO prospect;
    RETURN jsonb_build_object('status','permission_withdrawn','prospect',to_jsonb(prospect));
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_qualification) k
    WHERE k NOT IN ('profile','role','source_url','country','language','consent_reference','consent_at','offer'))
    THEN RETURN jsonb_build_object('status','blocked','reason','qualification_invalid'); END IF;
  recipient := lower(btrim(prospect.email));
  IF recipient IS NULL OR recipient !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR length(recipient) > 254 THEN RETURN jsonb_build_object('status','blocked','reason','qualification_invalid'); END IF;
  IF prospect.status = 'rejected' OR EXISTS (SELECT 1 FROM purama_ai.partner_outreach_suppressions
    WHERE user_id = owner_id AND email_normalized = recipient)
    THEN RETURN jsonb_build_object('status','blocked','reason','contact_suppressed'); END IF;
  profile := p_qualification->>'profile';
  role_name := p_qualification->>'role';
  IF profile IS NULL OR profile NOT IN ('legacy','media_affiliate','editorial')
    THEN RETURN jsonb_build_object('status','blocked','reason','qualification_invalid'); END IF;
  IF role_name IS NULL OR role_name NOT IN ('editorial','commercial','creator','venue')
    THEN RETURN jsonb_build_object('status','blocked','reason','contact_role_required'); END IF;
  IF (profile = 'editorial' AND role_name <> 'editorial')
    OR (profile <> 'editorial' AND role_name = 'editorial')
    THEN RETURN jsonb_build_object('status','blocked','reason','campaign_role_mismatch'); END IF;
  IF jsonb_typeof(p_qualification->'source_url') IS DISTINCT FROM 'string'
    OR NOT purama_ai.partner_public_url_valid(p_qualification->>'source_url',false)
    THEN RETURN jsonb_build_object('status','blocked','reason','source_required'); END IF;
  IF COALESCE(p_qualification->>'country','') !~ '^[A-Z]{2}$'
    OR COALESCE(p_qualification->>'language','') !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
    OR length(p_qualification->>'language') > 35
    THEN RETURN jsonb_build_object('status','blocked','reason','qualification_invalid'); END IF;
  IF jsonb_typeof(p_qualification->'consent_reference') IS DISTINCT FROM 'string'
    OR length(btrim(p_qualification->>'consent_reference')) NOT BETWEEN 10 AND 2000
    OR regexp_replace(p_qualification->>'consent_reference',E'[\t\r\n]','','g') ~ '[[:cntrl:]]'
    THEN RETURN jsonb_build_object('status','blocked','reason','consent_evidence_required'); END IF;
  IF jsonb_typeof(p_qualification->'consent_at') IS DISTINCT FROM 'string'
    THEN RETURN jsonb_build_object('status','blocked','reason','invalid_consent_date'); END IF;
  BEGIN permission_at := (p_qualification->>'consent_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('status','blocked','reason','invalid_consent_date'); END;
  IF permission_at IS NULL OR NOT isfinite(permission_at) OR permission_at > clock_timestamp()
    THEN RETURN jsonb_build_object('status','blocked','reason','invalid_consent_date'); END IF;
  offer := COALESCE(p_qualification->'offer','{}'::jsonb);
  IF jsonb_typeof(offer) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('status','blocked','reason','offer_required'); END IF;
  IF profile <> 'legacy' AND NOT purama_ai.partner_media_offer_valid(offer)
    THEN RETURN jsonb_build_object('status','blocked','reason','offer_required'); END IF;
  UPDATE purama_ai.partner_prospects SET outreach_profile = profile, contact_role = role_name,
    contact_qualification = jsonb_build_object('email',recipient,'source_url',p_qualification->>'source_url',
      'country',p_qualification->>'country','language',p_qualification->>'language',
      'verified_at',clock_timestamp(),'qualified_by',owner_id),
    email_permission = jsonb_build_object('status','explicit_opt_in','email',recipient,
      'reference',p_qualification->>'consent_reference','consented_at',permission_at,'recorded_at',clock_timestamp()),
    outreach_offer = offer,
    status = CASE WHEN status = 'identified' THEN 'ready_to_contact' ELSE status END
    WHERE id = prospect.id RETURNING * INTO prospect;
  RETURN jsonb_build_object('status','qualified','prospect',to_jsonb(prospect));
END;
$$;
REVOKE ALL ON FUNCTION purama_ai.partner_prospect_qualify(uuid,jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION purama_ai.partner_prospect_qualify(uuid,jsonb) TO authenticated;

-- Direct edits of ordinary prospect fields cannot manufacture permission evidence.
CREATE OR REPLACE FUNCTION purama_ai.partner_guard_qualification_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, purama_ai AS $$
BEGIN
  IF current_user IN ('anon','authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.contact_qualification <> '{}'::jsonb OR NEW.email_permission <> '{}'::jsonb
        OR NEW.outreach_profile <> 'legacy' OR NEW.outreach_offer <> '{}'::jsonb
        THEN RAISE EXCEPTION 'Use partner_prospect_qualify for verified contact data'; END IF;
    ELSIF NEW.contact_qualification IS DISTINCT FROM OLD.contact_qualification
      OR NEW.email_permission IS DISTINCT FROM OLD.email_permission
      OR NEW.outreach_profile IS DISTINCT FROM OLD.outreach_profile
      OR NEW.outreach_offer IS DISTINCT FROM OLD.outreach_offer
      OR (NEW.contact_role IS DISTINCT FROM OLD.contact_role AND OLD.contact_qualification <> '{}'::jsonb)
      THEN RAISE EXCEPTION 'Use partner_prospect_qualify for verified contact data';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS partner_guard_qualification_fields ON purama_ai.partner_prospects;
CREATE TRIGGER partner_guard_qualification_fields BEFORE INSERT OR UPDATE
  ON purama_ai.partner_prospects FOR EACH ROW EXECUTE FUNCTION purama_ai.partner_guard_qualification_fields();

CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_policy_reason(p_user_id uuid,p_prospect_id uuid,p_step text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE cfg purama_ai.partner_agent_config%ROWTYPE; p purama_ai.partner_prospects%ROWTYPE;
BEGIN
  SELECT * INTO cfg FROM purama_ai.partner_agent_config WHERE user_id=p_user_id;
  SELECT * INTO p FROM purama_ai.partner_prospects WHERE id=p_prospect_id AND user_id=p_user_id;
  IF NOT FOUND THEN RETURN 'prospect_not_found'; END IF;
  IF COALESCE(p.contact_qualification->>'email','') <> lower(btrim(p.email))
    OR p.contact_qualification->>'qualified_by' IS DISTINCT FROM p_user_id::text
    OR NULLIF(p.contact_qualification->>'source_url','') IS NULL THEN RETURN 'contact_qualification_required'; END IF;
  -- Resend's opt-in requirement applies independently of a country's B2B rules.
  IF p.email_permission->>'status' IS DISTINCT FROM 'explicit_opt_in'
    OR p.email_permission->>'email' IS DISTINCT FROM lower(btrim(p.email))
    OR COALESCE(length(btrim(p.email_permission->>'reference')),0) < 10
    THEN RETURN 'provider_opt_in_required'; END IF;
  IF p.contact_role = 'unknown' THEN RETURN 'contact_role_required'; END IF;
  IF (p.outreach_profile='editorial' AND p.contact_role<>'editorial')
    OR (p.outreach_profile<>'editorial' AND p.contact_role='editorial') THEN RETURN 'campaign_role_mismatch'; END IF;
  IF cfg.outreach_identity_mode='human_reviewed' AND cfg.require_approval_outreach IS NOT true
    THEN RETURN 'human_review_required'; END IF;
  IF NULLIF(btrim(cfg.company_name),'') IS NULL OR length(cfg.company_name)>200
    OR cfg.company_name ~ '[[:cntrl:]]' THEN RETURN 'invalid_sender'; END IF;
  IF p.outreach_profile<>'legacy' THEN
    IF NOT purama_ai.partner_media_offer_valid(p.outreach_offer) THEN RETURN 'offer_required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM purama_ai.email_agent_config mail WHERE mail.user_id=p_user_id
      AND mail.is_active IS true AND lower(btrim(mail.gmail_email))=lower(btrim(cfg.sender_email))
      AND (NULLIF(btrim(mail.gmail_refresh_token),'') IS NOT NULL OR NULLIF(btrim(mail.gmail_access_token),'') IS NOT NULL))
      THEN RETURN 'reply_mailbox_required'; END IF;
  END IF;
  IF p.outreach_profile<>'legacy' AND p_step='relance_3' THEN RETURN 'media_followup_limit'; END IF;
  IF p_step<>'outreach' AND purama_ai.partner_outreach_parent(p_user_id,p_prospect_id,p_step) IS NULL
    THEN RETURN 'followup_thread_required'; END IF;
  RETURN NULL;
END;
$$;

-- The RFC identifier is bound by the reply reconciler from Resend's actual
-- receipt. Never derive it from the provider UUID or an email address.
CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_parent(p_user_id uuid,p_prospect_id uuid,p_step text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
  SELECT jsonb_build_object('message_id',d.rfc_message_id,'subject',d.payload->>'subject',
    'references',COALESCE((SELECT string_agg(prior.rfc_message_id,' ' ORDER BY prior.created_at,prior.id)
      FROM purama_ai.partner_outreach_dispatches prior WHERE prior.user_id=d.user_id
        AND prior.prospect_id=d.prospect_id AND prior.status='sent'
        AND lower(btrim(prior.recipient))=lower(btrim(d.recipient))
        AND lower(btrim(prior.payload->>'reply_to'))=lower(btrim(c.sender_email))
        AND prior.created_at<=d.created_at
        AND prior.rfc_message_id ~ '^<[^<>[:space:]@]+@[^<>[:space:]@]+>$'),d.rfc_message_id))
  FROM purama_ai.partner_outreach_dispatches d JOIN purama_ai.partner_prospects p
    ON p.id=d.prospect_id AND p.user_id=d.user_id
  JOIN purama_ai.partner_agent_config c ON c.user_id=d.user_id
  WHERE d.user_id=p_user_id AND d.prospect_id=p_prospect_id AND d.status='sent'
    AND d.step=CASE p_step WHEN 'relance_1' THEN 'outreach' WHEN 'relance_2' THEN 'relance_1' WHEN 'relance_3' THEN 'relance_2' END
    AND lower(btrim(d.recipient))=lower(btrim(p.email))
    AND lower(btrim(d.payload->>'reply_to'))=lower(btrim(c.sender_email))
    AND d.rfc_message_id ~ '^<[^<>[:space:]@]+@[^<>[:space:]@]+>$'
    AND length(d.rfc_message_id)<=900 AND NULLIF(d.payload->>'subject','') IS NOT NULL
    AND d.payload->>'subject' !~ '[[:cntrl:]]';
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_policy_context(p_user_id uuid,p_prospect_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
  SELECT jsonb_build_object('version','20261124','profile',p.outreach_profile,'role',p.contact_role,
    'qualification',p.contact_qualification,'permission',p.email_permission,'offer',p.outreach_offer,
    'identity_mode',c.outreach_identity_mode,'sender_name',c.sender_name,'sender_email',c.sender_email,
    'sender_title',c.sender_title,'company_name',c.company_name,
    'commission_first_payment',CASE WHEN p.outreach_profile='media_affiliate' THEN 30 WHEN p.outreach_profile='editorial' THEN 0 ELSE c.commission_first_payment END,
    'commission_recurring',CASE WHEN p.outreach_profile='media_affiliate' THEN 30 WHEN p.outreach_profile='editorial' THEN 0 ELSE c.commission_recurring END)
  FROM purama_ai.partner_prospects p JOIN purama_ai.partner_agent_config c ON c.user_id=p.user_id
  WHERE p.id=p_prospect_id AND p.user_id=p_user_id;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_capture_policy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
BEGIN
  IF NEW.status='preparing' THEN
    NEW.policy_snapshot := purama_ai.partner_outreach_policy_context(NEW.user_id,NEW.prospect_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS partner_outreach_capture_policy ON purama_ai.partner_outreach_dispatches;
CREATE TRIGGER partner_outreach_capture_policy BEFORE INSERT OR UPDATE OF status
  ON purama_ai.partner_outreach_dispatches FOR EACH ROW EXECUTE FUNCTION purama_ai.partner_outreach_capture_policy();

-- Replacements below retain the existing lock order and immutable-send protocol.
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
  RETURN purama_ai.partner_outreach_policy_reason(p_user_id,p_prospect_id,p_step);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_outreach_from(p_user_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
  SELECT regexp_replace(CASE WHEN outreach_identity_mode='assistant' THEN 'IAO — ' || company_name
    ELSE sender_name END, '[<>"\r\n]', '', 'g') || ' <' || btrim(sender_email) || '>'
  FROM purama_ai.partner_agent_config WHERE user_id=p_user_id;
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
  parent jsonb;
  thread_headers jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches WHERE id = p_action_id AND user_id = p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','action_not_found'); END IF;
  reason := purama_ai.partner_outreach_reason(p_user_id, action.prospect_id, action.step);
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches WHERE id = p_action_id AND user_id = p_user_id FOR UPDATE;
  IF action.status <> 'preparing' OR action.claim_token IS DISTINCT FROM p_claim_token OR action.lease_until <= now()
    THEN RETURN jsonb_build_object('status','blocked','reason','stale_claim'); END IF;
  SELECT * INTO prospect FROM purama_ai.partner_prospects WHERE id = action.prospect_id AND user_id = p_user_id;
  IF reason IS NULL AND action.recipient IS DISTINCT FROM btrim(prospect.email) THEN reason := 'recipient_changed'; END IF;
  IF reason IS NULL AND action.policy_snapshot IS DISTINCT FROM purama_ai.partner_outreach_policy_context(p_user_id,action.prospect_id) THEN reason := 'campaign_changed'; END IF;
  IF reason IS NOT NULL THEN
    UPDATE purama_ai.partner_outreach_dispatches SET status = 'blocked', updated_at = now() WHERE id = action.id;
    RETURN jsonb_build_object('status','blocked','reason',reason);
  END IF;
  IF NULLIF(btrim(p_subject),'') IS NULL OR length(p_subject) > 200 OR p_subject ~ E'[\r\n]'
    OR NULLIF(btrim(p_body_html),'') IS NULL OR length(p_body_html) > 50000 THEN RAISE EXCEPTION 'Invalid draft'; END IF;
  IF action.step<>'outreach' THEN
    parent := purama_ai.partner_outreach_parent(p_user_id,action.prospect_id,action.step);
    IF parent IS NULL THEN RETURN jsonb_build_object('status','blocked','reason','followup_thread_required'); END IF;
    p_subject := CASE WHEN parent->>'subject' ~* '^re:' THEN parent->>'subject' ELSE 'Re: ' || (parent->>'subject') END;
    thread_headers := jsonb_build_object('headers',jsonb_build_object(
      'In-Reply-To',parent->>'message_id','References',parent->>'references'));
  END IF;
  SELECT * INTO cfg FROM purama_ai.partner_agent_config WHERE user_id = p_user_id;
  new_state := CASE WHEN cfg.require_approval_outreach IS NOT false THEN 'pending_approval' ELSE 'ready' END;
  INSERT INTO purama_ai.partner_emails(user_id, prospect_id, type, subject, body_html, status)
    VALUES (p_user_id, action.prospect_id, action.step, p_subject, p_body_html,
      CASE WHEN new_state = 'pending_approval' THEN 'pending_approval' ELSE 'draft' END)
    RETURNING id INTO email_uuid;
  UPDATE purama_ai.partner_outreach_dispatches SET status = new_state, email_id = email_uuid,
    payload = jsonb_build_object(
      'from', purama_ai.partner_outreach_from(p_user_id),
      'to', action.recipient, 'subject', p_subject, 'html', p_body_html, 'reply_to', btrim(cfg.sender_email)
    ) || thread_headers, updated_at = now() WHERE id = action.id;
  RETURN purama_ai.partner_outreach_result(action.id) || jsonb_build_object('claimed',true);
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
  parent jsonb;
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
    OR action.payload->>'from' IS DISTINCT FROM purama_ai.partner_outreach_from(p_user_id))
    THEN reason := 'sender_changed'; END IF;
  IF reason IS NULL AND action.policy_snapshot IS DISTINCT FROM purama_ai.partner_outreach_policy_context(p_user_id,action.prospect_id) THEN reason := 'campaign_changed'; END IF;
  IF reason IS NULL AND action.step<>'outreach' THEN
    parent := purama_ai.partner_outreach_parent(p_user_id,action.prospect_id,action.step);
    IF parent IS NULL THEN reason := 'followup_thread_required';
    ELSIF action.payload->'headers' IS DISTINCT FROM jsonb_build_object(
      'In-Reply-To',parent->>'message_id','References',parent->>'references')
      OR action.payload->>'subject' IS DISTINCT FROM
        (CASE WHEN parent->>'subject' ~* '^re:' THEN parent->>'subject' ELSE 'Re: ' || (parent->>'subject') END)
      THEN reason := 'campaign_changed'; END IF;
  END IF;
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
    'payload',action.payload,'policy_snapshot',action.policy_snapshot,'idempotency_key','partner-outreach/' || action.id::text);
END;
$$;

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
      AND purama_ai.partner_outreach_policy_reason(p.user_id,p.id,next_step.value) IS NULL
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
    IF prospect.has_replied IS false AND cfg.is_active IS true
      AND ((action.step='outreach' AND prospect.status IN ('identified','ready_to_contact'))
        OR (action.step='relance_1' AND prospect.status='contacted')
        OR (action.step='relance_2' AND prospect.status='relance_1')
        OR (action.step='relance_3' AND prospect.status='relance_2'))
      AND NOT EXISTS (SELECT 1 FROM purama_ai.partner_outreach_suppressions
        WHERE user_id = p_user_id AND email_normalized = lower(btrim(prospect.email))) THEN
      delay_days := CASE action.step WHEN 'outreach' THEN cfg.relance_1_delay_days
        WHEN 'relance_1' THEN cfg.relance_2_delay_days ELSE cfg.relance_3_delay_days END;
      UPDATE purama_ai.partner_prospects SET
        status = CASE WHEN action.step = 'outreach' THEN 'contacted' ELSE action.step END,
        relance_count = CASE WHEN action.step = 'outreach' THEN COALESCE(relance_count, 0) ELSE right(action.step, 1)::integer END,
        next_action_at = CASE WHEN (CASE WHEN action.step='outreach' THEN 0 ELSE right(action.step,1)::integer END) >= LEAST(COALESCE(cfg.max_relances,0),CASE WHEN prospect.outreach_profile='legacy' THEN 3 ELSE 2 END) THEN NULL ELSE now() + make_interval(days => greatest(0, COALESCE(delay_days, 0))) END
        WHERE id = action.prospect_id AND user_id = p_user_id;
    END IF;
  END IF;
  RETURN jsonb_build_object('status',p_outcome,'email_id',action.email_id,
    'provider_message_id',CASE WHEN p_outcome = 'sent' THEN p_provider_message_id ELSE NULL END);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_contract_context(p_user_id uuid, p_prospect_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE cfg purama_ai.partner_agent_config%ROWTYPE; prospect purama_ai.partner_prospects%ROWTYPE; snapshot jsonb; term_key text;
BEGIN
  -- Global lock order: account, prospect, dispatch, hub.
  SELECT * INTO cfg FROM purama_ai.partner_agent_config WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('reason','config_missing'); END IF;
  SELECT * INTO prospect FROM purama_ai.partner_prospects WHERE id=p_prospect_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('reason','prospect_not_found'); END IF;
  IF cfg.is_active IS NOT TRUE THEN RETURN jsonb_build_object('reason','agent_inactive'); END IF;
  IF prospect.status='rejected' OR EXISTS (SELECT 1 FROM purama_ai.partner_outreach_suppressions
    WHERE user_id=p_user_id AND email_normalized=lower(btrim(prospect.email)))
    THEN RETURN jsonb_build_object('reason','contact_suppressed'); END IF;
  IF NULLIF(btrim(prospect.name),'') IS NULL OR length(prospect.name)>200 OR prospect.name ~ E'[\r\n]'
    OR prospect.email IS NULL OR btrim(prospect.email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR length(prospect.email)>254 THEN RETURN jsonb_build_object('reason','invalid_recipient'); END IF;
  IF NULLIF(btrim(cfg.sender_name),'') IS NULL OR length(cfg.sender_name)>200 OR cfg.sender_name ~ E'[\r\n]'
    OR NULLIF(btrim(cfg.company_name),'') IS NULL OR length(cfg.company_name)>200
    OR cfg.sender_email IS NULL OR btrim(cfg.sender_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR length(cfg.sender_email)>254 THEN RETURN jsonb_build_object('reason','invalid_sender'); END IF;
  IF prospect.outreach_profile='editorial' THEN RETURN jsonb_build_object('reason','editorial_contract_not_applicable'); END IF;
  IF prospect.outreach_profile='legacy' AND (cfg.commission_first_payment IS NULL OR cfg.commission_first_payment NOT BETWEEN 0 AND 100
    OR cfg.commission_recurring IS NULL OR cfg.commission_recurring NOT BETWEEN 0 AND 100
    ) THEN RETURN jsonb_build_object('reason','invalid_terms'); END IF;
  snapshot := jsonb_build_object(
    'recipient_name',btrim(prospect.name),'recipient_email',lower(btrim(prospect.email)),
    'sender_name',btrim(cfg.sender_name),'sender_email',lower(btrim(cfg.sender_email)),
    'sender_title',coalesce(cfg.sender_title,''),'company_name',btrim(cfg.company_name),
    'signature_name',coalesce(cfg.signature_name,cfg.sender_name),
    'signature_title',coalesce(cfg.signature_title,cfg.sender_title,''),
    'signature_image_url',cfg.signature_image_url,
    'commission_first_payment',cfg.commission_first_payment,'commission_recurring',cfg.commission_recurring);
  IF prospect.outreach_profile='media_affiliate' THEN
    IF prospect.contact_role NOT IN ('commercial','creator','venue')
      THEN RETURN jsonb_build_object('reason','campaign_role_mismatch'); END IF;
    IF NOT purama_ai.partner_media_offer_valid(prospect.outreach_offer)
      THEN RETURN jsonb_build_object('reason','media_contract_offer_invalid'); END IF;
    FOREACH term_key IN ARRAY ARRAY['products_and_countries','attribution','recurrence','payment','refunds','duration_termination','content_rights','costs','disputes','parties_identity'] LOOP
      IF jsonb_typeof(cfg.media_contract_terms->term_key) IS DISTINCT FROM 'string'
        OR length(btrim(cfg.media_contract_terms->>term_key))<10 THEN RETURN jsonb_build_object('reason','media_contract_terms_incomplete'); END IF;
      IF length(cfg.media_contract_terms->>term_key)>2000
        OR regexp_replace(cfg.media_contract_terms->>term_key,E'[\t\r\n]','','g') ~ '[[:cntrl:]]'
        THEN RETURN jsonb_build_object('reason','media_contract_terms_invalid'); END IF;
    END LOOP;
    IF (SELECT count(*) FROM jsonb_object_keys(cfg.media_contract_terms))<>10
      THEN RETURN jsonb_build_object('reason','media_contract_terms_invalid'); END IF;
    snapshot := snapshot || jsonb_build_object('outreach_profile','media_affiliate','media_terms_version','20261124',
      'commission_first_payment',30,'commission_recurring',30,'eligible_offer',prospect.outreach_offer,
      'media_contract_terms',cfg.media_contract_terms);
  END IF;
  RETURN jsonb_build_object('snapshot',snapshot);
END $$;

REVOKE ALL ON FUNCTION purama_ai.partner_outreach_from(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_parent(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_public_url_valid(text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_media_offer_valid(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_contract_context(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.partner_contract_context(uuid,uuid) TO service_role;

REVOKE ALL ON FUNCTION purama_ai.partner_outreach_policy_reason(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_policy_context(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_outreach_capture_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_guard_qualification_fields() FROM PUBLIC, anon, authenticated;
COMMIT;
