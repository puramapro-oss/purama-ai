-- Provider-proven reply matching; no historic rows or partner contracts are rewritten.
BEGIN;

ALTER TABLE purama_ai.partner_outreach_dispatches
  ADD COLUMN IF NOT EXISTS rfc_message_id text,
  ADD COLUMN IF NOT EXISTS reply_scan_page_token text,
  ADD COLUMN IF NOT EXISTS last_reply_scan_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_provider_event text;
ALTER TABLE purama_ai.partner_prospects
  ADD COLUMN IF NOT EXISTS reply_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_gmail_message_id text,
  ADD COLUMN IF NOT EXISTS reply_gmail_thread_id text,
  ADD COLUMN IF NOT EXISTS reply_kind text;

CREATE TABLE IF NOT EXISTS purama_ai.partner_reply_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL,
  action_id uuid NOT NULL REFERENCES purama_ai.partner_outreach_dispatches(id),
  gmail_message_id text NOT NULL,
  gmail_thread_id text NOT NULL,
  rfc_message_id text NOT NULL,
  received_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('human','refusal','automatic')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, gmail_message_id),
  UNIQUE(user_id, rfc_message_id)
);
ALTER TABLE purama_ai.partner_reply_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.partner_reply_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON purama_ai.partner_reply_receipts TO authenticated;
GRANT ALL ON purama_ai.partner_reply_receipts TO service_role;
DROP POLICY IF EXISTS "Users read own partner reply receipts" ON purama_ai.partner_reply_receipts;
CREATE POLICY "Users read own partner reply receipts" ON purama_ai.partner_reply_receipts
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS partner_reply_scan_queue
  ON purama_ai.partner_outreach_dispatches(user_id, last_reply_scan_at, created_at)
  WHERE status = 'sent';

