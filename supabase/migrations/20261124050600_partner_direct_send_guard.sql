-- KARTA's shared Gmail sender must not bypass the partner reply approval path.
-- This classifier is read-only: it grants no approval and sends no message.
BEGIN;

CREATE INDEX IF NOT EXISTS partner_prospect_recipient_guard
  ON purama_ai.partner_prospects(user_id, lower(btrim(email)));
CREATE INDEX IF NOT EXISTS partner_reply_receipt_thread_guard
  ON purama_ai.partner_reply_receipts(user_id, gmail_thread_id);
CREATE INDEX IF NOT EXISTS partner_reply_draft_recipient_guard
  ON purama_ai.partner_reply_drafts(user_id, lower(btrim(payload->>'recipient')));
CREATE INDEX IF NOT EXISTS partner_reply_draft_thread_guard
  ON purama_ai.partner_reply_drafts(user_id, (payload->>'gmail_thread_id'));

CREATE OR REPLACE FUNCTION purama_ai.partner_direct_send_guard(
  p_user_id uuid, p_recipient text, p_parent_gmail_id text DEFAULT NULL,
  p_gmail_thread_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,purama_ai AS $$
DECLARE
  normalized_recipient text := lower(btrim(p_recipient));
BEGIN
  IF p_user_id IS NULL OR normalized_recipient IS NULL OR length(normalized_recipient) NOT BETWEEN 3 AND 320
    OR normalized_recipient !~ '^[^[:space:]@<>,;:]+@[^[:space:]@<>,;:]+\.[^[:space:]@<>,;:]+$'
    OR (p_parent_gmail_id IS NOT NULL AND (length(p_parent_gmail_id) NOT BETWEEN 1 AND 512
      OR p_parent_gmail_id !~ '^[A-Za-z0-9_-]+$'))
    OR (p_gmail_thread_id IS NOT NULL AND (length(p_gmail_thread_id) NOT BETWEEN 1 AND 512
      OR p_gmail_thread_id !~ '^[A-Za-z0-9_-]+$')) THEN
    RETURN jsonb_build_object('status','blocked','reason','invalid_send_identity');
  END IF;

  -- An explicit refusal applies to every profile. Its private receipt remains
  -- blocking even if a later edit changes the current prospect or address.
  IF EXISTS(SELECT 1 FROM purama_ai.partner_outreach_suppressions s
      WHERE s.user_id=p_user_id AND s.email_normalized=normalized_recipient)
    OR EXISTS(SELECT 1 FROM purama_ai.partner_prospects p WHERE p.user_id=p_user_id
      AND lower(btrim(p.email))=normalized_recipient
      AND (p.status='rejected' OR p.email_permission->>'status'='withdrawn'))
    OR EXISTS(SELECT 1 FROM purama_ai.partner_reply_receipts r
      JOIN purama_ai.partner_outreach_dispatches d ON d.id=r.action_id AND d.user_id=r.user_id
      WHERE r.user_id=p_user_id AND r.kind='refusal' AND (r.gmail_message_id=p_parent_gmail_id
        OR r.gmail_thread_id=p_gmail_thread_id OR lower(btrim(d.recipient))=normalized_recipient)) THEN
    RETURN jsonb_build_object('status','blocked','reason','contact_suppressed');
  END IF;

  -- The new reply path supports media/editorial profiles. Preserve ordinary
  -- legacy replies; durable media snapshots and bindings cannot be cleared by
  -- deleting/reimporting a mutable prospect or Email log.
  IF EXISTS(SELECT 1 FROM purama_ai.partner_prospects p WHERE p.user_id=p_user_id
      AND p.outreach_profile IN ('media_affiliate','editorial')
      AND lower(btrim(p.email))=normalized_recipient)
    OR EXISTS(SELECT 1 FROM purama_ai.partner_active a JOIN purama_ai.partner_prospects p
      ON p.id=a.prospect_id AND p.user_id=a.user_id
      WHERE a.user_id=p_user_id AND p.outreach_profile IN ('media_affiliate','editorial')
        AND lower(btrim(a.partner_email))=normalized_recipient)
    OR EXISTS(SELECT 1 FROM purama_ai.partner_outreach_dispatches d
      WHERE d.user_id=p_user_id AND lower(btrim(d.recipient))=normalized_recipient
      AND (d.policy_snapshot->>'profile' IN ('media_affiliate','editorial') OR EXISTS(
        SELECT 1 FROM purama_ai.partner_prospects p WHERE p.id=d.prospect_id AND p.user_id=d.user_id
          AND p.outreach_profile IN ('media_affiliate','editorial'))))
    -- Outbound dispatch provider IDs are Resend IDs, never Gmail parents.
    OR EXISTS(SELECT 1 FROM purama_ai.partner_reply_receipts r
      JOIN purama_ai.partner_outreach_dispatches d ON d.id=r.action_id AND d.user_id=r.user_id
      LEFT JOIN purama_ai.partner_prospects p ON p.id=r.prospect_id AND p.user_id=r.user_id
      WHERE r.user_id=p_user_id AND (r.gmail_message_id=p_parent_gmail_id
        OR r.gmail_thread_id=p_gmail_thread_id)
      AND (d.policy_snapshot->>'profile' IN ('media_affiliate','editorial')
        OR p.outreach_profile IN ('media_affiliate','editorial')))
    OR EXISTS(SELECT 1 FROM purama_ai.partner_reply_drafts d
      WHERE d.user_id=p_user_id AND d.policy_snapshot->>'profile' IN ('media_affiliate','editorial')
        AND (lower(btrim(d.payload->>'recipient'))=normalized_recipient
        OR d.gmail_message_id=p_parent_gmail_id
        OR d.payload->>'gmail_thread_id'=p_gmail_thread_id)) THEN
    RETURN jsonb_build_object('status','blocked','reason','partner_reply_preparation_required');
  END IF;
  RETURN jsonb_build_object('status','allowed','reason',NULL);
END $$;

REVOKE ALL ON FUNCTION purama_ai.partner_direct_send_guard(uuid,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.partner_direct_send_guard(uuid,text,text,text) TO service_role;

COMMIT;
