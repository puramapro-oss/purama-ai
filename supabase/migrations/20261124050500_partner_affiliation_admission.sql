-- Preserve a signed media agreement for admission to the existing ONE engine.
-- This is an evidence dossier, never an affiliate, commission or payment order.
-- No historical contract, policy, beneficiary or financial table is changed.
BEGIN;

CREATE TABLE purama_ai.partner_affiliation_admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL REFERENCES purama_ai.partner_prospects(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL UNIQUE REFERENCES purama_ai.contracts(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE purama_ai.partner_affiliation_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.partner_affiliation_admissions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON purama_ai.partner_affiliation_admissions TO authenticated, service_role;
CREATE POLICY "Owners read partner affiliation admissions" ON purama_ai.partner_affiliation_admissions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE INDEX partner_affiliation_admissions_owner ON purama_ai.partner_affiliation_admissions(user_id, created_at DESC);

-- Candidate visibility follows the signed agreement, never the mutable prospect
-- profile/status. This projection exposes no private dispatch or contract body;
-- admission_prepare remains the complete evidence and authorization check.
CREATE FUNCTION purama_ai.partner_affiliation_candidates(p_page integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  owner_id uuid := auth.uid();
  result jsonb;
BEGIN
  IF owner_id IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','authentication_required');
  END IF;
  IF p_page IS NULL OR p_page NOT BETWEEN 0 AND 100000 THEN
    RETURN jsonb_build_object('status','blocked','reason','invalid_page');
  END IF;
  WITH bounded AS MATERIALIZED (
    SELECT p.id,COALESCE(NULLIF(btrim(d.snapshot->>'recipient_name'),''),p.name) AS name,c.signed_at
    FROM purama_ai.partner_contract_dispatches d
    JOIN purama_ai.contracts c ON c.id=d.contract_id AND c.user_id=owner_id
    JOIN purama_ai.partner_prospects p ON p.id=d.prospect_id AND p.user_id=owner_id
    WHERE d.user_id=owner_id AND d.snapshot->>'outreach_profile'='media_affiliate'
      AND c.app_slug='purama_ai' AND c.template_slug='partner-generated' AND c.status='signed'
      AND c.signed_at IS NOT NULL AND isfinite(c.signed_at) AND c.signed_at<=clock_timestamp()
      AND c.cancelled_at IS NULL
    ORDER BY c.signed_at DESC,p.id ASC LIMIT 26 OFFSET p_page*25
  ), page_rows AS (
    SELECT * FROM bounded ORDER BY signed_at DESC,id ASC LIMIT 25
  )
  SELECT jsonb_build_object('status','ready','user_id',owner_id,
    'candidates',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'user_id',owner_id,
      'name',name,'contract_signed_at',signed_at) ORDER BY signed_at DESC,id ASC) FROM page_rows),'[]'::jsonb),
    'has_more',(SELECT count(*)>25 FROM bounded)) INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION purama_ai.partner_affiliation_candidates(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION purama_ai.partner_affiliation_candidates(integer) TO authenticated;

CREATE FUNCTION purama_ai.partner_affiliation_admission_prepare(p_prospect_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE
  owner_id uuid := auth.uid();
  d purama_ai.partner_contract_dispatches%ROWTYPE;
  c purama_ai.contracts%ROWTYPE;
  admission purama_ai.partner_affiliation_admissions%ROWTYPE;
  approved_event purama_ai.contract_events%ROWTYPE;
  sent_event purama_ai.contract_events%ROWTYPE;
  signed_event purama_ai.contract_events%ROWTYPE;
  signer purama_ai.contract_signers%ROWTYPE;
  signer_snapshot jsonb;
  candidate jsonb;
  term_key text;
  was_inserted boolean;
  integration jsonb := jsonb_build_object(
    'status','requirements_missing',
    'missing',jsonb_build_array('beneficiary_identity','tenant_mapping','catalog_binding','executable_policy',
      'verified_attribution','provider_settlement','one_runtime','payout_runtime'),
    'activation_allowed',false,'payment_allowed',false,
    'one_revision','a5fed2edaaa2332c0e9aba3321d9ee32cf89a17e');
BEGIN
  IF owner_id IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','authentication_required','integration',integration);
  END IF;
  -- Ownership is derived from the session, never supplied as a request field.
  IF NOT EXISTS (SELECT 1 FROM purama_ai.partner_prospects WHERE id=p_prospect_id AND user_id=owner_id) THEN
    RETURN jsonb_build_object('status','blocked','reason','prospect_not_found','integration',integration);
  END IF;
  -- Match the established dispatch -> hub lock order. No prospect lock is held
  -- while the hub's signing trigger may update that prospect.
  SELECT * INTO d FROM purama_ai.partner_contract_dispatches
    WHERE user_id=owner_id AND prospect_id=p_prospect_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','blocked','reason','contract_not_prepared','integration',integration);
  END IF;
  IF d.snapshot->>'outreach_profile' IS DISTINCT FROM 'media_affiliate' THEN
    RETURN jsonb_build_object('status','blocked','reason','media_contract_required','integration',integration);
  END IF;
  IF d.snapshot->>'media_terms_version' IS DISTINCT FROM '20261124'
    OR d.snapshot->'commission_first_payment' IS DISTINCT FROM '30'::jsonb
    OR d.snapshot->'commission_recurring' IS DISTINCT FROM '30'::jsonb
    OR octet_length(d.snapshot::text)>131072
    OR NOT purama_ai.partner_media_offer_valid(d.snapshot->'eligible_offer')
    OR jsonb_typeof(d.snapshot->'media_contract_terms') IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status','blocked','reason','media_contract_snapshot_invalid','integration',integration);
  END IF;
  FOREACH term_key IN ARRAY ARRAY['parties_identity','products_and_countries','attribution','recurrence','payment',
    'refunds','duration_termination','content_rights','costs','disputes'] LOOP
    IF jsonb_typeof(d.snapshot->'media_contract_terms'->term_key) IS DISTINCT FROM 'string'
      OR length(btrim(d.snapshot->'media_contract_terms'->>term_key)) NOT BETWEEN 10 AND 2000
      OR regexp_replace(d.snapshot->'media_contract_terms'->>term_key,E'[\t\r\n]','','g') ~ '[[:cntrl:]]' THEN
      RETURN jsonb_build_object('status','blocked','reason','media_contract_snapshot_invalid','integration',integration);
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_object_keys(d.snapshot->'media_contract_terms'))<>10 THEN
    RETURN jsonb_build_object('status','blocked','reason','media_contract_snapshot_invalid','integration',integration);
  END IF;
  SELECT * INTO c FROM purama_ai.contracts WHERE id=d.contract_id AND user_id=owner_id FOR SHARE;
  IF NOT FOUND OR c.app_slug<>'purama_ai' OR c.template_slug<>'partner-generated' THEN
    RETURN jsonb_build_object('status','blocked','reason','contract_source_mismatch','integration',integration);
  END IF;
  IF c.status<>'signed' OR c.signed_at IS NULL OR NOT isfinite(c.signed_at) OR c.signed_at>clock_timestamp()
    OR c.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','signed_contract_required','integration',integration);
  END IF;
  IF d.status<>'sent' OR d.approved_by IS DISTINCT FROM owner_id OR d.approved_at IS NULL
    OR NOT isfinite(d.approved_at) OR d.approved_at>clock_timestamp()
    OR d.dispatch_started_at IS NULL OR d.submission_started_at IS NULL
    OR d.dispatch_started_at<d.approved_at OR d.submission_started_at<d.dispatch_started_at
    OR c.signed_at<d.submission_started_at OR c.sent_at IS NULL OR c.sent_at<d.submission_started_at
    OR c.sent_at>c.signed_at OR c.docuseal_submission_id IS NULL OR c.docuseal_submission_id<=0
    OR c.docuseal_template_id IS NULL OR c.docuseal_template_id<=0
    OR d.pdf_sha256 IS NULL OR d.pdf_sha256 !~ '^[0-9a-f]{64}$'
    OR d.storage_path IS DISTINCT FROM (owner_id::text||'/'||c.id::text||'/'||d.approval_version::text||'.pdf')
    OR c.pdf_storage_path IS DISTINCT FROM ('partner-contracts/'||d.storage_path)
    OR c.metadata->>'partner_prospect_id' IS DISTINCT FROM p_prospect_id::text
    OR c.metadata->>'approval_version' IS DISTINCT FROM d.approval_version::text
    OR c.metadata->>'pdf_sha256' IS DISTINCT FROM d.pdf_sha256 THEN
    RETURN jsonb_build_object('status','blocked','reason','contract_source_mismatch','integration',integration);
  END IF;
  -- Read only identity/completion evidence. IPs, user agents and signature image
  -- URLs are not needed for admission and are not copied into a new dossier.
  PERFORM 1 FROM purama_ai.contract_signers WHERE contract_id=c.id ORDER BY id FOR SHARE;
  IF (SELECT count(*) FROM purama_ai.contract_signers WHERE contract_id=c.id) NOT BETWEEN 1 AND 20
    OR EXISTS (SELECT 1 FROM purama_ai.contract_signers WHERE contract_id=c.id AND
      (signed IS NOT TRUE OR signed_at IS NULL OR NOT isfinite(signed_at) OR signed_at>clock_timestamp()
       OR signed_at<d.submission_started_at OR declined_at IS NOT NULL
       OR docuseal_submitter_id IS NULL OR docuseal_submitter_id<=0))
    OR (SELECT count(*)<>count(DISTINCT docuseal_submitter_id) FROM purama_ai.contract_signers WHERE contract_id=c.id)
    OR (SELECT count(*) FROM purama_ai.contract_signers WHERE contract_id=c.id AND role='business_partner')<>1 THEN
    RETURN jsonb_build_object('status','blocked','reason','signature_evidence_required','integration',integration);
  END IF;
  SELECT * INTO signer FROM purama_ai.contract_signers WHERE contract_id=c.id AND role='business_partner';
  IF lower(btrim(signer.email)) IS DISTINCT FROM d.snapshot->>'recipient_email'
    OR signer.name IS DISTINCT FROM d.snapshot->>'recipient_name' THEN
    RETURN jsonb_build_object('status','blocked','reason','contract_source_mismatch','integration',integration);
  END IF;
  SELECT * INTO approved_event FROM purama_ai.contract_events
    WHERE contract_id=c.id AND event_type='created' AND actor_type='user' AND actor_id=owner_id
      AND payload->>'action'='approved' AND payload->>'approval_version'=d.approval_version::text
      AND payload->>'pdf_sha256'=d.pdf_sha256 AND created_at>=d.approved_at AND created_at<=clock_timestamp()
    ORDER BY created_at,id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','blocked','reason','approval_evidence_required','integration',integration);
  END IF;
  SELECT * INTO sent_event FROM purama_ai.contract_events
    WHERE contract_id=c.id AND event_type='sent' AND actor_type='user' AND actor_id=owner_id
      AND payload->>'approval_version'=d.approval_version::text AND payload->>'pdf_sha256'=d.pdf_sha256
      AND payload->'submission_id'=to_jsonb(c.docuseal_submission_id)
      AND payload->'submitter_id'=to_jsonb(signer.docuseal_submitter_id)
      AND created_at>=d.submission_started_at AND created_at>=approved_event.created_at AND created_at<=clock_timestamp()
    ORDER BY created_at,id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','blocked','reason','dispatch_evidence_required','integration',integration);
  END IF;
  SELECT * INTO signed_event FROM purama_ai.contract_events
    WHERE contract_id=c.id AND event_type='signed' AND actor_id IS NULL AND actor_type IS NULL
      AND (NOT (payload ? 'partial') OR payload->'partial'='false'::jsonb)
      AND created_at>=sent_event.created_at AND created_at<=clock_timestamp()
    ORDER BY created_at,id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','blocked','reason','signature_evidence_required','integration',integration);
  END IF;
  SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'email',lower(btrim(email)),
      'role',role,'provider_submitter_id',docuseal_submitter_id) ORDER BY id)
    INTO signer_snapshot FROM purama_ai.contract_signers WHERE contract_id=c.id;
  candidate := jsonb_build_object(
    'schema_version',1,'source','purama_ai_signed_media_contract','owner_id',owner_id,
    'prospect_id',p_prospect_id,'contract_id',c.id,'contract_snapshot',d.snapshot,
    'document',jsonb_build_object('approval_version',d.approval_version,'approved_pdf_sha256',d.pdf_sha256,
      'storage_path','partner-contracts/'||d.storage_path,'approved_at',d.approved_at,'approved_by',d.approved_by),
    'signature',jsonb_build_object('provider','docuseal','submission_id',c.docuseal_submission_id,
      'template_id',c.docuseal_template_id,'recorded_at',signed_event.created_at,'signers',signer_snapshot),
    'evidence',jsonb_build_object('approval_event_id',approved_event.id,'dispatch_event_id',sent_event.id,
      'signature_event_id',signed_event.id,'source','authenticated_contract_hub'),
    'beneficiary_id',NULL,'financial_authority','none','integration',integration);
  -- Replayed provider deliveries may refresh hub signed_at. The first complete
  -- immutable audit event identifies the admitted signature, not a retry time.
  INSERT INTO purama_ai.partner_affiliation_admissions(user_id,prospect_id,contract_id,snapshot)
    VALUES(owner_id,p_prospect_id,c.id,candidate) ON CONFLICT(contract_id) DO NOTHING RETURNING * INTO admission;
  was_inserted := FOUND;
  IF NOT was_inserted THEN
    SELECT * INTO admission FROM purama_ai.partner_affiliation_admissions WHERE contract_id=c.id FOR SHARE;
    IF NOT FOUND OR admission.user_id<>owner_id OR admission.prospect_id<>p_prospect_id
      OR admission.version<>1 OR admission.snapshot IS DISTINCT FROM candidate THEN
      RETURN jsonb_build_object('status','blocked','reason','admission_source_changed','integration',integration);
    END IF;
  END IF;
  RETURN jsonb_build_object('status','prepared','reused',NOT was_inserted,
    'admission',to_jsonb(admission),'integration',integration);
END $$;

REVOKE ALL ON FUNCTION purama_ai.partner_affiliation_admission_prepare(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION purama_ai.partner_affiliation_admission_prepare(uuid) TO authenticated;
COMMENT ON TABLE purama_ai.partner_affiliation_admissions IS
  'Immutable owner-readable admission dossiers derived from signed media contracts. No affiliation activation, commission or payment authority.';
COMMENT ON FUNCTION purama_ai.partner_affiliation_admission_prepare(uuid) IS
  'Prepare or recover the same signed-contract admission dossier; preserve the original snapshot and explicitly report the missing ONE integration requirements.';
NOTIFY pgrst,'reload schema';
COMMIT;
