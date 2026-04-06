-- =============================================================
-- Partner Agent module — autonomous partnership development agent
-- Schema: purama_ai
-- =============================================================

CREATE SCHEMA IF NOT EXISTS purama_ai;

-- =============================================================
-- partner_agent_config
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.partner_agent_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  is_active BOOLEAN DEFAULT false,

  -- Sender identity
  sender_name TEXT,
  sender_email TEXT,
  sender_title TEXT,
  company_name TEXT DEFAULT 'Purama',

  -- Signature
  signature_image_url TEXT,
  signature_name TEXT,
  signature_title TEXT,

  -- Outreach throttle
  daily_outreach_limit INTEGER DEFAULT 20,
  outreach_hours_start TIME DEFAULT '09:00',
  outreach_hours_end TIME DEFAULT '18:00',
  outreach_days TEXT[] DEFAULT ARRAY['MO','TU','WE','TH','FR']::TEXT[],

  -- Relances
  relance_1_delay_days INTEGER DEFAULT 3,
  relance_2_delay_days INTEGER DEFAULT 7,
  relance_3_delay_days INTEGER DEFAULT 14,
  max_relances INTEGER DEFAULT 3,

  -- Commissions
  commission_first_payment DECIMAL(4,2) DEFAULT 50.00,
  commission_recurring DECIMAL(4,2) DEFAULT 10.00,

  -- Contract
  contract_template_id TEXT,
  contract_pdf_url TEXT,
  auto_send_contract BOOLEAN DEFAULT true,

  -- Targeting
  target_niches TEXT[] DEFAULT ARRAY[]::TEXT[],
  target_min_followers INTEGER DEFAULT 1000,
  target_countries TEXT[] DEFAULT ARRAY['FR']::TEXT[],
  target_languages TEXT[] DEFAULT ARRAY['fr']::TEXT[],

  -- Tone
  outreach_tone TEXT DEFAULT 'professionnel_enthousiaste',
  custom_tone_prompt TEXT,

  -- Approval gates
  require_approval_new_prospect BOOLEAN DEFAULT false,
  require_approval_outreach BOOLEAN DEFAULT false,
  require_approval_contract BOOLEAN DEFAULT true,

  -- Stats (denormalized)
  total_prospects_found INTEGER DEFAULT 0,
  total_emails_sent INTEGER DEFAULT 0,
  total_replies INTEGER DEFAULT 0,
  total_active_partners INTEGER DEFAULT 0,
  total_revenue_generated DECIMAL(12,2) DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.partner_agent_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own partner_agent_config" ON purama_ai.partner_agent_config;
CREATE POLICY "Users own partner_agent_config" ON purama_ai.partner_agent_config
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_partner_config_active ON purama_ai.partner_agent_config(is_active) WHERE is_active = true;

-- =============================================================
-- partner_prospects
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.partner_prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  email TEXT,
  website TEXT,
  social_links JSONB DEFAULT '{}'::jsonb,
  type TEXT CHECK (type IN ('influencer','website','association','media','commerce','other') OR type IS NULL),
  niche TEXT,

  followers_count INTEGER,
  monthly_visitors INTEGER,
  engagement_rate DECIMAL(5,2),
  audience_country TEXT,

  status TEXT DEFAULT 'identified' CHECK (status IN (
    'identified','ready_to_contact','contacted','relance_1','relance_2','relance_3',
    'interested','contract_sent','contract_signed','active','inactive','rejected'
  )),

  first_contact_at TIMESTAMPTZ,
  last_contact_at TIMESTAMPTZ,
  relance_count INTEGER DEFAULT 0,
  next_action_at TIMESTAMPTZ,

  has_replied BOOLEAN DEFAULT false,
  reply_sentiment TEXT,
  reply_summary TEXT,

  contract_sent_at TIMESTAMPTZ,
  contract_signed_at TIMESTAMPTZ,
  contract_url TEXT,

  ai_score INTEGER,
  ai_reasoning TEXT,

  notes TEXT,
  tags TEXT[] DEFAULT '{}',

  source TEXT DEFAULT 'manual',
  found_by_ai BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.partner_prospects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own partner_prospects" ON purama_ai.partner_prospects;
