-- Fix critique de sécurité (2026-07-27, cf ERRORS.md) : la policy RLS INSERT de
-- purama_ai.subscriptions permettait à n'importe quel utilisateur authentifié de s'auto-attribuer
-- N'IMPORTE QUEL plan (ex: {plan_type:'ultime', status:'active'}) par un simple INSERT REST, sans
-- jamais passer par Stripe — vérifié réellement exploitable (POST direct → 201, ligne persistée).
-- Remplace la policy pour n'autoriser l'auto-insertion QUE de l'état par défaut sûr (free/active).
-- Toute autre valeur ne peut venir que du service role (stripe-webhook) ou de la fonction
-- start_trial() ci-dessous (SECURITY DEFINER, contrôlée).

DROP POLICY IF EXISTS "Users can insert their own subscription" ON purama_ai.subscriptions;
CREATE POLICY "Users can insert their own free subscription" ON purama_ai.subscriptions
  FOR INSERT
  WITH CHECK (auth.uid() = user_id AND plan_type = 'free' AND status = 'active');

-- Empêche les lignes multiples pour un même utilisateur (upsert propre + ferme un second vecteur
-- d'abus : insérer plusieurs lignes 'free' valides puis compter sur une race pour en glisser une autre).
ALTER TABLE purama_ai.subscriptions
  ADD CONSTRAINT subscriptions_user_id_unique UNIQUE (user_id);

-- Essai 14 jours "Premium gratuit, sans carte" (brief PRICING & OFFRE IRRÉSISTIBLE).
ALTER TABLE purama_ai.subscriptions
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS has_used_trial BOOLEAN NOT NULL DEFAULT false;

-- start_trial : seule façon d'obtenir un plan payant sans Stripe. SECURITY DEFINER pour pouvoir
-- upsert au-delà de ce que la policy INSERT permet — mais entièrement contrôlée côté serveur
-- (1 essai par utilisateur, jamais 2 fois, jamais un plan arbitraire hors de la liste autorisée).
CREATE OR REPLACE FUNCTION purama_ai.start_trial(p_plan_type TEXT)
RETURNS purama_ai.subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = purama_ai, public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_existing purama_ai.subscriptions;
  v_result purama_ai.subscriptions;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Non authentifié';
  END IF;

  IF p_plan_type NOT IN ('starter', 'pro', 'ultime') THEN
    RAISE EXCEPTION 'Plan invalide pour un essai : %', p_plan_type;
  END IF;

  SELECT * INTO v_existing FROM purama_ai.subscriptions WHERE user_id = v_user_id;

  IF v_existing.has_used_trial THEN
    RAISE EXCEPTION 'Essai déjà utilisé — 1 seul essai gratuit par compte';
  END IF;

  IF v_existing.status = 'active' THEN
    RAISE EXCEPTION 'Déjà abonné — passe par le portail de facturation pour changer de plan';
  END IF;

  INSERT INTO purama_ai.subscriptions (user_id, plan_type, status, trial_ends_at, has_used_trial)
  VALUES (v_user_id, p_plan_type, 'trialing', now() + interval '14 days', true)
  ON CONFLICT (user_id) DO UPDATE SET
    plan_type = EXCLUDED.plan_type,
    status = 'trialing',
    trial_ends_at = now() + interval '14 days',
    has_used_trial = true,
    updated_at = now()
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION purama_ai.start_trial(TEXT) TO authenticated;
