-- ═══════════════════════════════════════════════════════════════════════════
-- V4.1 — STRIPE CONNECT + PRIMES + FISCAL + OPENTIMESTAMPS
-- Date : 2026-04-22
-- Ref  : STRIPE_CONNECT_KARMA_V4.md §TABLES
-- Note : incrémental (ne duplique pas les tables déjà créées : profiles,
--        subscriptions, referrals, concours, wallets-via-profile, etc.)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. STRIPE CONNECT EXPRESS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.connect_accounts (
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  stripe_account_id text UNIQUE NOT NULL,
  onboarding_completed boolean DEFAULT false,
  payouts_enabled boolean DEFAULT false,
  charges_enabled boolean DEFAULT false,
  kyc_verified_at timestamptz,
  requirements jsonb DEFAULT '{}'::jsonb,
  country text DEFAULT 'FR',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.connect_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users see own connect" ON public.connect_accounts FOR ALL USING (auth.uid() = user_id);

-- ─── 2. WALLET TRANSACTIONS (si pas déjà) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  amount_eur numeric(10,2) NOT NULL,
  direction text NOT NULL CHECK (direction IN ('credit', 'debit')),
  source text NOT NULL, -- prime_j1, prime_j30, prime_j60, nature_reward, referral, mission, withdrawal, refund, cpa
  source_id uuid,
  stripe_transfer_id text,
  description text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON public.wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_source ON public.wallet_transactions(source);
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users see own wallet tx" ON public.wallet_transactions FOR SELECT USING (auth.uid() = user_id);

-- ─── 3. PRIMES (cœur V4.1 Phase 1/2) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.primes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  app_id text NOT NULL DEFAULT 'purama-ai',
  palier_actuel integer DEFAULT 0 CHECK (palier_actuel BETWEEN 0 AND 3),
  montant_verse_eur numeric(10,2) DEFAULT 0,
  montant_total_eur numeric(10,2) DEFAULT 100,
  prime_mode text DEFAULT 'phase1' CHECK (prime_mode IN ('phase1', 'phase2')),
  subscription_payment_check_1 boolean DEFAULT false,
  subscription_payment_check_2 boolean DEFAULT false,
  subscription_payment_check_3 boolean DEFAULT false,
  palier_1_date timestamptz,
  palier_2_date timestamptz,
  palier_3_date timestamptz,
  recuperee boolean DEFAULT false,
  recuperee_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, app_id)
);
CREATE INDEX IF NOT EXISTS idx_primes_user ON public.primes(user_id);
ALTER TABLE public.primes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users see own primes" ON public.primes FOR SELECT USING (auth.uid() = user_id);

-- ─── 4. BOURSES D'INCLUSION ASSO (flag-disabled jusqu'à RNA) ──────────────
CREATE TABLE IF NOT EXISTS public.bourses_inclusion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  profil_social text[] DEFAULT '{}'::text[], -- caf, rural, jeune, senior, demandeur_emploi, etudiant, handicap
  montant_eur numeric(10,2) DEFAULT 100,
  missions_completees integer DEFAULT 0,
  missions_requises integer DEFAULT 5,
  versee boolean DEFAULT false,
  versee_at timestamptz,
  financement_source text, -- subvention_afnic, subvention_fdj, subvention_fdf, etc.
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.bourses_inclusion ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users see own bourse" ON public.bourses_inclusion FOR SELECT USING (auth.uid() = user_id);

-- ─── 5. USER TAX PROFILES (4 profils fiscaux) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_tax_profiles (
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  profile_type text CHECK (profile_type IN ('particulier_occasionnel', 'particulier_bnc', 'autoentrepreneur', 'entreprise')),
  siret text,
  siren text,
  company_name text,
  legal_form text,
  activity_type text,
  tva_franchise boolean DEFAULT true,
  urssaf_mandate_signed_at timestamptz,
  urssaf_mandate_doc_id text,
  pennylane_oauth_token_encrypted text,
  pennylane_company_id text,
  edi_tdfc_enabled boolean DEFAULT false,
  threshold_305_alerted boolean DEFAULT false,
  threshold_bnc_alerted boolean DEFAULT false,
  threshold_tva_alerted boolean DEFAULT false,
  onboarded_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.user_tax_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own tax profile" ON public.user_tax_profiles FOR ALL USING (auth.uid() = user_id);

-- ─── 6. CPA EARNINGS (financement primes — invisible pour user) ───────────
CREATE TABLE IF NOT EXISTS public.cpa_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  app_id text NOT NULL DEFAULT 'purama-ai',
  partner text NOT NULL, -- treezor, binance, oura, noom, qonto, etc.
  amount_eur numeric(10,2) NOT NULL,
  received_at timestamptz NOT NULL,
  covers_prime_palier integer CHECK (covers_prime_palier BETWEEN 1 AND 3),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cpa_user ON public.cpa_earnings(user_id);
ALTER TABLE public.cpa_earnings ENABLE ROW LEVEL SECURITY;
-- Pas de RLS user (CPA = donnée interne Purama), lecture service_role uniquement.

-- ─── 7. REGLEMENTS (jeux-concours + primes, horodatés Bitcoin via OTS) ────
CREATE TABLE IF NOT EXISTS public.reglements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL,
  type text NOT NULL DEFAULT 'jeu_concours' CHECK (type IN ('jeu_concours', 'prime', 'bourse', 'cgv')),
  content_hash text NOT NULL,
  opentimestamps_proof text, -- preuve base64 OpenTimestamps (Bitcoin)
  blockchain text DEFAULT 'bitcoin',
  published_at timestamptz DEFAULT now(),
  content_url text,
  content_markdown text, -- copie du règlement pour verify ultérieur
  metadata jsonb DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_reglements_type ON public.reglements(type, published_at DESC);
ALTER TABLE public.reglements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reglements public read" ON public.reglements FOR SELECT USING (true);

-- ─── 8. SEEDS minimaux ────────────────────────────────────────────────────

-- Prime par défaut Phase 1 pour nouvel user : créée via trigger auth.users (si pas déjà existant)
CREATE OR REPLACE FUNCTION public.init_user_prime() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.primes (user_id, app_id, prime_mode, montant_total_eur)
  VALUES (NEW.id, 'purama-ai', coalesce(current_setting('app.prime_mode', true), 'phase1'), 100)
  ON CONFLICT (user_id, app_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_init_user_prime ON auth.users;
CREATE TRIGGER trigger_init_user_prime
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.init_user_prime();

-- ─── 9. updated_at auto-update ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_connect_upd ON public.connect_accounts;
CREATE TRIGGER trg_connect_upd BEFORE UPDATE ON public.connect_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_primes_upd ON public.primes;
CREATE TRIGGER trg_primes_upd BEFORE UPDATE ON public.primes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_tax_upd ON public.user_tax_profiles;
CREATE TRIGGER trg_tax_upd BEFORE UPDATE ON public.user_tax_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN MIGRATION V4.1
-- ═══════════════════════════════════════════════════════════════════════════
