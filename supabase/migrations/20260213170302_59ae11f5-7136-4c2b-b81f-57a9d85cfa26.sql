
-- Add referral columns to profiles
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS code_parrainage TEXT UNIQUE,
ADD COLUMN IF NOT EXISTS parraine_par TEXT,
ADD COLUMN IF NOT EXISTS nombre_filleuls INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS palier_actuel INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS gains_totaux NUMERIC DEFAULT 0;

-- Referrals table
CREATE TABLE public.referrals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  parrain_user_id UUID NOT NULL,
  filleul_user_id UUID,
  code_parrainage TEXT NOT NULL,
  filleul_email TEXT,
  statut TEXT DEFAULT 'en_attente',
  commission_premier_mois NUMERIC DEFAULT 0,
  commission_recurrente NUMERIC DEFAULT 0,
  places_concours_semaine INTEGER DEFAULT 0,
  places_concours_mois INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Referral commissions
CREATE TABLE public.referral_commissions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  parrain_user_id UUID NOT NULL,
  filleul_user_id UUID NOT NULL,
  montant NUMERIC NOT NULL,
  type TEXT DEFAULT 'premier_mois',
  mois TEXT,
  statut TEXT DEFAULT 'en_attente',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Referral tiers
CREATE TABLE public.paliers_parrainage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  palier INTEGER NOT NULL,
  prime_type TEXT NOT NULL,
  prime_description TEXT NOT NULL,
  atteint_le TIMESTAMPTZ DEFAULT NOW(),
  prime_reclamee BOOLEAN DEFAULT FALSE
);

-- Contests
CREATE TABLE public.concours (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL,
  titre TEXT NOT NULL,
  description TEXT,
  date_debut TIMESTAMPTZ NOT NULL,
  date_fin TIMESTAMPTZ NOT NULL,
  cagnotte NUMERIC DEFAULT 0,
  pourcentage_ca NUMERIC NOT NULL,
  statut TEXT DEFAULT 'actif',
  gagnants JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Contest participations
CREATE TABLE public.participations_concours (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  concours_id UUID REFERENCES public.concours(id) ON DELETE CASCADE NOT NULL,
  user_id UUID NOT NULL,
  nombre_places INTEGER DEFAULT 1,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Monthly ranking
CREATE TABLE public.classement_mensuel (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  mois TEXT NOT NULL,
  cagnotte NUMERIC DEFAULT 0,
  statut TEXT DEFAULT 'actif',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ranking submissions
CREATE TABLE public.candidatures_classement (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  classement_id UUID REFERENCES public.classement_mensuel(id) ON DELETE CASCADE NOT NULL,
  user_id UUID NOT NULL,
  site_url TEXT NOT NULL,
  description_impact TEXT NOT NULL,
  categorie_impact TEXT,
  agents_utilises TEXT[] DEFAULT '{}',
  score_ia NUMERIC DEFAULT 0,
  analyse_ia TEXT,
  rang INTEGER,
  gains NUMERIC DEFAULT 0,
  verifie_agents BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paliers_parrainage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.concours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participations_concours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classement_mensuel ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidatures_classement ENABLE ROW LEVEL SECURITY;

-- Policies: referrals
CREATE POLICY "read_own_referrals" ON public.referrals FOR SELECT USING (auth.uid() = parrain_user_id OR auth.uid() = filleul_user_id);
CREATE POLICY "insert_own_referrals" ON public.referrals FOR INSERT WITH CHECK (auth.uid() = parrain_user_id);
CREATE POLICY "update_own_referrals" ON public.referrals FOR UPDATE USING (auth.uid() = parrain_user_id);

-- Policies: referral_commissions
CREATE POLICY "read_own_ref_commissions" ON public.referral_commissions FOR SELECT USING (auth.uid() = parrain_user_id);

-- Policies: paliers
CREATE POLICY "read_own_paliers" ON public.paliers_parrainage FOR SELECT USING (auth.uid() = user_id);

-- Policies: concours (public read for authenticated)
CREATE POLICY "read_concours" ON public.concours FOR SELECT TO authenticated USING (true);

-- Policies: participations
CREATE POLICY "read_own_participations" ON public.participations_concours FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "insert_own_participations" ON public.participations_concours FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Policies: classement (public read)
CREATE POLICY "read_classement" ON public.classement_mensuel FOR SELECT TO authenticated USING (true);

-- Policies: candidatures (public read for rankings, insert own)
CREATE POLICY "read_candidatures" ON public.candidatures_classement FOR SELECT TO authenticated USING (true);
CREATE POLICY "insert_own_candidature" ON public.candidatures_classement FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Trigger: generate referral code on profile creation
CREATE OR REPLACE FUNCTION public.generate_referral_code()
RETURNS TRIGGER AS $$
BEGIN
  NEW.code_parrainage := 'PURAMA-' || UPPER(SUBSTRING(MD5(NEW.user_id::text) FROM 1 FOR 8));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public';

CREATE OR REPLACE TRIGGER on_profile_created_referral
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.generate_referral_code();

-- Generate codes for existing profiles that don't have one
UPDATE public.profiles 
SET code_parrainage = 'PURAMA-' || UPPER(SUBSTRING(MD5(user_id::text) FROM 1 FOR 8))
WHERE code_parrainage IS NULL;
