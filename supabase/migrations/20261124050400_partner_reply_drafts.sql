-- A verified partner reply joins the existing Email Agent approval and dispatch
-- protocol. This adds no sender, scheduler, negotiation mandate or payment path.
BEGIN;

CREATE TABLE IF NOT EXISTS purama_ai.partner_reply_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  gmail_message_id text NOT NULL,
  -- Deliberately no FK to mutable email logs: delete/reimport cannot erase a guard.
  log_id uuid NOT NULL,
  intent text NOT NULL CHECK (intent IN ('request_details','share_offer','existing')),
  policy_snapshot jsonb NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,gmail_message_id),
  UNIQUE(user_id,log_id)
);
ALTER TABLE purama_ai.partner_reply_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.partner_reply_drafts FROM PUBLIC,anon,authenticated;
GRANT ALL ON purama_ai.partner_reply_drafts TO service_role;

-- Shared lock order: Email advisory -> partner config -> mailbox -> prospect.
-- The existing Email routines re-enter the same advisory before their log locks.
CREATE OR REPLACE FUNCTION purama_ai.partner_reply_draft_context(
  p_user_id uuid,p_prospect_id uuid,p_gmail_message_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE
  cfg purama_ai.partner_agent_config%ROWTYPE;
  mail purama_ai.email_agent_config%ROWTYPE;
  prospect purama_ai.partner_prospects%ROWTYPE;
  receipt purama_ai.partner_reply_receipts%ROWTYPE;
  outbound purama_ai.partner_outreach_dispatches%ROWTYPE;
  reason text;
BEGIN
  IF p_user_id IS NULL OR p_prospect_id IS NULL OR p_gmail_message_id IS NULL
    OR length(p_gmail_message_id) NOT BETWEEN 1 AND 512
    OR p_gmail_message_id !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN jsonb_build_object('status','blocked','reason','invalid_reply_identity');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('email-agent-send:'||p_user_id::text,0));
  SELECT * INTO cfg FROM purama_ai.partner_agent_config WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR cfg.is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('status','blocked','reason','agent_inactive'); END IF;
  SELECT * INTO mail FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR mail.is_active IS NOT TRUE OR mail.updated_at IS NULL
    OR NULLIF(btrim(mail.gmail_email),'') IS NULL THEN
    RETURN jsonb_build_object('status','blocked','reason','reply_mailbox_required'); END IF;
  SELECT * INTO prospect FROM purama_ai.partner_prospects
    WHERE id=p_prospect_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','prospect_not_found'); END IF;
  IF prospect.status IN ('rejected','inactive') OR EXISTS (
    SELECT 1 FROM purama_ai.partner_outreach_suppressions s WHERE s.user_id=p_user_id
      AND s.email_normalized=lower(btrim(prospect.email))) THEN
    RETURN jsonb_build_object('status','blocked','reason','contact_suppressed'); END IF;
  IF prospect.outreach_profile NOT IN ('media_affiliate','editorial') THEN
    RETURN jsonb_build_object('status','blocked','reason','media_profile_required'); END IF;
  reason:=purama_ai.partner_outreach_policy_reason(p_user_id,p_prospect_id,'outreach');
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked','reason',reason); END IF;
  IF prospect.has_replied IS NOT TRUE OR prospect.reply_gmail_message_id IS DISTINCT FROM p_gmail_message_id
    OR prospect.reply_kind IS DISTINCT FROM 'human' THEN
    RETURN jsonb_build_object('status','blocked','reason','latest_human_reply_required'); END IF;
  SELECT * INTO receipt FROM purama_ai.partner_reply_receipts
    WHERE user_id=p_user_id AND prospect_id=p_prospect_id AND gmail_message_id=p_gmail_message_id;
  IF NOT FOUND OR receipt.kind<>'human'
    OR receipt.gmail_thread_id IS DISTINCT FROM prospect.reply_gmail_thread_id
    OR receipt.received_at IS DISTINCT FROM prospect.reply_received_at THEN
    RETURN jsonb_build_object('status','blocked','reason','reply_receipt_changed'); END IF;
  IF EXISTS(SELECT 1 FROM purama_ai.partner_reply_receipts later
    WHERE later.user_id=p_user_id AND later.prospect_id=p_prospect_id
      AND later.id<>receipt.id AND later.received_at>=receipt.received_at) THEN
    RETURN jsonb_build_object('status','blocked','reason','latest_human_reply_required'); END IF;
  SELECT * INTO outbound FROM purama_ai.partner_outreach_dispatches
    WHERE id=receipt.action_id AND user_id=p_user_id AND prospect_id=p_prospect_id;
  IF NOT FOUND OR outbound.status<>'sent' OR outbound.rfc_message_id IS NULL
    OR NULLIF(btrim(outbound.provider_message_id),'') IS NULL
    OR lower(btrim(outbound.recipient)) IS DISTINCT FROM lower(btrim(prospect.email))
    OR lower(btrim(outbound.payload->>'reply_to')) IS DISTINCT FROM lower(btrim(mail.gmail_email)) THEN
    RETURN jsonb_build_object('status','blocked','reason','reply_proof_changed'); END IF;
  IF EXISTS(SELECT 1 FROM unnest(COALESCE(mail.excluded_emails,'{}'::text[])) e
      WHERE lower(btrim(e))=lower(btrim(prospect.email)))
    OR EXISTS(SELECT 1 FROM unnest(COALESCE(mail.excluded_domains,'{}'::text[])) d
      WHERE lower(btrim(d))=lower(split_part(prospect.email,'@',2)))
    OR EXISTS(SELECT 1 FROM purama_ai.email_agent_memory m WHERE m.user_id=p_user_id
      AND lower(btrim(m.contact_email))=lower(btrim(prospect.email)) AND m.is_blocked IS TRUE) THEN
    RETURN jsonb_build_object('status','blocked','reason','recipient_blocked'); END IF;
  RETURN jsonb_build_object('status','ready',
    'prospect',jsonb_build_object('id',prospect.id,'name',prospect.name,'email',prospect.email,
      'outreach_profile',prospect.outreach_profile,'contact_role',prospect.contact_role,
      'contact_qualification',prospect.contact_qualification,'outreach_offer',prospect.outreach_offer),
    'config',jsonb_build_object('company_name',cfg.company_name),
    'policy_snapshot',purama_ai.partner_outreach_policy_context(p_user_id,p_prospect_id),
    'receipt',jsonb_build_object('id',receipt.id,'gmail_message_id',receipt.gmail_message_id,
      'gmail_thread_id',receipt.gmail_thread_id,'rfc_message_id',receipt.rfc_message_id,
      'received_at',receipt.received_at,'kind',receipt.kind),
    'outbound',jsonb_build_object('action_id',outbound.id,'prospect_id',outbound.prospect_id,
      'provider_message_id',outbound.provider_message_id,'recipient',outbound.recipient,
      'sender',outbound.payload->>'from','reply_to',outbound.payload->>'reply_to',
      'subject',outbound.payload->>'subject','sent_at',outbound.dispatch_started_at,
      'rfc_message_id',outbound.rfc_message_id,'reply_scan_page_token',NULL),
    'connection_email',mail.gmail_email,'connection_updated_at',mail.updated_at);
