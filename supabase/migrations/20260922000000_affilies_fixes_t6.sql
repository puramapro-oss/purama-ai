-- ════════════════════════════════════════════════════════════════════
-- Purama AI — AFFILIES-APPS T6 fixes (QA-T5-p3, QA-T8-passe5, F1-go-page-to-route-suite)
-- ════════════════════════════════════════════════════════════════════
-- Idempotent : safe to re-run. LOCALE UNIQUEMENT — jamais appliquée au VPS (gel).

-- Fix F5 (a) — QA-T8-passe5 / F1-go-page-to-route-suite : le client (anon/authenticated)
-- ne peut lire AUCUNE ligne `influencers` autre que la sienne (seule policy SELECT
-- existante : "Influencers can view their own profile" USING auth.uid() = user_id).
-- Le lookup client-side par promo_code dans Pricing.tsx est donc TOUJOURS bloqué par
-- RLS pour un vrai code tiers → resoudreAttribution refuse systématiquement, la remise
-- et l'attribution restent mortes en pratique malgré le raccordement AFFILIES-APPS.
--
-- Fix : RPC SECURITY DEFINER à surface minimale — retourne UNIQUEMENT { user_id } d'un
-- influenceur SIGNÉ et non expiré (mêmes règles que create-checkout:81-90), jamais les
-- autres colonnes (commission_rate, total_revenue, beneficiary_name...). create-checkout
-- reste la SEULE source de vérité pour l'application réelle de la remise (revalidation
-- serveur intégrale, cette RPC ne fait qu'un aperçu client pour le motif FR affiché).
CREATE OR REPLACE FUNCTION public.resolve_referral_code(code_maj TEXT)
RETURNS TABLE(user_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT i.user_id
  FROM public.influencers i
  WHERE i.promo_code = code_maj
    AND i.contract_status = 'signed'
    AND i.expires_at > now()
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_referral_code(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_referral_code(TEXT) TO authenticated;

-- Fix F5 (b) — QA-T5-p3 : 0 idempotence sur la création de commission au webhook
-- checkout.session.completed. Stripe redélivre le MÊME event.id après un timeout/erreur
-- réseau côté receveur — sans garde, chaque redélivraison recréait une ligne
-- `commissions` pour le MÊME abonnement (double paiement de commission). subscription_id
-- est stable par session Stripe (1 abonnement = 1 checkout) : une seule commission
-- possible par abonnement. Le handler applicatif gère déjà 23505 en idempotent.
ALTER TABLE public.commissions
  ADD CONSTRAINT commissions_subscription_id_unique UNIQUE (subscription_id);
