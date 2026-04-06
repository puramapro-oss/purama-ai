-- =============================================================
-- Compta Agent module — autonomous accounting agent
-- + shared push notifications infrastructure (used by all agents)
-- Schema: purama_ai
-- =============================================================

CREATE SCHEMA IF NOT EXISTS purama_ai;

-- =============================================================
-- SHARED INFRA — push_subscriptions + agent_notifications
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription JSONB NOT NULL,
  endpoint TEXT GENERATED ALWAYS AS (subscription->>'endpoint') STORED,
  device_info TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, endpoint)
);

ALTER TABLE purama_ai.push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own push_subscriptions" ON purama_ai.push_subscriptions;
CREATE POLICY "Users own push_subscriptions" ON purama_ai.push_subscriptions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON purama_ai.push_subscriptions(user_id) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS purama_ai.agent_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  action_type TEXT,
  action_payload JSONB,
  action_url TEXT,
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  is_read BOOLEAN DEFAULT false,
  is_actioned BOOLEAN DEFAULT false,
  actioned_at TIMESTAMPTZ,
  channels TEXT[] DEFAULT ARRAY['push','in_app']::TEXT[],
  sent_push BOOLEAN DEFAULT false,
  sent_email BOOLEAN DEFAULT false,
  sent_sms BOOLEAN DEFAULT false,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.agent_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own agent_notifications" ON purama_ai.agent_notifications;
CREATE POLICY "Users own agent_notifications" ON purama_ai.agent_notifications
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON purama_ai.agent_notifications(user_id, created_at DESC) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_notif_user_all ON purama_ai.agent_notifications(user_id, created_at DESC);

-- =============================================================
-- compta_agent_config
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.compta_agent_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  is_active BOOLEAN DEFAULT false,

  -- Entreprise
  company_name TEXT,
  siren TEXT,
  siret TEXT,
  naf_code TEXT,
  legal_form TEXT,
  fiscal_regime TEXT,
  tva_regime TEXT,
  tva_number TEXT,
  fiscal_year_start INTEGER DEFAULT 1,

  -- Adresse
  address TEXT,
  postal_code TEXT,
  city TEXT,
  country TEXT DEFAULT 'FR',

  -- Zones
  is_zfrr BOOLEAN DEFAULT false,
  zfrr_start_date DATE,
  is_zfu BOOLEAN DEFAULT false,
  is_bassins_emploi BOOLEAN DEFAULT false,

  -- Optimisations
  cir_eligible BOOLEAN DEFAULT false,
  cii_eligible BOOLEAN DEFAULT false,
  ip_box_eligible BOOLEAN DEFAULT false,
  jei_status BOOLEAN DEFAULT false,

  -- Bridge API
  bridge_user_uuid TEXT,
  bridge_accounts JSONB DEFAULT '[]'::jsonb,
  bridge_last_sync_at TIMESTAMPTZ,

  -- Automatisation
  auto_categorize BOOLEAN DEFAULT true,
  auto_tva BOOLEAN DEFAULT true,
  auto_declarations BOOLEAN DEFAULT true,
  require_approval_before_send BOOLEAN DEFAULT true,

  -- Notifications
  notify_new_transaction BOOLEAN DEFAULT false,
  notify_declaration_ready BOOLEAN DEFAULT true,
  notify_anomaly BOOLEAN DEFAULT true,
  notify_monthly_report BOOLEAN DEFAULT true,

  -- EDI
  edi_partner_id TEXT,
  edi_enabled BOOLEAN DEFAULT false,

  -- Invoice numbering
  invoice_prefix TEXT DEFAULT 'FA',
  invoice_next_number INTEGER DEFAULT 1,

  -- Stats
  total_transactions INTEGER DEFAULT 0,
  total_invoices INTEGER DEFAULT 0,
  total_declarations INTEGER DEFAULT 0,
  fiscal_health_score INTEGER DEFAULT 50,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.compta_agent_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own compta_agent_config" ON purama_ai.compta_agent_config;
CREATE POLICY "Users own compta_agent_config" ON purama_ai.compta_agent_config
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_compta_config_active ON purama_ai.compta_agent_config(is_active) WHERE is_active = true;

