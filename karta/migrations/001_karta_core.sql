-- KARTA Engine — tables cœur (Phase 1)
-- Schéma : purama_ai (même schéma que le reste de l'app)
-- Idempotent (IF NOT EXISTS partout) — safe à rejouer.

SET search_path TO purama_ai;

-- ============================================================
-- karta_agent_state — autonomie, kill switch, mode simulation par agent/user
-- ============================================================
CREATE TABLE IF NOT EXISTS purama_ai.karta_agent_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL, -- 'email' | 'compta' | 'legal' | 'partner'
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  autonomy_level INTEGER NOT NULL DEFAULT 1 CHECK (autonomy_level BETWEEN 1 AND 3),
  -- 1 = propose, l'humain valide chaque action
  -- 2 = agit seul sauf actions sensibles (argent, envois massifs, signature)
  -- 3 = autonomie totale, rapport quotidien
  kill_switch BOOLEAN NOT NULL DEFAULT false, -- true = pause immédiate, prioritaire sur is_enabled
  simulation_mode BOOLEAN NOT NULL DEFAULT true, -- dry-run par défaut tant que l'agent n'a pas été validé 24h
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT, -- 'success' | 'error' | 'skipped'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, agent_type)
);

ALTER TABLE purama_ai.karta_agent_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own karta agent state" ON purama_ai.karta_agent_state;
CREATE POLICY "Users manage their own karta agent state"
  ON purama_ai.karta_agent_state FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- karta_runs — log immuable de chaque exécution d'agent (déclencheur -> décision -> outils -> résultat)
-- ============================================================
CREATE TABLE IF NOT EXISTS purama_ai.karta_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL,
  trigger_type TEXT NOT NULL, -- 'cron' | 'webhook' | 'manual' | 'delegation'
  trigger_source TEXT, -- nom du cron / webhook / agent délégant
  mode TEXT NOT NULL DEFAULT 'simulation', -- 'simulation' | 'live'
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'success' | 'error' | 'awaiting_approval'
  input_summary TEXT, -- résumé du contexte reçu
  decision TEXT, -- ce que l'agent a décidé de faire (texte, via Claude)
  tools_used JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{tool, params_summary, result_summary, success}]
  result_summary TEXT,
  error_message TEXT,
  claude_mock BOOLEAN NOT NULL DEFAULT false, -- true si la décision vient du mock Claude (TODO_LIVE_TEST)
  duration_ms INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

ALTER TABLE purama_ai.karta_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view their own karta runs" ON purama_ai.karta_runs;
CREATE POLICY "Users view their own karta runs"
  ON purama_ai.karta_runs FOR SELECT
  USING (auth.uid() = user_id);
-- Pas de policy INSERT/UPDATE/DELETE pour les users : uniquement le service_role (KARTA Engine) écrit. Log immuable.

CREATE INDEX IF NOT EXISTS idx_karta_runs_user_agent ON purama_ai.karta_runs(user_id, agent_type, started_at DESC);

-- ============================================================
-- karta_agent_memory — mémoire générique par agent (clé/valeur), utilisée par les 4 agents cœur KARTA
-- (distincte de email_agent_memory, table legacy du workflow n8n)
-- ============================================================
CREATE TABLE IF NOT EXISTS purama_ai.karta_agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  memory_value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, agent_type, memory_key)
);

ALTER TABLE purama_ai.karta_agent_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own karta agent memory" ON purama_ai.karta_agent_memory;
CREATE POLICY "Users manage their own karta agent memory"
  ON purama_ai.karta_agent_memory FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
