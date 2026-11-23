-- Exact-document approval and at-most-one dispatch for generated partner contracts.
-- The existing contracts hub remains the contract identity and signer/event store.
BEGIN;

CREATE TABLE purama_ai.partner_contract_dispatches (
  contract_id uuid PRIMARY KEY REFERENCES purama_ai.contracts(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('preparing','pending_approval','sending','sent','unknown','failed','blocked')),
  claim_token uuid NOT NULL,
  approval_version uuid NOT NULL DEFAULT gen_random_uuid(),
  snapshot jsonb NOT NULL,
  storage_path text,
  pdf_sha256 text CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$'),
  signature_area jsonb,
  reason text,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 3),
  lease_until timestamptz,
  approved_at timestamptz,
  approved_by uuid REFERENCES auth.users(id),
  dispatch_started_at timestamptz,
  submission_started_at timestamptz,
  signing_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, prospect_id),
  CHECK (status NOT IN ('pending_approval','sending','sent') OR
    (storage_path IS NOT NULL AND pdf_sha256 IS NOT NULL AND signature_area IS NOT NULL)),
  CHECK (status NOT IN ('sending','sent') OR (approved_at IS NOT NULL AND approved_by = user_id))
);
ALTER TABLE purama_ai.partner_contract_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.partner_contract_dispatches FROM PUBLIC, anon, authenticated;
GRANT ALL ON purama_ai.partner_contract_dispatches TO service_role;
CREATE INDEX partner_contract_recipient_history ON purama_ai.partner_contract_dispatches
  (user_id, (lower(snapshot->>'recipient_email')));

