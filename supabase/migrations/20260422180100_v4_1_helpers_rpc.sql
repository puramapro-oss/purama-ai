-- ─── V4.1 · Helper RPCs (wallet increment, prime payment tracking) ──────

-- Incrémente le solde wallet d'un user (appelé depuis Edge Function prime-trigger-palier).
CREATE OR REPLACE FUNCTION public.increment_wallet_balance(p_user_id uuid, p_amount numeric)
RETURNS numeric AS $$
DECLARE v_new numeric;
BEGIN
  UPDATE public.profiles
     SET wallet_balance = COALESCE(wallet_balance, 0) + p_amount
   WHERE id = p_user_id
   RETURNING wallet_balance INTO v_new;
  RETURN COALESCE(v_new, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.increment_wallet_balance(uuid, numeric) TO service_role;

-- Marque le prochain palier de paiement d'abonnement OK pour un user donné.
-- Appelé par le webhook Stripe invoice.paid.
CREATE OR REPLACE FUNCTION public.prime_mark_payment(p_user_id uuid, p_app_id text DEFAULT 'purama-ai')
RETURNS integer AS $$
DECLARE v_next_palier integer;
BEGIN
  -- Compte les paiements déjà marqués pour ce user/app
  SELECT CASE
           WHEN subscription_payment_check_3 THEN 3
           WHEN subscription_payment_check_2 THEN 2
           WHEN subscription_payment_check_1 THEN 1
           ELSE 0
         END
    INTO v_next_palier
    FROM public.primes
   WHERE user_id = p_user_id AND app_id = p_app_id;

  IF v_next_palier IS NULL THEN
    INSERT INTO public.primes (user_id, app_id, subscription_payment_check_1)
    VALUES (p_user_id, p_app_id, true)
    ON CONFLICT (user_id, app_id) DO UPDATE SET subscription_payment_check_1 = true;
    RETURN 1;
  END IF;

  v_next_palier := v_next_palier + 1;
  IF v_next_palier > 3 THEN RETURN 0; END IF;

  IF v_next_palier = 1 THEN
    UPDATE public.primes SET subscription_payment_check_1 = true WHERE user_id = p_user_id AND app_id = p_app_id;
  ELSIF v_next_palier = 2 THEN
    UPDATE public.primes SET subscription_payment_check_2 = true WHERE user_id = p_user_id AND app_id = p_app_id;
  ELSIF v_next_palier = 3 THEN
    UPDATE public.primes SET subscription_payment_check_3 = true WHERE user_id = p_user_id AND app_id = p_app_id;
  END IF;

  RETURN v_next_palier;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.prime_mark_payment(uuid, text) TO service_role;

-- Suspend le palier courant en cas d'échec de paiement (appelé par invoice.payment_failed).
CREATE OR REPLACE FUNCTION public.prime_suspend_payment(p_user_id uuid, p_app_id text DEFAULT 'purama-ai')
RETURNS void AS $$
BEGIN
  UPDATE public.primes
     SET subscription_payment_check_1 = CASE WHEN palier_actuel < 1 THEN false ELSE subscription_payment_check_1 END,
         subscription_payment_check_2 = CASE WHEN palier_actuel < 2 THEN false ELSE subscription_payment_check_2 END,
         subscription_payment_check_3 = CASE WHEN palier_actuel < 3 THEN false ELSE subscription_payment_check_3 END
   WHERE user_id = p_user_id AND app_id = p_app_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.prime_suspend_payment(uuid, text) TO service_role;
