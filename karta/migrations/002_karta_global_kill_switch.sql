-- KARTA Engine — kill switch global (arrête TOUS les agents de TOUS les users instantanément)
SET search_path TO purama_ai;

CREATE TABLE IF NOT EXISTS purama_ai.karta_global_state (
  id TEXT PRIMARY KEY DEFAULT 'global',
  kill_switch BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id)
);

INSERT INTO purama_ai.karta_global_state (id, kill_switch)
VALUES ('global', false)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE purama_ai.karta_global_state ENABLE ROW LEVEL SECURITY;

-- Lecture publique (le dashboard doit pouvoir afficher l'état), écriture réservée au service_role
-- (le endpoint API KARTA vérifie lui-même les droits admin avant d'écrire).
DROP POLICY IF EXISTS "Anyone can read karta global state" ON purama_ai.karta_global_state;
CREATE POLICY "Anyone can read karta global state"
  ON purama_ai.karta_global_state FOR SELECT
  USING (true);