-- =============================================================
-- compta_transactions
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.compta_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  bridge_transaction_id TEXT,
  bridge_account_id TEXT,

  date DATE NOT NULL,
  description TEXT NOT NULL,
  raw_description TEXT,
  amount DECIMAL(12,2) NOT NULL,
  currency TEXT DEFAULT 'EUR',
  type TEXT CHECK (type IN ('debit','credit')),

  -- Catégorisation IA
  category TEXT,
  subcategory TEXT,
  pcg_account TEXT,
  pcg_label TEXT,
  ai_confidence FLOAT,
  ai_reasoning TEXT,
  user_validated BOOLEAN DEFAULT false,
  user_category_override TEXT,

  -- TVA
  tva_rate DECIMAL(4,2),
  tva_amount DECIMAL(12,2),
  ht_amount DECIMAL(12,2),
  tva_deductible BOOLEAN DEFAULT false,

  -- Justificatif
  receipt_url TEXT,
  receipt_matched BOOLEAN DEFAULT false,
  invoice_id UUID,

  -- CCA / IK / Amortissement
  is_cca BOOLEAN DEFAULT false,
  is_ik BOOLEAN DEFAULT false,
  is_amortizable BOOLEAN DEFAULT false,
  amortization_duration_months INTEGER,
  amortization_start_date DATE,

  -- Méta
  is_recurring BOOLEAN DEFAULT false,
  is_anomaly BOOLEAN DEFAULT false,
  counterpart_name TEXT,
  counterpart_siren TEXT,
  tags TEXT[] DEFAULT '{}',
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, bridge_transaction_id)
);

ALTER TABLE purama_ai.compta_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own compta_transactions" ON purama_ai.compta_transactions;
CREATE POLICY "Users own compta_transactions" ON purama_ai.compta_transactions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_compta_tx_user_date ON purama_ai.compta_transactions(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_compta_tx_category ON purama_ai.compta_transactions(user_id, category);
CREATE INDEX IF NOT EXISTS idx_compta_tx_anomaly ON purama_ai.compta_transactions(user_id) WHERE is_anomaly = true;

-- =============================================================
-- compta_invoices
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.compta_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  invoice_number TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('emise','recue')),
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','overdue','cancelled')),

  counterpart_name TEXT NOT NULL,
  counterpart_siren TEXT,
  counterpart_tva_number TEXT,
  counterpart_address TEXT,
  counterpart_email TEXT,

  total_ht DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_tva DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_ttc DECIMAL(12,2) NOT NULL DEFAULT 0,

  lines JSONB NOT NULL DEFAULT '[]'::jsonb,

  issue_date DATE NOT NULL,
  due_date DATE,
  payment_date DATE,

  facturx_pdf_url TEXT,
  facturx_xml TEXT,
  facturx_profile TEXT DEFAULT 'EN16931',

  payment_method TEXT,
  matched_transaction_id UUID,
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, invoice_number)
);

ALTER TABLE purama_ai.compta_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own compta_invoices" ON purama_ai.compta_invoices;
CREATE POLICY "Users own compta_invoices" ON purama_ai.compta_invoices
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_compta_inv_user_date ON purama_ai.compta_invoices(user_id, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_compta_inv_status ON purama_ai.compta_invoices(user_id, status);

-- =============================================================
-- compta_declarations
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.compta_declarations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  type TEXT NOT NULL CHECK (type IN ('tva_ca3','tva_ca12','is','liasse','cfe','cvae','das2')),
  period TEXT NOT NULL,

  status TEXT DEFAULT 'calculating' CHECK (status IN (
    'calculating','ready','pending_approval','approved','sending','sent','confirmed','error','rejected'
  )),

  calculated_data JSONB NOT NULL DEFAULT '{}'::jsonb,

  pdf_url TEXT,
  edi_file_url TEXT,
  xml_data TEXT,

  notification_sent_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  rejection_reason TEXT,

  sent_at TIMESTAMPTZ,
  sent_via TEXT,
  confirmation_number TEXT,

  deadline DATE NOT NULL,
  days_before_deadline_notify INTEGER DEFAULT 7,

  ai_notes TEXT,
  ai_optimizations TEXT[] DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, type, period)
);

ALTER TABLE purama_ai.compta_declarations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own compta_declarations" ON purama_ai.compta_declarations;
CREATE POLICY "Users own compta_declarations" ON purama_ai.compta_declarations
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_compta_decl_user ON purama_ai.compta_declarations(user_id, deadline);
CREATE INDEX IF NOT EXISTS idx_compta_decl_pending ON purama_ai.compta_declarations(user_id) WHERE status IN ('ready','pending_approval');

