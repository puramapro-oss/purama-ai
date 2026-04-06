-- =============================================================
-- Email Agent module — autonomous Gmail agent (n8n + Claude API)
-- Schema: purama_ai (matches the supabase client default)
-- =============================================================

CREATE SCHEMA IF NOT EXISTS purama_ai;

-- =============================================================
-- email_agent_config — per-user agent configuration
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.email_agent_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  is_active BOOLEAN DEFAULT false,
  autonomy_level INTEGER DEFAULT 2 CHECK (autonomy_level BETWEEN 1 AND 5),
  tone TEXT DEFAULT 'professionnel_amical',
  custom_tone_prompt TEXT,
  signature TEXT DEFAULT '',
  language TEXT DEFAULT 'fr',
  excluded_emails TEXT[] DEFAULT '{}',
  excluded_domains TEXT[] DEFAULT '{}',
  auto_reply_categories TEXT[] DEFAULT ARRAY['confirmation','remerciement','faq']::TEXT[],
  notify_categories TEXT[] DEFAULT ARRAY['urgent','important','partenariat','facturation']::TEXT[],
  archive_categories TEXT[] DEFAULT ARRAY['newsletter','spam','promo']::TEXT[],
  working_hours_only BOOLEAN DEFAULT false,
  working_hours_start TIME DEFAULT '08:00',
  working_hours_end TIME DEFAULT '19:00',
  daily_digest BOOLEAN DEFAULT true,
  daily_digest_time TIME DEFAULT '08:00',
  vacation_mode BOOLEAN DEFAULT false,
  vacation_message TEXT,
  gmail_email TEXT,
  gmail_refresh_token TEXT,
  gmail_access_token TEXT,
  gmail_token_expiry TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_email_id TEXT,
  total_processed INTEGER DEFAULT 0,
  total_auto_replied INTEGER DEFAULT 0,
  total_drafted INTEGER DEFAULT 0,
  total_notified INTEGER DEFAULT 0,
  total_archived INTEGER DEFAULT 0,
  estimated_time_saved_minutes INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.email_agent_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own email_agent_config" ON purama_ai.email_agent_config;
CREATE POLICY "Users manage own email_agent_config" ON purama_ai.email_agent_config
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_email_agent_config_user ON purama_ai.email_agent_config(user_id);
CREATE INDEX IF NOT EXISTS idx_email_agent_config_active ON purama_ai.email_agent_config(is_active) WHERE is_active = true;

-- =============================================================
-- email_agent_logs — every action the agent took
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.email_agent_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT,
  gmail_draft_id TEXT,
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_email TEXT,
  subject TEXT,
  snippet TEXT,
  body_preview TEXT,
  received_at TIMESTAMPTZ,
  category TEXT NOT NULL,
  intention TEXT,
  sentiment TEXT,
  urgency_score INTEGER,
  tags TEXT[] DEFAULT '{}',
  action_taken TEXT NOT NULL CHECK (action_taken IN ('auto_reply','draft','notify','archive','ignore','error')),
  ai_response TEXT,
  ai_subject TEXT,
  ai_reasoning TEXT,
  confidence_score FLOAT,
  user_approved BOOLEAN,
  user_feedback TEXT,
  feedback_at TIMESTAMPTZ,
  tokens_used INTEGER,
  processing_time_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.email_agent_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users see own email_agent_logs" ON purama_ai.email_agent_logs;
CREATE POLICY "Users see own email_agent_logs" ON purama_ai.email_agent_logs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_email_agent_logs_user ON purama_ai.email_agent_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_email_agent_logs_created ON purama_ai.email_agent_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_agent_logs_action ON purama_ai.email_agent_logs(user_id, action_taken);
CREATE INDEX IF NOT EXISTS idx_email_agent_logs_pending ON purama_ai.email_agent_logs(user_id) WHERE user_approved IS NULL AND action_taken = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_agent_logs_msg ON purama_ai.email_agent_logs(user_id, gmail_message_id);