-- These private objects are never overwritten. Only the service stores or signs PDFs.
INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('partner-contracts','partner-contracts',false,5242880,ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE SET public = false;

CREATE FUNCTION purama_ai.partner_contract_context(p_user_id uuid, p_prospect_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE cfg purama_ai.partner_agent_config%ROWTYPE; prospect purama_ai.partner_prospects%ROWTYPE;
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
  IF cfg.commission_first_payment IS NULL OR cfg.commission_first_payment NOT BETWEEN 0 AND 100
    OR cfg.commission_recurring IS NULL OR cfg.commission_recurring NOT BETWEEN 0 AND 100
    THEN RETURN jsonb_build_object('reason','invalid_terms'); END IF;
  RETURN jsonb_build_object('snapshot',jsonb_build_object(
    'recipient_name',btrim(prospect.name),'recipient_email',lower(btrim(prospect.email)),
    'sender_name',btrim(cfg.sender_name),'sender_email',lower(btrim(cfg.sender_email)),
    'sender_title',coalesce(cfg.sender_title,''),'company_name',btrim(cfg.company_name),
    'signature_name',coalesce(cfg.signature_name,cfg.sender_name),
    'signature_title',coalesce(cfg.signature_title,cfg.sender_title,''),
    'signature_image_url',cfg.signature_image_url,
    'commission_first_payment',cfg.commission_first_payment,'commission_recurring',cfg.commission_recurring));
END $$;

CREATE FUNCTION purama_ai.partner_contract_result(p_user_id uuid, p_prospect_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE d purama_ai.partner_contract_dispatches%ROWTYPE; c purama_ai.contracts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM purama_ai.partner_contract_dispatches WHERE user_id=p_user_id AND prospect_id=p_prospect_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','contract_not_prepared'); END IF;
  SELECT * INTO c FROM purama_ai.contracts WHERE id=d.contract_id AND user_id=p_user_id;
  RETURN jsonb_build_object('contract_id',d.contract_id,'status',CASE
      WHEN d.status='sending' AND d.lease_until<now() THEN 'unknown'
      WHEN d.status='preparing' AND d.lease_until<now() THEN 'failed'
      WHEN d.status='pending_approval' AND d.lease_until<now() THEN 'blocked' ELSE d.status END,'claimed',false,
    'reason',CASE WHEN d.lease_until<now() THEN CASE d.status
      WHEN 'sending' THEN 'reconciliation_required' WHEN 'preparing' THEN 'preparation_expired'
      WHEN 'pending_approval' THEN 'approval_expired' ELSE d.reason END ELSE d.reason END,'approval_version',d.approval_version,'pdf_sha256',d.pdf_sha256,
    'storage_path',d.storage_path,'signature_area',d.signature_area,'snapshot',d.snapshot,
    'docuseal_submission_id',c.docuseal_submission_id,'signing_url',d.signing_url);
END $$;

CREATE FUNCTION purama_ai.partner_contract_reserve(p_user_id uuid, p_prospect_id uuid, p_claim_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE ctx jsonb; d purama_ai.partner_contract_dispatches%ROWTYPE; prospect purama_ai.partner_prospects%ROWTYPE; cid uuid;
BEGIN
  ctx := purama_ai.partner_contract_context(p_user_id,p_prospect_id);
  IF ctx ? 'reason' THEN RETURN jsonb_build_object('status','blocked','reason',ctx->>'reason'); END IF;
  SELECT * INTO d FROM purama_ai.partner_contract_dispatches WHERE user_id=p_user_id AND prospect_id=p_prospect_id FOR UPDATE;
  IF FOUND THEN
    IF d.status='sending' AND d.lease_until<now() THEN
      UPDATE purama_ai.partner_contract_dispatches SET status='unknown',reason='reconciliation_required',updated_at=now() WHERE contract_id=d.contract_id;
    ELSIF d.status='preparing' AND d.lease_until<now() THEN
      UPDATE purama_ai.partner_contract_dispatches SET status='failed',reason='preparation_expired',updated_at=now() WHERE contract_id=d.contract_id;
      d.status := 'failed';
    ELSIF d.status='pending_approval' AND d.lease_until<now() THEN
      UPDATE purama_ai.partner_contract_dispatches SET status='blocked',reason='approval_expired',updated_at=now() WHERE contract_id=d.contract_id;
      d.status := 'blocked';
    END IF;
    IF d.status IN ('failed','blocked') AND d.dispatch_started_at IS NULL AND d.attempts<3 THEN
      SELECT * INTO prospect FROM purama_ai.partner_prospects WHERE id=p_prospect_id AND user_id=p_user_id;
      IF prospect.status<>'interested' OR prospect.contract_sent_at IS NOT NULL OR prospect.contract_signed_at IS NOT NULL
        THEN RETURN jsonb_build_object('status','blocked','reason','previous_attempt_requires_review'); END IF;
      INSERT INTO purama_ai.contract_events(contract_id,event_type,payload,actor_id,actor_type)
      VALUES(d.contract_id,'created',jsonb_build_object('previous_approval_version',d.approval_version,
        'previous_pdf_sha256',d.pdf_sha256,'reason','preparation_replaced'),p_user_id,'user');
      UPDATE purama_ai.partner_contract_dispatches SET status='preparing',claim_token=p_claim_token,
        approval_version=gen_random_uuid(),snapshot=ctx->'snapshot',storage_path=NULL,pdf_sha256=NULL,
        signature_area=NULL,reason=NULL,attempts=attempts+1,lease_until=now()+interval '2 minutes',
        approved_at=NULL,approved_by=NULL,updated_at=now() WHERE contract_id=d.contract_id;
      UPDATE purama_ai.contract_signers SET email=ctx->'snapshot'->>'recipient_email',name=ctx->'snapshot'->>'recipient_name'
        WHERE contract_id=d.contract_id;
      RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id)||jsonb_build_object('claimed',true);
    END IF;
    RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id);
  END IF;
  SELECT * INTO prospect FROM purama_ai.partner_prospects WHERE id=p_prospect_id AND user_id=p_user_id;
  IF prospect.status<>'interested' OR prospect.contract_sent_at IS NOT NULL OR prospect.contract_signed_at IS NOT NULL
    OR NULLIF(btrim(prospect.contract_url),'') IS NOT NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','previous_attempt_requires_review');
  END IF;
  IF EXISTS (SELECT 1 FROM purama_ai.partner_contract_dispatches WHERE user_id=p_user_id
    AND lower(snapshot->>'recipient_email')=ctx->'snapshot'->>'recipient_email') THEN
    RETURN jsonb_build_object('status','blocked','reason','previous_attempt_requires_review'); END IF;
  INSERT INTO purama_ai.contracts(user_id,app_slug,template_slug,status,metadata)
  VALUES(p_user_id,'purama_ai','partner-generated','draft',jsonb_build_object('partner_prospect_id',p_prospect_id)) RETURNING id INTO cid;
  INSERT INTO purama_ai.contract_signers(contract_id,email,name,role)
  VALUES(cid,ctx->'snapshot'->>'recipient_email',ctx->'snapshot'->>'recipient_name','business_partner');
  INSERT INTO purama_ai.contract_events(contract_id,event_type,payload,actor_id,actor_type)
  VALUES(cid,'created',jsonb_build_object('source','partner-agent','prospect_id',p_prospect_id),p_user_id,'user');
  INSERT INTO purama_ai.partner_contract_dispatches(contract_id,user_id,prospect_id,status,claim_token,snapshot,lease_until)
  VALUES(cid,p_user_id,p_prospect_id,'preparing',p_claim_token,ctx->'snapshot',now()+interval '2 minutes');
  RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id)||jsonb_build_object('claimed',true);
END $$;

CREATE FUNCTION purama_ai.partner_contract_save(p_user_id uuid,p_prospect_id uuid,p_claim_token uuid,
  p_approval_version uuid,p_pdf_sha256 text,p_storage_path text,p_signature_area jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE ctx jsonb; d purama_ai.partner_contract_dispatches%ROWTYPE;
BEGIN
  ctx := purama_ai.partner_contract_context(p_user_id,p_prospect_id);
  SELECT * INTO d FROM purama_ai.partner_contract_dispatches WHERE user_id=p_user_id AND prospect_id=p_prospect_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','contract_not_prepared'); END IF;
  IF d.status<>'preparing' OR d.claim_token<>p_claim_token OR d.approval_version<>p_approval_version OR d.lease_until<now()
    THEN RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id); END IF;
  IF ctx ? 'reason' OR ctx->'snapshot' IS DISTINCT FROM d.snapshot THEN
    UPDATE purama_ai.partner_contract_dispatches SET status='blocked',reason=coalesce(ctx->>'reason','context_changed'),updated_at=now() WHERE contract_id=d.contract_id;
    RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id); END IF;
  IF p_pdf_sha256 IS NULL OR p_pdf_sha256 !~ '^[0-9a-f]{64}$'
    OR p_storage_path IS DISTINCT FROM (p_user_id::text||'/'||d.contract_id::text||'/'||d.approval_version::text||'.pdf')
    OR jsonb_typeof(p_signature_area) IS DISTINCT FROM 'object'
    OR NOT (p_signature_area ?& ARRAY['x','y','w','h','page']) THEN RAISE EXCEPTION 'Invalid document proof'; END IF;
  UPDATE purama_ai.partner_contract_dispatches SET status='pending_approval',pdf_sha256=p_pdf_sha256,
    storage_path=p_storage_path,signature_area=p_signature_area,lease_until=now()+interval '24 hours',updated_at=now()
    WHERE contract_id=d.contract_id;
  UPDATE purama_ai.contracts SET pdf_storage_path='partner-contracts/'||p_storage_path,
    metadata=metadata||jsonb_build_object('approval_version',d.approval_version,'pdf_sha256',p_pdf_sha256)
    WHERE id=d.contract_id AND user_id=p_user_id;
  RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id);
