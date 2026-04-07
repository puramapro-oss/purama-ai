-- Voice mode + universal agent chat history
-- 1) agent_chat_history: shared chat table for Email/Compta/Partner agents
-- 2) voice_settings: per-user voice configuration
SET search_path = purama_ai, public;

CREATE TABLE IF NOT EXISTS purama_ai.agent_chat_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL CHECK (agent_type IN ('email','compta','partner','legal','creator','social')),
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  tokens INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_chat_history_user_idx
  ON purama_ai.agent_chat_history (user_id, agent_type, session_id, created_at);

ALTER TABLE purama_ai.agent_chat_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_chat_history_select_own" ON purama_ai.agent_chat_history;
CREATE POLICY "agent_chat_history_select_own"
  ON purama_ai.agent_chat_history FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "agent_chat_history_insert_own" ON purama_ai.agent_chat_history;
CREATE POLICY "agent_chat_history_insert_own"
  ON purama_ai.agent_chat_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "agent_chat_history_delete_own" ON purama_ai.agent_chat_history;
CREATE POLICY "agent_chat_history_delete_own"
  ON purama_ai.agent_chat_history FOR DELETE
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- Voice settings (per-user)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purama_ai.voice_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'openai' CHECK (provider IN ('openai','elevenlabs')),
  voice_id TEXT NOT NULL DEFAULT 'nova',
  speed NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  auto_play BOOLEAN NOT NULL DEFAULT true,
  enabled BOOLEAN NOT NULL DEFAULT true,
  language TEXT NOT NULL DEFAULT 'fr',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE purama_ai.voice_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "voice_settings_select_own" ON purama_ai.voice_settings;
CREATE POLICY "voice_settings_select_own"
  ON purama_ai.voice_settings FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "voice_settings_upsert_own" ON purama_ai.voice_settings;
CREATE POLICY "voice_settings_upsert_own"
  ON purama_ai.voice_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "voice_settings_update_own" ON purama_ai.voice_settings;
CREATE POLICY "voice_settings_update_own"
  ON purama_ai.voice_settings FOR UPDATE
  USING (auth.uid() = user_id);