-- =============================================================
-- email_agent_rules — user-defined custom rules
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.email_agent_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_name TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 0,
  condition_from_email TEXT,
  condition_from_domain TEXT,
  condition_subject_contains TEXT,
  condition_body_contains TEXT,
  condition_category TEXT,
  action TEXT NOT NULL CHECK (action IN ('auto_reply','draft','notify','archive','ignore','forward','label')),
  action_reply_template TEXT,
  action_forward_to TEXT,
  action_label TEXT,
  action_notify_message TEXT,
  match_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.email_agent_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own email_agent_rules" ON purama_ai.email_agent_rules;
CREATE POLICY "Users manage own email_agent_rules" ON purama_ai.email_agent_rules
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_email_agent_rules_user ON purama_ai.email_agent_rules(user_id, priority DESC);

-- =============================================================
-- email_agent_memory — what the agent learned about each contact
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.email_agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_email TEXT NOT NULL,
  contact_name TEXT,
  relationship TEXT,
  preferred_tone TEXT,
  context_notes TEXT,
  last_interaction TIMESTAMPTZ,
  interaction_count INTEGER DEFAULT 0,
  auto_reply_ok BOOLEAN DEFAULT true,
  is_blocked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, contact_email)
);

ALTER TABLE purama_ai.email_agent_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own email_agent_memory" ON purama_ai.email_agent_memory;
CREATE POLICY "Users manage own email_agent_memory" ON purama_ai.email_agent_memory
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_email_agent_memory_user ON purama_ai.email_agent_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_email_agent_memory_contact ON purama_ai.email_agent_memory(user_id, contact_email);

-- =============================================================
-- email_agent_templates — reusable response templates
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.email_agent_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  template_name TEXT NOT NULL,
  template_category TEXT,
  subject_template TEXT,
  body_template TEXT NOT NULL,
  variables TEXT[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.email_agent_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own email_agent_templates" ON purama_ai.email_agent_templates;
CREATE POLICY "Users manage own email_agent_templates" ON purama_ai.email_agent_templates
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_email_agent_templates_user ON purama_ai.email_agent_templates(user_id);

-- =============================================================
-- updated_at trigger
-- =============================================================
CREATE OR REPLACE FUNCTION purama_ai.email_agent_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_email_agent_config_updated ON purama_ai.email_agent_config;
CREATE TRIGGER trg_email_agent_config_updated BEFORE UPDATE ON purama_ai.email_agent_config
  FOR EACH ROW EXECUTE FUNCTION purama_ai.email_agent_set_updated_at();

DROP TRIGGER IF EXISTS trg_email_agent_rules_updated ON purama_ai.email_agent_rules;
CREATE TRIGGER trg_email_agent_rules_updated BEFORE UPDATE ON purama_ai.email_agent_rules
  FOR EACH ROW EXECUTE FUNCTION purama_ai.email_agent_set_updated_at();

DROP TRIGGER IF EXISTS trg_email_agent_memory_updated ON purama_ai.email_agent_memory;
CREATE TRIGGER trg_email_agent_memory_updated BEFORE UPDATE ON purama_ai.email_agent_memory
  FOR EACH ROW EXECUTE FUNCTION purama_ai.email_agent_set_updated_at();

DROP TRIGGER IF EXISTS trg_email_agent_templates_updated ON purama_ai.email_agent_templates;
CREATE TRIGGER trg_email_agent_templates_updated BEFORE UPDATE ON purama_ai.email_agent_templates
  FOR EACH ROW EXECUTE FUNCTION purama_ai.email_agent_set_updated_at();

-- =============================================================
-- Expose schema to PostgREST API (already done globally but safe)
-- =============================================================
GRANT USAGE ON SCHEMA purama_ai TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA purama_ai TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA purama_ai TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA purama_ai GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA purama_ai GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
