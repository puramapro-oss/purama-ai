-- The contact mandate remains current through reservation, PDF approval and
-- the last boundary before DocuSeal sends an invitation. Reading the immutable
-- result of an existing/signed contract does not call this context function.
BEGIN;

CREATE OR REPLACE FUNCTION purama_ai.partner_contract_context(p_user_id uuid, p_prospect_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE cfg purama_ai.partner_agent_config%ROWTYPE; prospect purama_ai.partner_prospects%ROWTYPE; snapshot jsonb; term_key text;
BEGIN
  -- Preserve the established lock order: account, prospect, dispatch, hub.
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
    -- A changed ordinary email field is not a qualification of that new address.
    -- A withdrawal need not become a permanent suppression to stop this send.
    IF prospect.contact_qualification->>'email' IS DISTINCT FROM lower(btrim(prospect.email))
      OR prospect.contact_qualification->>'qualified_by' IS DISTINCT FROM p_user_id::text
      OR NOT purama_ai.partner_public_url_valid(prospect.contact_qualification->>'source_url',false)
      THEN RETURN jsonb_build_object('reason','contact_qualification_required'); END IF;
    IF prospect.email_permission->>'status' IS DISTINCT FROM 'explicit_opt_in'
      OR prospect.email_permission->>'email' IS DISTINCT FROM lower(btrim(prospect.email))
      OR COALESCE(length(btrim(prospect.email_permission->>'reference')),0)<10
      THEN RETURN jsonb_build_object('reason','provider_opt_in_required'); END IF;
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

REVOKE ALL ON FUNCTION purama_ai.partner_contract_context(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.partner_contract_context(uuid,uuid) TO service_role;
COMMIT;