END $$;

CREATE FUNCTION purama_ai.partner_contract_claim(p_user_id uuid,p_prospect_id uuid,p_claim_token uuid,
  p_approval_version uuid,p_pdf_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE ctx jsonb; d purama_ai.partner_contract_dispatches%ROWTYPE; prospect purama_ai.partner_prospects%ROWTYPE;
BEGIN
  ctx := purama_ai.partner_contract_context(p_user_id,p_prospect_id);
  SELECT * INTO d FROM purama_ai.partner_contract_dispatches WHERE user_id=p_user_id AND prospect_id=p_prospect_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','contract_not_prepared'); END IF;
  IF d.status='sending' AND d.lease_until<now() THEN
    UPDATE purama_ai.partner_contract_dispatches SET status='unknown',reason='reconciliation_required',updated_at=now() WHERE contract_id=d.contract_id;
  END IF;
  IF d.status<>'pending_approval' THEN RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id); END IF;
  IF d.approval_version<>p_approval_version OR d.pdf_sha256 IS DISTINCT FROM p_pdf_sha256 THEN
    RETURN jsonb_build_object('status','blocked','reason','stale_approval','contract_id',d.contract_id); END IF;
  SELECT * INTO prospect FROM purama_ai.partner_prospects WHERE id=p_prospect_id AND user_id=p_user_id;
  IF ctx ? 'reason' OR ctx->'snapshot' IS DISTINCT FROM d.snapshot OR prospect.status<>'interested'
    OR prospect.contract_sent_at IS NOT NULL OR prospect.contract_signed_at IS NOT NULL OR d.lease_until<now()
    OR NOT EXISTS(SELECT 1 FROM purama_ai.contracts WHERE id=d.contract_id AND user_id=p_user_id AND status='draft') THEN
    UPDATE purama_ai.partner_contract_dispatches SET status='blocked',reason=coalesce(ctx->>'reason',
      CASE WHEN d.lease_until<now() THEN 'approval_expired' ELSE 'context_changed' END),updated_at=now() WHERE contract_id=d.contract_id;
    RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id); END IF;
  -- Even a later change to require_approval_contract cannot approve a frozen PDF.
  UPDATE purama_ai.partner_contract_dispatches SET status='sending',claim_token=p_claim_token,
    approved_at=now(),approved_by=p_user_id,dispatch_started_at=now(),lease_until=now()+interval '2 minutes',
    updated_at=now() WHERE contract_id=d.contract_id;
  INSERT INTO purama_ai.contract_events(contract_id,event_type,payload,actor_id,actor_type)
  VALUES(d.contract_id,'created',jsonb_build_object('action','approved','approval_version',d.approval_version,'pdf_sha256',d.pdf_sha256),p_user_id,'user');
  RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id)||jsonb_build_object('claimed',true);
