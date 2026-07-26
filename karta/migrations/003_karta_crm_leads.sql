-- KARTA Engine — Phase 2 : table CRM générique pour les agents "action" CRM Intelligent + Machine de Suivi
SET search_path TO purama_ai;

CREATE TABLE IF NOT EXISTS purama_ai.karta_crm_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,

  stage TEXT NOT NULL DEFAULT 'new', -- new, qualified, follow_up, won, lost
  score INTEGER, -- 0-100, calculé par l'agent CRM
  source TEXT, -- manuel, import, formulaire...

  last_contact_at TIMESTAMPTZ,
  next_follow_up_at TIMESTAMPTZ,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE purama_ai.karta_crm_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own karta crm leads" ON purama_ai.karta_crm_leads;
CREATE POLICY "Users manage their own karta crm leads"
  ON purama_ai.karta_crm_leads FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_karta_crm_leads_user_stage ON purama_ai.karta_crm_leads(user_id, stage);
