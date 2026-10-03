-- Horodatage des prises en charge pour detecter les executions bloquees sans jamais les rejouer.
SET search_path TO purama_ai;

ALTER TABLE purama_ai.karta_pending_actions
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Les anciennes prises en charge n'avaient pas d'horodatage. `created_at` est une borne
-- conservatrice : elles seront classees `unknown` si elles sont deja expirees, jamais rejouees.
UPDATE purama_ai.karta_pending_actions
SET claimed_at = created_at
WHERE status = 'executing' AND claimed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_karta_pending_actions_executing_claimed
  ON purama_ai.karta_pending_actions(claimed_at)
  WHERE status = 'executing';