END $$;

-- The provider template call can take time. Recheck the mandate at the actual
-- submission boundary and allow that boundary to be crossed once only.
CREATE FUNCTION purama_ai.partner_contract_begin_submission(p_user_id uuid,p_prospect_id uuid,p_claim_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE ctx jsonb; d purama_ai.partner_contract_dispatches%ROWTYPE; prospect purama_ai.partner_prospects%ROWTYPE;
BEGIN
  ctx := purama_ai.partner_contract_context(p_user_id,p_prospect_id);
  SELECT * INTO d FROM purama_ai.partner_contract_dispatches WHERE user_id=p_user_id AND prospect_id=p_prospect_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','contract_not_prepared'); END IF;
  IF d.status<>'sending' OR d.claim_token<>p_claim_token OR d.submission_started_at IS NOT NULL THEN
    RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id); END IF;
  SELECT * INTO prospect FROM purama_ai.partner_prospects WHERE id=p_prospect_id AND user_id=p_user_id;
  IF ctx ? 'reason' OR ctx->'snapshot' IS DISTINCT FROM d.snapshot OR prospect.status<>'interested'
    OR prospect.contract_sent_at IS NOT NULL OR prospect.contract_signed_at IS NOT NULL OR d.lease_until<now()
    OR NOT EXISTS(SELECT 1 FROM purama_ai.contracts WHERE id=d.contract_id AND user_id=p_user_id AND status='draft') THEN
    UPDATE purama_ai.partner_contract_dispatches SET status='blocked',reason=coalesce(ctx->>'reason','context_changed'),updated_at=now() WHERE contract_id=d.contract_id;
    RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id); END IF;
  UPDATE purama_ai.partner_contract_dispatches SET submission_started_at=now(),updated_at=now() WHERE contract_id=d.contract_id;
  RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id)||jsonb_build_object('claimed',true);
END $$;