CREATE POLICY "Users own partner_prospects" ON purama_ai.partner_prospects
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_partner_pros_user ON purama_ai.partner_prospects(user_id, status, ai_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_partner_pros_next ON purama_ai.partner_prospects(user_id, next_action_at) WHERE has_replied = false AND next_action_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_partner_pros_email ON purama_ai.partner_prospects(user_id, email) WHERE email IS NOT NULL;

-- =============================================================
-- partner_emails
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.partner_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  prospect_id UUID NOT NULL REFERENCES purama_ai.partner_prospects(id) ON DELETE CASCADE,

  type TEXT NOT NULL CHECK (type IN ('outreach','relance_1','relance_2','relance_3','contract','welcome','custom','reply')),
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT,

  sent_at TIMESTAMPTZ,
  delivered BOOLEAN,
  opened BOOLEAN DEFAULT false,
  opened_at TIMESTAMPTZ,
  clicked BOOLEAN DEFAULT false,
  clicked_at TIMESTAMPTZ,
  replied BOOLEAN DEFAULT false,
  replied_at TIMESTAMPTZ,
  bounced BOOLEAN DEFAULT false,

  resend_message_id TEXT,

  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','sent','failed')),
  approved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.partner_emails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own partner_emails" ON purama_ai.partner_emails;
CREATE POLICY "Users own partner_emails" ON purama_ai.partner_emails
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_partner_emails_user ON purama_ai.partner_emails(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_emails_prospect ON purama_ai.partner_emails(prospect_id, created_at DESC);

-- =============================================================
-- partner_active
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.partner_active (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES purama_ai.partner_prospects(id),

  partner_name TEXT NOT NULL,
  partner_email TEXT NOT NULL,
  referral_code TEXT NOT NULL UNIQUE,
  referral_link TEXT NOT NULL,

  total_clicks INTEGER DEFAULT 0,
  total_signups INTEGER DEFAULT 0,
  total_conversions INTEGER DEFAULT 0,
  total_revenue_generated DECIMAL(12,2) DEFAULT 0,
  total_commission_earned DECIMAL(12,2) DEFAULT 0,
  total_commission_paid DECIMAL(12,2) DEFAULT 0,

  level TEXT DEFAULT 'starter' CHECK (level IN ('starter','silver','gold','platinum','diamond','titan','eternal')),

  equity_granted BOOLEAN DEFAULT false,
  hereditary_commissions BOOLEAN DEFAULT false,
  tesla_reward BOOLEAN DEFAULT false,

  is_active BOOLEAN DEFAULT true,
  joined_at TIMESTAMPTZ DEFAULT now(),
  last_activity_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.partner_active ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own partner_active" ON purama_ai.partner_active;
CREATE POLICY "Users own partner_active" ON purama_ai.partner_active
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_partner_active_user ON purama_ai.partner_active(user_id, is_active);

-- =============================================================
-- partner_commissions
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.partner_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL REFERENCES purama_ai.partner_active(id) ON DELETE CASCADE,

  type TEXT NOT NULL CHECK (type IN ('first_payment','recurring','bonus')),
  amount DECIMAL(12,2) NOT NULL,
  percentage DECIMAL(4,2) NOT NULL,
  source_payment_id TEXT,
  source_customer_email TEXT,
  source_app TEXT,

  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','cancelled')),
  paid_at TIMESTAMPTZ,
  payment_method TEXT,

  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.partner_commissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own partner_commissions" ON purama_ai.partner_commissions;
CREATE POLICY "Users own partner_commissions" ON purama_ai.partner_commissions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_partner_comm_user ON purama_ai.partner_commissions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_comm_partner ON purama_ai.partner_commissions(partner_id, status);

-- =============================================================
-- partner_email_templates
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.partner_email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('outreach','relance_1','relance_2','relance_3','welcome','contract','custom')),
  target_type TEXT,
  target_niche TEXT,

  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,

  performance_score DECIMAL(5,2),
  times_used INTEGER DEFAULT 0,

  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.partner_email_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own partner_email_templates" ON purama_ai.partner_email_templates;
CREATE POLICY "Users own partner_email_templates" ON purama_ai.partner_email_templates
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_partner_templates_user ON purama_ai.partner_email_templates(user_id, is_active);

-- =============================================================
-- updated_at triggers
-- =============================================================
CREATE OR REPLACE FUNCTION purama_ai.partner_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_partner_config_updated ON purama_ai.partner_agent_config;
CREATE TRIGGER trg_partner_config_updated BEFORE UPDATE ON purama_ai.partner_agent_config
  FOR EACH ROW EXECUTE FUNCTION purama_ai.partner_set_updated_at();

DROP TRIGGER IF EXISTS trg_partner_pros_updated ON purama_ai.partner_prospects;
CREATE TRIGGER trg_partner_pros_updated BEFORE UPDATE ON purama_ai.partner_prospects
  FOR EACH ROW EXECUTE FUNCTION purama_ai.partner_set_updated_at();

DROP TRIGGER IF EXISTS trg_partner_templates_updated ON purama_ai.partner_email_templates;
CREATE TRIGGER trg_partner_templates_updated BEFORE UPDATE ON purama_ai.partner_email_templates
  FOR EACH ROW EXECUTE FUNCTION purama_ai.partner_set_updated_at();

-- =============================================================
-- Privileges
-- =============================================================
GRANT USAGE ON SCHEMA purama_ai TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA purama_ai TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA purama_ai TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA purama_ai GRANT ALL ON TABLES TO anon, authenticated, service_role;