-- Account and connection are checked again after all external reads. Lock order
-- remains config -> connection -> prospect -> dispatch; outreach uses the same
-- config -> prospect -> dispatch order. Service-only; never a client assertion.
CREATE OR REPLACE FUNCTION purama_ai.partner_reply_lock(
  p_user_id uuid, p_action_id uuid, p_connection_email text, p_connection_updated_at timestamptz
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE
  cfg purama_ai.partner_agent_config%ROWTYPE;
  mail purama_ai.email_agent_config%ROWTYPE;
  prospect purama_ai.partner_prospects%ROWTYPE;
  action purama_ai.partner_outreach_dispatches%ROWTYPE;
BEGIN
  SELECT * INTO cfg FROM purama_ai.partner_agent_config WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR cfg.is_active IS NOT TRUE THEN RETURN 'agent_inactive'; END IF;
  SELECT * INTO mail FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR mail.is_active IS NOT TRUE
    OR lower(btrim(mail.gmail_email)) IS DISTINCT FROM lower(btrim(p_connection_email))
    OR mail.updated_at IS DISTINCT FROM p_connection_updated_at
    THEN RETURN 'connection_changed'; END IF;
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches
    WHERE id=p_action_id AND user_id=p_user_id;
  IF NOT FOUND THEN RETURN 'action_not_found'; END IF;
  SELECT * INTO prospect FROM purama_ai.partner_prospects
    WHERE id=action.prospect_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'prospect_not_found'; END IF;
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches
    WHERE id=p_action_id AND user_id=p_user_id FOR UPDATE;
  IF action.status IS DISTINCT FROM 'sent' OR NULLIF(btrim(action.provider_message_id),'') IS NULL
    THEN RETURN 'send_not_confirmed'; END IF;
  IF lower(btrim(prospect.email)) IS DISTINCT FROM lower(btrim(action.recipient))
    THEN RETURN 'recipient_changed'; END IF;
  IF lower(btrim(action.payload->>'reply_to')) IS DISTINCT FROM lower(btrim(mail.gmail_email))
    THEN RETURN 'reply_mailbox_mismatch'; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_reply_candidates(p_user_id uuid, p_limit integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE mail purama_ai.email_agent_config%ROWTYPE; result jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>10 THEN
    RETURN jsonb_build_object('status','blocked','reason','invalid_limit');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM purama_ai.partner_agent_config WHERE user_id=p_user_id AND is_active=true)
    THEN RETURN jsonb_build_object('status','blocked','reason','agent_inactive'); END IF;
  SELECT * INTO mail FROM purama_ai.email_agent_config WHERE user_id=p_user_id AND is_active=true;
  IF NOT FOUND OR NULLIF(btrim(mail.gmail_email),'') IS NULL OR mail.updated_at IS NULL
    THEN RETURN jsonb_build_object('status','blocked','reason','connection_unavailable'); END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(c)),'[]'::jsonb) INTO result FROM (
    SELECT d.id AS action_id,d.prospect_id,d.provider_message_id,d.recipient,
      d.payload->>'from' AS sender,d.payload->>'reply_to' AS reply_to,
      d.payload->>'subject' AS subject,d.dispatch_started_at AS sent_at,
      d.rfc_message_id,d.reply_scan_page_token
    FROM purama_ai.partner_outreach_dispatches d
    JOIN purama_ai.partner_prospects p ON p.id=d.prospect_id AND p.user_id=d.user_id
    WHERE d.user_id=p_user_id AND d.status='sent' AND d.dispatch_started_at IS NOT NULL
      AND NULLIF(btrim(d.provider_message_id),'') IS NOT NULL
      AND p.status IN ('contacted','relance_1','relance_2','relance_3','interested','contract_sent','contract_signed','active')
      AND lower(btrim(p.email))=lower(btrim(d.recipient))
      AND lower(btrim(d.payload->>'reply_to'))=lower(btrim(mail.gmail_email))
      AND NOT EXISTS(SELECT 1 FROM purama_ai.partner_outreach_suppressions s
        WHERE s.user_id=d.user_id AND s.email_normalized=lower(btrim(d.recipient)))
    ORDER BY d.last_reply_scan_at ASC NULLS FIRST,d.created_at,d.id LIMIT p_limit
  ) c;
  RETURN jsonb_build_object('status','ready','connection_email',mail.gmail_email,
    'connection_updated_at',mail.updated_at,'candidates',result);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_reply_bind_outbound(
  p_user_id uuid,p_action_id uuid,p_provider_message_id text,p_rfc_message_id text,
  p_provider_event text,p_connection_email text,p_connection_updated_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE reason text; action purama_ai.partner_outreach_dispatches%ROWTYPE;
BEGIN
  reason:=purama_ai.partner_reply_lock(p_user_id,p_action_id,p_connection_email,p_connection_updated_at);
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked','reason',reason); END IF;
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches WHERE id=p_action_id AND user_id=p_user_id;
  IF action.provider_message_id IS DISTINCT FROM p_provider_message_id
    OR p_rfc_message_id IS NULL OR length(p_rfc_message_id)>900
    OR p_rfc_message_id !~ '^<[^<>[:space:]@]+@[^<>[:space:]@]+>$'
    OR (action.rfc_message_id IS NOT NULL AND action.rfc_message_id<>p_rfc_message_id)
    THEN RETURN jsonb_build_object('status','blocked','reason','provider_proof_mismatch'); END IF;
  UPDATE purama_ai.partner_outreach_dispatches SET rfc_message_id=p_rfc_message_id WHERE id=action.id;
  IF p_provider_event IN ('bounced','complained') THEN
    INSERT INTO purama_ai.partner_outreach_suppressions(user_id,email_normalized)
      VALUES(p_user_id,lower(btrim(action.recipient))) ON CONFLICT DO NOTHING;
    UPDATE purama_ai.partner_prospects SET next_action_at=NULL,
      status=CASE WHEN status IN ('contacted','relance_1','relance_2','relance_3','interested')
        THEN CASE WHEN p_provider_event='complained' THEN 'rejected' ELSE 'inactive' END ELSE status END
      WHERE id=action.prospect_id AND user_id=p_user_id;
    UPDATE purama_ai.partner_emails SET bounced=CASE WHEN p_provider_event='bounced' THEN true ELSE bounced END
      WHERE id=action.email_id AND user_id=p_user_id;
    UPDATE purama_ai.partner_outreach_dispatches SET reply_provider_event=p_provider_event,last_reply_scan_at=now()
      WHERE id=action.id;
    RETURN jsonb_build_object('status','suppressed','reason',p_provider_event,
      'changed',action.reply_provider_event IS DISTINCT FROM p_provider_event);
  END IF;
  RETURN jsonb_build_object('status','bound','rfc_message_id',p_rfc_message_id);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_reply_record(
  p_user_id uuid,p_action_id uuid,p_gmail_message_id text,p_gmail_thread_id text,
  p_rfc_message_id text,p_sender_email text,p_received_at timestamptz,
  p_parent_message_id text,p_kind text,p_connection_email text,p_connection_updated_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE reason text; action purama_ai.partner_outreach_dispatches%ROWTYPE; receipt uuid;
BEGIN
  reason:=purama_ai.partner_reply_lock(p_user_id,p_action_id,p_connection_email,p_connection_updated_at);
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked','reason',reason); END IF;
  SELECT * INTO action FROM purama_ai.partner_outreach_dispatches WHERE id=p_action_id AND user_id=p_user_id;
  IF p_gmail_message_id IS NULL OR p_gmail_message_id !~ '^[A-Za-z0-9_-]{1,512}$'
    OR p_gmail_thread_id IS NULL OR p_gmail_thread_id !~ '^[A-Za-z0-9_-]{1,512}$'
    OR p_rfc_message_id IS NULL OR length(p_rfc_message_id)>900
    OR p_rfc_message_id !~ '^<[^<>[:space:]@]+@[^<>[:space:]@]+>$'
    OR action.rfc_message_id IS NULL OR p_parent_message_id IS DISTINCT FROM action.rfc_message_id
    OR p_rfc_message_id=action.rfc_message_id
    OR lower(btrim(p_sender_email)) IS DISTINCT FROM lower(btrim(action.recipient))
    OR p_received_at IS NULL OR p_received_at<action.dispatch_started_at OR p_received_at>now()+interval '5 minutes'
    OR p_kind IS NULL OR p_kind NOT IN ('human','refusal','automatic')
    THEN RETURN jsonb_build_object('status','blocked','reason','reply_proof_mismatch'); END IF;
  INSERT INTO purama_ai.partner_reply_receipts(user_id,prospect_id,action_id,gmail_message_id,
    gmail_thread_id,rfc_message_id,received_at,kind)
    VALUES(p_user_id,action.prospect_id,action.id,p_gmail_message_id,p_gmail_thread_id,
      p_rfc_message_id,p_received_at,p_kind) ON CONFLICT DO NOTHING RETURNING id INTO receipt;
  IF receipt IS NULL THEN RETURN jsonb_build_object('status','duplicate'); END IF;
  IF p_kind='refusal' THEN
    INSERT INTO purama_ai.partner_outreach_suppressions(user_id,email_normalized)
      VALUES(p_user_id,lower(btrim(action.recipient))) ON CONFLICT DO NOTHING;
  END IF;
  -- A late older page cannot replace a newer answer. A refusal is nevertheless
  -- remembered permanently, independent of subsequent pipeline edits.
  UPDATE purama_ai.partner_prospects SET
    has_replied=true,next_action_at=NULL,
    status=CASE WHEN p_kind='refusal' AND status IN ('contacted','relance_1','relance_2','relance_3','interested')
      THEN 'rejected' ELSE status END,
    reply_sentiment=CASE WHEN reply_received_at IS NULL OR p_received_at>=reply_received_at
      THEN CASE WHEN p_kind='refusal' THEN 'negatif' ELSE 'neutre' END ELSE reply_sentiment END,
    reply_summary=CASE WHEN reply_received_at IS NULL OR p_received_at>=reply_received_at THEN
      CASE p_kind WHEN 'refusal' THEN 'Refus explicite reçu ; sollicitations arrêtées.'
        WHEN 'automatic' THEN 'Réponse automatique reçue ; relances suspendues, reprise à examiner.'
        ELSE 'Réponse reçue dans le fil vérifié ; traitement requis.' END ELSE reply_summary END,
    reply_gmail_message_id=CASE WHEN reply_received_at IS NULL OR p_received_at>=reply_received_at
      THEN p_gmail_message_id ELSE reply_gmail_message_id END,
    reply_gmail_thread_id=CASE WHEN reply_received_at IS NULL OR p_received_at>=reply_received_at
      THEN p_gmail_thread_id ELSE reply_gmail_thread_id END,
    reply_kind=CASE WHEN reply_received_at IS NULL OR p_received_at>=reply_received_at THEN p_kind ELSE reply_kind END,
    reply_received_at=GREATEST(reply_received_at,p_received_at)
    WHERE id=action.prospect_id AND user_id=p_user_id;
  UPDATE purama_ai.partner_emails SET replied=true,replied_at=COALESCE(replied_at,p_received_at)
    WHERE id=action.email_id AND user_id=p_user_id;
  UPDATE purama_ai.partner_agent_config SET total_replies=COALESCE(total_replies,0)+1 WHERE user_id=p_user_id;
  RETURN jsonb_build_object('status','recorded','receipt_id',receipt,'prospect_id',action.prospect_id,
    'gmail_message_id',p_gmail_message_id,'gmail_thread_id',p_gmail_thread_id,'kind',p_kind);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.partner_reply_checkpoint(
  p_user_id uuid,p_action_id uuid,p_expected_page_token text,p_next_page_token text,
  p_connection_email text,p_connection_updated_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE reason text;
BEGIN
  reason:=purama_ai.partner_reply_lock(p_user_id,p_action_id,p_connection_email,p_connection_updated_at);
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked','reason',reason); END IF;
  IF p_next_page_token IS NOT NULL AND (length(p_next_page_token)>2048 OR p_next_page_token ~ '[[:cntrl:]]')
    THEN RETURN jsonb_build_object('status','blocked','reason','invalid_page_token'); END IF;
  UPDATE purama_ai.partner_outreach_dispatches SET
    reply_scan_page_token=NULLIF(p_next_page_token,''),last_reply_scan_at=now()
    WHERE id=p_action_id AND user_id=p_user_id AND reply_scan_page_token IS NOT DISTINCT FROM p_expected_page_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','stale_scan'); END IF;
  RETURN jsonb_build_object('status','checkpointed');
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.partner_reply_lock(uuid,uuid,text,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_reply_candidates(uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_reply_bind_outbound(uuid,uuid,text,text,text,text,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_reply_record(uuid,uuid,text,text,text,text,timestamptz,text,text,text,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.partner_reply_checkpoint(uuid,uuid,text,text,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.partner_reply_candidates(uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.partner_reply_bind_outbound(uuid,uuid,text,text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.partner_reply_record(uuid,uuid,text,text,text,text,timestamptz,text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.partner_reply_checkpoint(uuid,uuid,text,text,text,timestamptz) TO service_role;

COMMIT;
