-- =============================================================
-- Legal Agent module — autonomous legal assistant
-- Schema: purama_ai
-- =============================================================

CREATE SCHEMA IF NOT EXISTS purama_ai;

-- =============================================================
-- legal_agent_config
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.legal_agent_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  is_active BOOLEAN DEFAULT true,

  user_type TEXT DEFAULT 'particulier',
  company_name TEXT,
  siren TEXT,
  siret TEXT,
  naf_code TEXT,
  activity_description TEXT,
  creation_date DATE,
  employee_count INTEGER DEFAULT 0,

  address TEXT,
  postal_code TEXT,
  city TEXT,
  country TEXT DEFAULT 'FR',

  expertise_areas TEXT[] DEFAULT ARRAY['commercial','travail','fiscal','rgpd','immobilier']::TEXT[],
  language TEXT DEFAULT 'fr',
  tone TEXT DEFAULT 'professionnel',
  auto_veille BOOLEAN DEFAULT true,
  auto_relance_impayes BOOLEAN DEFAULT false,
  notify_law_changes BOOLEAN DEFAULT true,
  notify_deadlines BOOLEAN DEFAULT true,
  notify_prescription BOOLEAN DEFAULT true,

  signature_image_url TEXT,
  signer_full_name TEXT,
  signer_email TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.legal_agent_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own legal_agent_config" ON purama_ai.legal_agent_config;
CREATE POLICY "Users own legal_agent_config" ON purama_ai.legal_agent_config
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_legal_config_active ON purama_ai.legal_agent_config(is_active) WHERE is_active = true;

-- =============================================================
-- legal_documents
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.legal_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  title TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','review','final','signed','sent','archived')),

  content_html TEXT NOT NULL,
  content_pdf_url TEXT,
  content_word_url TEXT,

  user_brief TEXT,
  ai_analysis TEXT,
  variables JSONB DEFAULT '{}'::jsonb,

  requires_signature BOOLEAN DEFAULT false,
  docuseal_submission_id TEXT,
  signed_at TIMESTAMPTZ,
  signed_pdf_url TEXT,
  signers JSONB DEFAULT '[]'::jsonb,

  sent_via TEXT,
  sent_at TIMESTAMPTZ,
  ar24_tracking_id TEXT,

  version INTEGER DEFAULT 1,
  parent_document_id UUID,
  changes_summary TEXT,

  tags TEXT[] DEFAULT '{}',
  related_contact TEXT,
  related_contact_email TEXT,

  expires_at DATE,
  renewal_alert_days INTEGER,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.legal_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own legal_documents" ON purama_ai.legal_documents;
CREATE POLICY "Users own legal_documents" ON purama_ai.legal_documents
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_legal_docs_user ON purama_ai.legal_documents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_legal_docs_type ON purama_ai.legal_documents(user_id, type);
CREATE INDEX IF NOT EXISTS idx_legal_docs_expires ON purama_ai.legal_documents(user_id, expires_at) WHERE expires_at IS NOT NULL;

-- =============================================================
-- legal_cases
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.legal_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  title TEXT NOT NULL,
  case_number TEXT,
  type TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting','won','lost','settled','closed')),
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),

  parties JSONB NOT NULL DEFAULT '[]'::jsonb,
  facts TEXT,
  timeline JSONB DEFAULT '[]'::jsonb,

  ai_analysis TEXT,
  ai_strategy TEXT,
  ai_arguments TEXT[] DEFAULT '{}',
  ai_risks TEXT[] DEFAULT '{}',
  ai_jurisprudence JSONB DEFAULT '[]'::jsonb,
  ai_success_probability INTEGER,
  ai_estimated_amount DECIMAL(12,2),

  deadlines JSONB DEFAULT '[]'::jsonb,
  prescription_date DATE,
  prescription_type TEXT,

  amount_claimed DECIMAL(12,2),
  amount_obtained DECIMAL(12,2),
  costs DECIMAL(12,2),

  document_ids UUID[] DEFAULT '{}',

  notes TEXT,
  tags TEXT[] DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.legal_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own legal_cases" ON purama_ai.legal_cases;
CREATE POLICY "Users own legal_cases" ON purama_ai.legal_cases
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_legal_cases_user ON purama_ai.legal_cases(user_id, status);
CREATE INDEX IF NOT EXISTS idx_legal_cases_prescription ON purama_ai.legal_cases(user_id, prescription_date) WHERE prescription_date IS NOT NULL;

-- =============================================================
-- legal_veille
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.legal_veille (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('new_law','law_change','jurisprudence','regulation','deadline','alert')),
  category TEXT,
  severity TEXT DEFAULT 'info' CHECK (severity IN ('info','warning','action_required','urgent')),

  summary TEXT NOT NULL,
  impact TEXT,
  action_required TEXT,
  source_url TEXT,
  source_name TEXT,
  reference TEXT,

  effective_date DATE,
  deadline DATE,

  is_read BOOLEAN DEFAULT false,
  is_actioned BOOLEAN DEFAULT false,
  notification_sent BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.legal_veille ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own legal_veille" ON purama_ai.legal_veille;