CREATE FUNCTION purama_ai.partner_contract_finish(p_user_id uuid,p_prospect_id uuid,p_claim_token uuid,
  p_outcome text,p_submission_id bigint,p_submitter_id bigint,p_template_id bigint,p_signing_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
DECLARE d purama_ai.partner_contract_dispatches%ROWTYPE;
BEGIN
  PERFORM 1 FROM purama_ai.partner_agent_config WHERE user_id=p_user_id FOR UPDATE;
  PERFORM 1 FROM purama_ai.partner_prospects WHERE id=p_prospect_id AND user_id=p_user_id FOR UPDATE;
  SELECT * INTO d FROM purama_ai.partner_contract_dispatches WHERE user_id=p_user_id AND prospect_id=p_prospect_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','contract_not_prepared'); END IF;
  IF d.claim_token<>p_claim_token OR d.status NOT IN ('preparing','sending','unknown')
    THEN RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id); END IF;
  IF p_outcome='failed' AND d.status='preparing' THEN
    UPDATE purama_ai.partner_contract_dispatches SET status='failed',reason='preparation_failed',updated_at=now() WHERE contract_id=d.contract_id;
  ELSIF p_outcome='sent' AND d.status IN ('sending','unknown') AND d.submission_started_at IS NOT NULL AND p_submission_id>0 AND p_submitter_id>0 AND p_template_id>0 THEN
    UPDATE purama_ai.contracts SET status='sent',docuseal_submission_id=p_submission_id,
      docuseal_template_id=p_template_id,sent_at=now() WHERE id=d.contract_id AND user_id=p_user_id AND status='draft';
    IF NOT FOUND THEN RAISE EXCEPTION 'Contract changed before receipt'; END IF;
    UPDATE purama_ai.contract_signers SET docuseal_submitter_id=p_submitter_id
      WHERE contract_id=d.contract_id AND lower(email)=d.snapshot->>'recipient_email';
    IF NOT FOUND THEN RAISE EXCEPTION 'Contract signer missing'; END IF;
    UPDATE purama_ai.partner_contract_dispatches SET status='sent',signing_url=p_signing_url,reason=NULL,updated_at=now() WHERE contract_id=d.contract_id;
    UPDATE purama_ai.partner_prospects SET contract_sent_at=coalesce(contract_sent_at,now()),
      status=CASE WHEN status='interested' THEN 'contract_sent' ELSE status END
      WHERE id=p_prospect_id AND user_id=p_user_id;
    INSERT INTO purama_ai.contract_events(contract_id,event_type,payload,actor_id,actor_type)
    VALUES(d.contract_id,'sent',jsonb_build_object('submission_id',p_submission_id,'submitter_id',p_submitter_id,
      'approval_version',d.approval_version,'pdf_sha256',d.pdf_sha256),p_user_id,'user');
  ELSIF p_outcome='unknown' AND d.status IN ('sending','unknown') THEN
    UPDATE purama_ai.partner_contract_dispatches SET status='unknown',reason='reconciliation_required',updated_at=now() WHERE contract_id=d.contract_id;
  ELSE RAISE EXCEPTION 'Invalid dispatch transition'; END IF;
  RETURN purama_ai.partner_contract_result(p_user_id,p_prospect_id);
END $$;

-- Keep the existing partner pipeline/reporting consistent with the hub's verified
-- signing lifecycle. Replayed webhook updates do not overwrite timestamps/status.
CREATE FUNCTION purama_ai.partner_contract_project_signature()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, purama_ai AS $$
BEGIN
  IF NEW.status='signed' AND NEW.signed_at IS NOT NULL AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE purama_ai.partner_prospects p SET contract_signed_at=coalesce(p.contract_signed_at,NEW.signed_at),
      status=CASE WHEN p.status='contract_sent' THEN 'contract_signed' ELSE p.status END
    FROM purama_ai.partner_contract_dispatches d
    WHERE d.contract_id=NEW.id AND d.user_id=NEW.user_id AND d.prospect_id=p.id AND d.user_id=p.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_contract_project_signature AFTER UPDATE OF status ON purama_ai.contracts
FOR EACH ROW EXECUTE FUNCTION purama_ai.partner_contract_project_signature();

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='purama_ai' AND p.proname IN ('partner_contract_context','partner_contract_result',
    'partner_contract_reserve','partner_contract_save','partner_contract_claim','partner_contract_begin_submission','partner_contract_finish','partner_contract_project_signature')
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f); END LOOP;
END $$;
COMMIT;