-- =============================================================
-- compta_cca
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.compta_cca (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  associate_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('apport','remboursement')),
  amount DECIMAL(12,2) NOT NULL,
  date DATE NOT NULL,
  description TEXT,
  monthly_cap DECIMAL(12,2) DEFAULT 1500.00,
  convention_url TEXT,
  interest_rate DECIMAL(4,2) DEFAULT 0,
  matched_transaction_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.compta_cca ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own compta_cca" ON purama_ai.compta_cca;
CREATE POLICY "Users own compta_cca" ON purama_ai.compta_cca
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_compta_cca_user ON purama_ai.compta_cca(user_id, date DESC);

-- =============================================================
-- compta_ik
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.compta_ik (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vehicle_type TEXT,
  vehicle_power INTEGER,
  date DATE NOT NULL,
  departure TEXT,
  destination TEXT,
  purpose TEXT NOT NULL,
  km DECIMAL(8,1) NOT NULL,
  ik_rate DECIMAL(6,4),
  amount DECIMAL(8,2),
  matched_transaction_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.compta_ik ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own compta_ik" ON purama_ai.compta_ik;
CREATE POLICY "Users own compta_ik" ON purama_ai.compta_ik
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_compta_ik_user ON purama_ai.compta_ik(user_id, date DESC);

-- =============================================================
-- compta_amortizations
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.compta_amortizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_name TEXT NOT NULL,
  asset_category TEXT,
  purchase_date DATE NOT NULL,
  purchase_amount DECIMAL(12,2) NOT NULL,
  duration_months INTEGER NOT NULL,
  method TEXT DEFAULT 'lineaire' CHECK (method IN ('lineaire','degressif')),
  annual_amount DECIMAL(12,2),
  remaining_value DECIMAL(12,2),
  schedule JSONB DEFAULT '[]'::jsonb,
  eligible_cir BOOLEAN DEFAULT false,
  eligible_cii BOOLEAN DEFAULT false,
  matched_transaction_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.compta_amortizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own compta_amortizations" ON purama_ai.compta_amortizations;
CREATE POLICY "Users own compta_amortizations" ON purama_ai.compta_amortizations
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_compta_amort_user ON purama_ai.compta_amortizations(user_id, purchase_date DESC);

-- =============================================================
-- updated_at trigger (reuse the email_agent_set_updated_at function)
-- =============================================================
CREATE OR REPLACE FUNCTION purama_ai.compta_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_compta_config_updated ON purama_ai.compta_agent_config;
CREATE TRIGGER trg_compta_config_updated BEFORE UPDATE ON purama_ai.compta_agent_config
  FOR EACH ROW EXECUTE FUNCTION purama_ai.compta_set_updated_at();

DROP TRIGGER IF EXISTS trg_compta_tx_updated ON purama_ai.compta_transactions;
CREATE TRIGGER trg_compta_tx_updated BEFORE UPDATE ON purama_ai.compta_transactions
  FOR EACH ROW EXECUTE FUNCTION purama_ai.compta_set_updated_at();

DROP TRIGGER IF EXISTS trg_compta_inv_updated ON purama_ai.compta_invoices;
CREATE TRIGGER trg_compta_inv_updated BEFORE UPDATE ON purama_ai.compta_invoices
  FOR EACH ROW EXECUTE FUNCTION purama_ai.compta_set_updated_at();

DROP TRIGGER IF EXISTS trg_compta_decl_updated ON purama_ai.compta_declarations;
CREATE TRIGGER trg_compta_decl_updated BEFORE UPDATE ON purama_ai.compta_declarations
  FOR EACH ROW EXECUTE FUNCTION purama_ai.compta_set_updated_at();

DROP TRIGGER IF EXISTS trg_push_subs_updated ON purama_ai.push_subscriptions;
CREATE TRIGGER trg_push_subs_updated BEFORE UPDATE ON purama_ai.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION purama_ai.compta_set_updated_at();

-- =============================================================
-- Privileges
-- =============================================================
GRANT USAGE ON SCHEMA purama_ai TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA purama_ai TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA purama_ai TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA purama_ai GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA purama_ai GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