CREATE POLICY "Users own legal_veille" ON purama_ai.legal_veille
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_legal_veille_user ON purama_ai.legal_veille(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_legal_veille_unread ON purama_ai.legal_veille(user_id) WHERE is_read = false;

-- =============================================================
-- legal_impayes
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.legal_impayes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  debtor_name TEXT NOT NULL,
  debtor_email TEXT,
  debtor_address TEXT,
  debtor_siren TEXT,

  invoice_number TEXT,
  invoice_date DATE,
  due_date DATE,
  amount DECIMAL(12,2) NOT NULL,
  interest_rate DECIMAL(4,2) DEFAULT 11.62,

  status TEXT DEFAULT 'overdue' CHECK (status IN ('overdue','reminder_1','reminder_2','mise_en_demeure','injonction','huissier','closed','paid')),

  reminder_1_sent_at TIMESTAMPTZ,
  reminder_1_doc_id UUID,
  reminder_2_sent_at TIMESTAMPTZ,
  reminder_2_doc_id UUID,
  mise_en_demeure_sent_at TIMESTAMPTZ,
  mise_en_demeure_doc_id UUID,
  mise_en_demeure_ar24_id TEXT,
  injonction_prepared_at TIMESTAMPTZ,
  injonction_doc_id UUID,

  paid_at TIMESTAMPTZ,
  paid_amount DECIMAL(12,2),
  settled BOOLEAN DEFAULT false,
  settlement_terms TEXT,

  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.legal_impayes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own legal_impayes" ON purama_ai.legal_impayes;
CREATE POLICY "Users own legal_impayes" ON purama_ai.legal_impayes
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_legal_impayes_user ON purama_ai.legal_impayes(user_id, status);
CREATE INDEX IF NOT EXISTS idx_legal_impayes_due ON purama_ai.legal_impayes(user_id, due_date) WHERE status NOT IN ('paid','closed');

-- =============================================================
-- legal_chat_history
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.legal_chat_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  session_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,

  category TEXT,
  documents_referenced UUID[] DEFAULT '{}',
  cases_referenced UUID[] DEFAULT '{}',
  sources_cited JSONB DEFAULT '[]'::jsonb,

  confidence FLOAT,
  disclaimer_shown BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.legal_chat_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own legal_chat_history" ON purama_ai.legal_chat_history;
CREATE POLICY "Users own legal_chat_history" ON purama_ai.legal_chat_history
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_legal_chat_session ON purama_ai.legal_chat_history(user_id, session_id, created_at);

-- =============================================================
-- legal_templates
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.legal_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT,
  description TEXT,
  content_template TEXT NOT NULL,
  variables_schema JSONB DEFAULT '[]'::jsonb,
  is_default BOOLEAN DEFAULT false,
  usage_count INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.legal_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own or default legal_templates" ON purama_ai.legal_templates;
CREATE POLICY "Users own or default legal_templates" ON purama_ai.legal_templates
  FOR SELECT USING (auth.uid() = user_id OR is_default = true);
DROP POLICY IF EXISTS "Users insert their own legal_templates" ON purama_ai.legal_templates;
CREATE POLICY "Users insert their own legal_templates" ON purama_ai.legal_templates
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users update their own legal_templates" ON purama_ai.legal_templates;
CREATE POLICY "Users update their own legal_templates" ON purama_ai.legal_templates
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users delete their own legal_templates" ON purama_ai.legal_templates;
CREATE POLICY "Users delete their own legal_templates" ON purama_ai.legal_templates
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_legal_templates_type ON purama_ai.legal_templates(type, is_default);

-- =============================================================
-- updated_at triggers
-- =============================================================
CREATE OR REPLACE FUNCTION purama_ai.legal_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_legal_config_updated ON purama_ai.legal_agent_config;
CREATE TRIGGER trg_legal_config_updated BEFORE UPDATE ON purama_ai.legal_agent_config
  FOR EACH ROW EXECUTE FUNCTION purama_ai.legal_set_updated_at();

DROP TRIGGER IF EXISTS trg_legal_docs_updated ON purama_ai.legal_documents;
CREATE TRIGGER trg_legal_docs_updated BEFORE UPDATE ON purama_ai.legal_documents
  FOR EACH ROW EXECUTE FUNCTION purama_ai.legal_set_updated_at();

DROP TRIGGER IF EXISTS trg_legal_cases_updated ON purama_ai.legal_cases;
CREATE TRIGGER trg_legal_cases_updated BEFORE UPDATE ON purama_ai.legal_cases
  FOR EACH ROW EXECUTE FUNCTION purama_ai.legal_set_updated_at();

DROP TRIGGER IF EXISTS trg_legal_impayes_updated ON purama_ai.legal_impayes;
CREATE TRIGGER trg_legal_impayes_updated BEFORE UPDATE ON purama_ai.legal_impayes
  FOR EACH ROW EXECUTE FUNCTION purama_ai.legal_set_updated_at();

-- =============================================================
-- Privileges
-- =============================================================
GRANT USAGE ON SCHEMA purama_ai TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA purama_ai TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA purama_ai TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA purama_ai GRANT ALL ON TABLES TO anon, authenticated, service_role;
