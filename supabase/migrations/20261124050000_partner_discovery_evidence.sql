-- Search evidence describes what was observed, never consent or sender approval.
-- Existing prospects, contracts and manual workflows are preserved.
ALTER TABLE purama_ai.partner_prospects
  ADD COLUMN IF NOT EXISTS contact_role text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS contact_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='partner_contact_role_valid'
    AND conrelid='purama_ai.partner_prospects'::regclass) THEN
    ALTER TABLE purama_ai.partner_prospects ADD CONSTRAINT partner_contact_role_valid
      CHECK (contact_role IN ('unknown','editorial','commercial','creator','venue'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='partner_contact_evidence_object'
    AND conrelid='purama_ai.partner_prospects'::regclass) THEN
    ALTER TABLE purama_ai.partner_prospects ADD CONSTRAINT partner_contact_evidence_object
      CHECK (jsonb_typeof(contact_evidence)='object');
  END IF;
END;
$$;

-- Only the authenticated server adapter can select p_user_id. The lock serializes
-- imports for this account. It does not claim to serialize every manual write.
CREATE OR REPLACE FUNCTION purama_ai.partner_discovery_import(p_user_id uuid, p_prospects jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE
  v_input jsonb;
  v_email text;
  v_name text;
  v_website text;
  v_role text;
  v_type text;
  v_evidence jsonb;
  v_row purama_ai.partner_prospects%ROWTYPE;
  v_prospects jsonb := '[]'::jsonb;
  v_inserted integer := 0;
  v_skipped integer := 0;
BEGIN
  IF p_user_id IS NULL OR p_prospects IS NULL OR jsonb_typeof(p_prospects) <> 'array' THEN
    RAISE EXCEPTION 'discovery_batch_invalid' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_prospects)>25 OR octet_length(p_prospects::text)>131072 THEN
    RAISE EXCEPTION 'discovery_batch_too_large' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('partner-discovery:' || p_user_id::text, 0));

  FOR v_input IN SELECT value FROM jsonb_array_elements(p_prospects) LOOP
    v_name := nullif(btrim(v_input->>'name'),'');
    v_email := lower(nullif(btrim(v_input->>'email'),''));
    v_website := nullif(btrim(v_input->>'website'),'');
    v_role := coalesce(v_input->>'contact_role','unknown');
    v_type := coalesce(v_input->>'type','other');
    v_evidence := coalesce(v_input->'contact_evidence','{}'::jsonb);
    IF jsonb_typeof(v_input)<>'object' OR v_name IS NULL OR length(v_name)>200
      OR v_role NOT IN ('unknown','editorial','commercial','creator','venue')
      OR v_type NOT IN ('influencer','website','association','media','commerce','other')
      OR jsonb_typeof(v_evidence)<>'object' OR octet_length(v_evidence::text)>8192
      OR (v_website IS NOT NULL AND (length(v_website)>2000 OR v_website !~ '^https?://'))
      OR (v_input->'social_links' IS NOT NULL AND jsonb_typeof(v_input->'social_links')<>'object') THEN
      RAISE EXCEPTION 'discovery_candidate_invalid' USING ERRCODE='22023';
    END IF;
    IF v_email IS NOT NULL AND (length(v_email)>254 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      OR v_evidence->>'verification' IS DISTINCT FROM 'observed_in_search_result'
      OR lower(v_evidence->>'email') IS DISTINCT FROM v_email
      OR nullif(v_evidence->>'source_url','') IS NULL
      OR nullif(v_evidence->>'observed_at','') IS NULL
      OR position(v_email IN lower(coalesce(v_evidence->>'excerpt','')))=0) THEN
      RAISE EXCEPTION 'discovery_email_evidence_required' USING ERRCODE='22023';
    END IF;

    IF EXISTS (SELECT 1 FROM purama_ai.partner_prospects p
      WHERE p.user_id=p_user_id AND (
        (v_email IS NOT NULL AND lower(btrim(p.email))=v_email)
        OR (v_email IS NULL AND p.email IS NULL AND lower(btrim(p.name))=lower(v_name)
          AND p.website IS NOT DISTINCT FROM v_website AND p.contact_role=v_role)
      )) THEN
      v_skipped := v_skipped+1;
      CONTINUE;
    END IF;
    BEGIN
      INSERT INTO purama_ai.partner_prospects
        (user_id,name,email,website,social_links,type,niche,followers_count,ai_score,ai_reasoning,
          source,found_by_ai,status,contact_role,contact_evidence)
      VALUES (p_user_id,v_name,v_email,v_website,coalesce(v_input->'social_links','{}'::jsonb),v_type,
        left(v_input->>'niche',200), (v_input->>'followers_count')::integer,
        greatest(0,least(100,coalesce((v_input->>'ai_score')::integer,0))),left(v_input->>'ai_reasoning',500),
        'ai_search',true,'identified',v_role,v_evidence)
      RETURNING * INTO v_row;
      v_prospects := v_prospects || jsonb_build_array(to_jsonb(v_row));
      v_inserted := v_inserted+1;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent ordinary insert can still hit the existing exact-email key.
      v_skipped := v_skipped+1;
    END;
  END LOOP;
  IF v_inserted>0 THEN
    UPDATE purama_ai.partner_agent_config
      SET total_prospects_found=coalesce(total_prospects_found,0)+v_inserted
      WHERE user_id=p_user_id;
  END IF;
  RETURN jsonb_build_object('inserted',v_inserted,'skipped',v_skipped,'prospects',v_prospects);
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.partner_discovery_import(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.partner_discovery_import(uuid,jsonb) TO service_role;

COMMENT ON COLUMN purama_ai.partner_prospects.contact_evidence IS
  'Observed search evidence and timestamp; never proof of opt-in, official role or mailbox deliverability.';
