-- Packs de dépassement +2000 actions = 19€ (brief PRICING & OFFRE IRRÉSISTIBLE). Achat ponctuel
-- Stripe (mode "payment", pas "subscription") crédité au quota du mois en cours via stripe-webhook.
-- BLOQUÉ EN LIVE tant que le pare-feu VPS empêche create-checkout/stripe-webhook de joindre Stripe
-- (cf ERRORS.md 2026-07-27) — code complet et prêt, jamais testé de bout en bout avec un vrai paiement.

CREATE TABLE IF NOT EXISTS purama_ai.overage_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actions INTEGER NOT NULL DEFAULT 2000,
  period_start DATE NOT NULL,
  stripe_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE purama_ai.overage_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view their own overage credits" ON purama_ai.overage_credits;
CREATE POLICY "Users view their own overage credits" ON purama_ai.overage_credits
  FOR SELECT
  USING (auth.uid() = user_id);
-- Pas de policy INSERT/UPDATE/DELETE pour les users : uniquement service_role (stripe-webhook).

CREATE INDEX IF NOT EXISTS idx_overage_credits_user_period ON purama_ai.overage_credits(user_id, period_start);