END $$;

CREATE OR REPLACE FUNCTION purama_ai.partner_reply_draft_save(
  p_user_id uuid,p_prospect_id uuid,p_gmail_message_id text,p_receipt_id uuid,
  p_policy_snapshot jsonb,p_connection_email text,p_connection_updated_at timestamptz,
  p_intent text,p_subject text,p_body text,p_received_subject text,p_received_body text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE
  context jsonb; item purama_ai.email_agent_logs%ROWTYPE;
  binding purama_ai.partner_reply_drafts%ROWTYPE; existing boolean:=false;
BEGIN
  context:=purama_ai.partner_reply_draft_context(p_user_id,p_prospect_id,p_gmail_message_id);
  IF context->>'status'<>'ready' THEN RETURN context; END IF;
  IF (context->'receipt'->>'id')::uuid IS DISTINCT FROM p_receipt_id
    OR context->'policy_snapshot' IS DISTINCT FROM p_policy_snapshot
    OR context->>'connection_email' IS DISTINCT FROM p_connection_email
    OR (context->>'connection_updated_at')::timestamptz IS DISTINCT FROM p_connection_updated_at THEN
    RETURN jsonb_build_object('status','blocked','reason','reply_context_changed'); END IF;
  IF p_intent IS NULL OR p_intent NOT IN ('request_details','share_offer')
    OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 998 OR p_subject ~ '[[:cntrl:]]'
    OR p_body IS NULL OR length(btrim(p_body)) NOT BETWEEN 1 AND 12000
    OR regexp_replace(p_body,E'[\t\r\n]','','g') ~ '[[:cntrl:]]'
    OR p_received_subject IS NULL OR length(p_received_subject) NOT BETWEEN 1 AND 998
    OR p_received_subject ~ '[[:cntrl:]]'
    OR p_received_body IS NULL OR octet_length(p_received_body)>65536 THEN
    RETURN jsonb_build_object('status','blocked','reason','invalid_reply_draft'); END IF;
  SELECT * INTO binding FROM purama_ai.partner_reply_drafts
    WHERE user_id=p_user_id AND gmail_message_id=p_gmail_message_id FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO item FROM purama_ai.email_agent_logs WHERE id=binding.log_id AND user_id=p_user_id FOR UPDATE;
    IF item.user_approved IS FALSE THEN
      RETURN jsonb_build_object('status','blocked','reason','reply_draft_rejected'); END IF;
    IF item.id IS NULL OR binding.receipt_id<>p_receipt_id OR binding.policy_snapshot IS DISTINCT FROM p_policy_snapshot
      OR binding.payload IS DISTINCT FROM purama_ai.email_agent_send_payload(item) THEN
      RETURN jsonb_build_object('status','blocked','reason','partner_reply_draft_changed'); END IF;
    RETURN jsonb_build_object('status','existing','log_id',item.id,'intent',binding.intent);
  END IF;
  SELECT * INTO item FROM purama_ai.email_agent_logs
    WHERE user_id=p_user_id AND gmail_message_id=p_gmail_message_id FOR UPDATE;
  IF FOUND THEN
    IF item.user_approved IS FALSE THEN
      RETURN jsonb_build_object('status','blocked','reason','reply_draft_rejected'); END IF;
    -- A different producer's draft is retained byte for byte. Binding it only
    -- permits the same explicit preview/review, never an unattended send.
    IF item.action_taken<>'draft' OR item.user_approved IS NOT NULL
      OR item.gmail_thread_id IS DISTINCT FROM (context->'receipt'->>'gmail_thread_id')
      OR lower(btrim(item.from_email)) IS DISTINCT FROM lower(btrim(context->'prospect'->>'email'))
      OR NULLIF(btrim(item.ai_response),'') IS NULL OR length(item.ai_response)>12000
      OR EXISTS(SELECT 1 FROM purama_ai.email_agent_dispatches d
        WHERE d.user_id=p_user_id AND d.gmail_message_id=p_gmail_message_id) THEN
      RETURN jsonb_build_object('status','blocked','reason','existing_reply_requires_review','log_id',item.id); END IF;
    existing:=true;
  ELSE
    -- A removed log is not permission to restart an old provider attempt.
    IF EXISTS(SELECT 1 FROM purama_ai.email_agent_dispatches d
      WHERE d.user_id=p_user_id AND d.gmail_message_id=p_gmail_message_id) THEN
      RETURN jsonb_build_object('status','blocked','reason','previous_reply_requires_review'); END IF;
    INSERT INTO purama_ai.email_agent_logs(user_id,gmail_message_id,gmail_thread_id,from_email,from_name,
      to_email,subject,body_preview,received_at,category,intention,tags,action_taken,
      ai_subject,ai_response,ai_reasoning,user_approved,created_at)
      VALUES(p_user_id,p_gmail_message_id,context->'receipt'->>'gmail_thread_id',
        context->'prospect'->>'email',context->'prospect'->>'name',p_connection_email,
        p_received_subject,p_received_body,(context->'receipt'->>'received_at')::timestamptz,
        'partenariat',p_intent,ARRAY['partner_reply'],'draft',p_subject,p_body,
        'Proposition factuelle liée au reçu partenaire vérifié ; approbation explicite requise.',NULL,clock_timestamp())
      ON CONFLICT(user_id,gmail_message_id) DO NOTHING RETURNING * INTO item;
    IF item.id IS NULL THEN
      RETURN jsonb_build_object('status','blocked','reason','existing_reply_requires_review'); END IF;
  END IF;
  INSERT INTO purama_ai.partner_reply_drafts(user_id,prospect_id,receipt_id,gmail_message_id,
    log_id,intent,policy_snapshot,payload)
    VALUES(p_user_id,p_prospect_id,p_receipt_id,p_gmail_message_id,item.id,
      CASE WHEN existing THEN 'existing' ELSE p_intent END,p_policy_snapshot,purama_ai.email_agent_send_payload(item));
  IF NOT existing THEN UPDATE purama_ai.email_agent_config SET total_drafted=COALESCE(total_drafted,0)+1
    WHERE user_id=p_user_id; END IF;
  RETURN jsonb_build_object('status',CASE WHEN existing THEN 'existing' ELSE 'prepared' END,
    'log_id',item.id,'intent',CASE WHEN existing THEN 'existing' ELSE p_intent END);
END $$;

-- Resolve by the immutable receipt as well as the log. A client-writable tag
-- or a deleted/reimported log cannot turn a partner reply into an unguarded mail.
CREATE OR REPLACE FUNCTION purama_ai.partner_reply_email_guard(p_user_id uuid,p_log_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE
  item purama_ai.email_agent_logs%ROWTYPE; binding purama_ai.partner_reply_drafts%ROWTYPE;
  context jsonb; direct_guard jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('email-agent-send:'||p_user_id::text,0));
  SELECT * INTO item FROM purama_ai.email_agent_logs WHERE id=p_log_id AND user_id=p_user_id;
  SELECT * INTO binding FROM purama_ai.partner_reply_drafts WHERE user_id=p_user_id
    AND (log_id=p_log_id OR gmail_message_id=item.gmail_message_id) LIMIT 1;
  IF NOT FOUND THEN
    -- Match ordinary Email lock order before inspecting mutable recipient/thread
    -- fields. A fresh log or changed parent must not bypass the shared classifier.
    PERFORM 1 FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
    SELECT * INTO item FROM purama_ai.email_agent_logs WHERE id=p_log_id AND user_id=p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF to_regprocedure('purama_ai.partner_direct_send_guard(uuid,text,text,text)') IS NULL THEN
      RETURN 'partner_send_guard_unavailable'; END IF;
    -- 506 distinguishes protected media/editorial conversations from ordinary
    -- legacy correspondence, while retaining opposition across every profile.
    direct_guard:=purama_ai.partner_direct_send_guard(p_user_id,item.from_email,item.gmail_message_id,item.gmail_thread_id);
    IF direct_guard->>'status'='allowed' AND direct_guard->'reason'='null'::jsonb THEN RETURN NULL; END IF;
    IF direct_guard->>'status'='blocked'
      AND direct_guard->>'reason' IN ('partner_reply_preparation_required','contact_suppressed','invalid_send_identity') THEN
      RETURN direct_guard->>'reason'; END IF;
    RETURN 'partner_send_guard_unavailable';
  END IF;
  context:=purama_ai.partner_reply_draft_context(p_user_id,binding.prospect_id,binding.gmail_message_id);
  IF context->>'status'<>'ready' THEN RETURN context->>'reason'; END IF;
  -- Lock the log only after partner/mailbox/prospect locks, matching preparation.
  SELECT * INTO item FROM purama_ai.email_agent_logs WHERE id=p_log_id AND user_id=p_user_id FOR UPDATE;
  IF item.id IS NULL OR binding.log_id<>item.id OR binding.gmail_message_id<>item.gmail_message_id
    OR (context->'receipt'->>'id')::uuid IS DISTINCT FROM binding.receipt_id
    OR context->'policy_snapshot' IS DISTINCT FROM binding.policy_snapshot
    OR purama_ai.email_agent_send_payload(item) IS DISTINCT FROM binding.payload THEN
    RETURN 'partner_reply_draft_changed'; END IF;
  RETURN NULL;
END $$;

-- Preserve the exact existing approval implementation behind private names.
DO $$ BEGIN
  IF to_regprocedure('purama_ai.email_agent_draft_preview_before_partner(uuid,uuid)') IS NULL THEN
    ALTER FUNCTION purama_ai.email_agent_draft_preview(uuid,uuid) RENAME TO email_agent_draft_preview_before_partner;
  END IF;
  IF to_regprocedure('purama_ai.email_agent_draft_approve_before_partner(uuid,uuid,uuid,text)') IS NULL THEN
    ALTER FUNCTION purama_ai.email_agent_draft_approve(uuid,uuid,uuid,text) RENAME TO email_agent_draft_approve_before_partner;
  END IF;
  IF to_regprocedure('purama_ai.email_agent_send_reserve_before_partner(uuid,uuid,uuid,uuid)') IS NULL THEN
    ALTER FUNCTION purama_ai.email_agent_send_reserve(uuid,uuid,uuid,uuid) RENAME TO email_agent_send_reserve_before_partner;
  END IF;
  IF to_regprocedure('purama_ai.email_agent_send_begin_before_partner(uuid,uuid,uuid,text,timestamp with time zone)') IS NULL THEN
    ALTER FUNCTION purama_ai.email_agent_send_begin(uuid,uuid,uuid,text,timestamptz) RENAME TO email_agent_send_begin_before_partner;
  END IF;
END $$;
REVOKE ALL ON FUNCTION purama_ai.email_agent_draft_preview_before_partner(uuid,uuid),
  purama_ai.email_agent_draft_approve_before_partner(uuid,uuid,uuid,text),
  purama_ai.email_agent_send_reserve_before_partner(uuid,uuid,uuid,uuid),
  purama_ai.email_agent_send_begin_before_partner(uuid,uuid,uuid,text,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION purama_ai.email_agent_draft_preview(p_user_id uuid,p_log_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE reason text; BEGIN
  reason:=purama_ai.partner_reply_email_guard(p_user_id,p_log_id);
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked','reason',reason); END IF;
  RETURN purama_ai.email_agent_draft_preview_before_partner(p_user_id,p_log_id);
END $$;
CREATE OR REPLACE FUNCTION purama_ai.email_agent_draft_approve(
  p_user_id uuid,p_log_id uuid,p_approval_id uuid,p_feedback text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE reason text; BEGIN
  reason:=purama_ai.partner_reply_email_guard(p_user_id,p_log_id);
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked','reason',reason); END IF;
  RETURN purama_ai.email_agent_draft_approve_before_partner(p_user_id,p_log_id,p_approval_id,p_feedback);
END $$;
CREATE OR REPLACE FUNCTION purama_ai.email_agent_send_reserve(
  p_user_id uuid,p_log_id uuid,p_claim_token uuid,p_approval_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE reason text; BEGIN
  reason:=purama_ai.partner_reply_email_guard(p_user_id,p_log_id);
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked','reason',reason,'claimed',false); END IF;
  RETURN purama_ai.email_agent_send_reserve_before_partner(p_user_id,p_log_id,p_claim_token,p_approval_id);
END $$;
CREATE OR REPLACE FUNCTION purama_ai.email_agent_send_begin(
  p_user_id uuid,p_action_id uuid,p_claim_token uuid,p_connection_email text,p_connection_updated_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE invalid_reason text; log_key uuid; BEGIN
  SELECT log_id INTO log_key FROM purama_ai.email_agent_dispatches WHERE id=p_action_id AND user_id=p_user_id;
  invalid_reason:=purama_ai.partner_reply_email_guard(p_user_id,log_key);
  IF invalid_reason IS NOT NULL THEN
    UPDATE purama_ai.email_agent_dispatches SET status='blocked',reason=invalid_reason,updated_at=clock_timestamp()
      WHERE id=p_action_id AND user_id=p_user_id AND claim_token=p_claim_token AND status='preparing';
    RETURN jsonb_build_object('status','blocked','reason',invalid_reason,'claimed',false);
  END IF;
  RETURN purama_ai.email_agent_send_begin_before_partner(p_user_id,p_action_id,p_claim_token,p_connection_email,p_connection_updated_at);
END $$;

REVOKE ALL ON FUNCTION purama_ai.partner_reply_draft_context(uuid,uuid,text),
  purama_ai.partner_reply_draft_save(uuid,uuid,text,uuid,jsonb,text,timestamptz,text,text,text,text,text),
  purama_ai.partner_reply_email_guard(uuid,uuid),
  purama_ai.email_agent_draft_preview(uuid,uuid),
  purama_ai.email_agent_draft_approve(uuid,uuid,uuid,text),
  purama_ai.email_agent_send_reserve(uuid,uuid,uuid,uuid),
  purama_ai.email_agent_send_begin(uuid,uuid,uuid,text,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.partner_reply_draft_context(uuid,uuid,text),
  purama_ai.partner_reply_draft_save(uuid,uuid,text,uuid,jsonb,text,timestamptz,text,text,text,text,text),
  purama_ai.email_agent_draft_preview(uuid,uuid),
  purama_ai.email_agent_draft_approve(uuid,uuid,uuid,text),
  purama_ai.email_agent_send_reserve(uuid,uuid,uuid,uuid),
  purama_ai.email_agent_send_begin(uuid,uuid,uuid,text,timestamptz) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
