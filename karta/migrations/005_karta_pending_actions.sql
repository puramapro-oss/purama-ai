-- KARTA Engine — mécanisme d'approbation réel (fix bloquant QA 2026-07-27)
-- Une ligne par outil mis en attente de validation humaine (niveau d'autonomie 1, ou outil
-- sensible au niveau 2) — permet de réellement exécuter l'action après approbation, au lieu
-- de se contenter de la journaliser sans jamais la reprendre.
-- Idempotent (IF NOT EXISTS partout) — safe à rejouer.

SET search_path TO purama_ai;

CREATE TABLE IF NOT EXISTS purama_ai.karta_pending_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES purama_ai.karta_runs(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_params JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'executed' | 'failed' | 'rejected'
  result_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

ALTER TABLE purama_ai.karta_pending_actions ENABLE ROW LEVEL SECURITY;

-- Lecture seule côté user (pour afficher les actions à approuver) — la résolution (approve/reject)
-- passe toujours par l'API KARTA (service_role), jamais par une UPDATE directe du navigateur :
-- approuver doit réellement EXÉCUTER l'outil, ce qu'aucune policy RLS ne peut faire à elle seule.
DROP POLICY IF EXISTS "Users view their own karta pending actions" ON purama_ai.karta_pending_actions;
CREATE POLICY "Users view their own karta pending actions"
  ON purama_ai.karta_pending_actions FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_karta_pending_actions_user_status
  ON purama_ai.karta_pending_actions(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_karta_pending_actions_run
  ON purama_ai.karta_pending_actions(run_id);
