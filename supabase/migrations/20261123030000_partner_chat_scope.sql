-- Keep the existing history and RLS. A selected dossier is a separate conversation scope.
-- No FK: deleting a prospect must neither erase chat history nor reclassify it as general chat.
ALTER TABLE purama_ai.agent_chat_history
  ADD COLUMN IF NOT EXISTS partner_prospect_id uuid;

ALTER TABLE purama_ai.agent_chat_history
  ADD CONSTRAINT agent_chat_history_partner_scope_check
  CHECK (partner_prospect_id IS NULL OR agent_type = 'partner');

CREATE INDEX IF NOT EXISTS agent_chat_history_partner_scope_idx
  ON purama_ai.agent_chat_history (user_id, agent_type, session_id, partner_prospect_id, created_at)
  WHERE agent_type = 'partner';

-- Existing own-account INSERT policy still applies; this also prevents a direct
-- browser insert from attaching another account's dossier to an otherwise own row.
CREATE POLICY agent_chat_history_partner_dossier_insert
  ON purama_ai.agent_chat_history AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    partner_prospect_id IS NULL OR EXISTS (
      SELECT 1 FROM purama_ai.partner_prospects p
      WHERE p.id = partner_prospect_id AND p.user_id = auth.uid()
    )
  );
