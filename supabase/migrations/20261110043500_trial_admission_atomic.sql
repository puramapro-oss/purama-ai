-- Requires the existing purama_ai.subscriptions table and the July trial migration.
-- This does not move/copy public.subscriptions or activate any customer trial.
BEGIN;

CREATE OR REPLACE FUNCTION purama_ai.start_trial(p_plan_type TEXT)
RETURNS purama_ai.subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_existing purama_ai.subscriptions;
  v_result purama_ai.subscriptions;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Non authentifié';
  END IF;
  IF p_plan_type IS NULL OR p_plan_type NOT IN ('starter', 'pro', 'ultime') THEN
    RAISE EXCEPTION 'Plan invalide pour un essai : %', p_plan_type;
  END IF;

  -- The conflict predicate is evaluated while holding the conflicting row lock.
  -- Unlike a SELECT followed by an unconditional upsert, this also covers two
  -- requests which both start before the user's first subscription exists.
  INSERT INTO purama_ai.subscriptions AS current_subscription
    (user_id, plan_type, status, trial_ends_at, has_used_trial)
  VALUES (v_user_id, p_plan_type, 'trialing', now() + interval '14 days', true)
  ON CONFLICT (user_id) DO UPDATE SET
    plan_type = EXCLUDED.plan_type,
    status = EXCLUDED.status,
    trial_ends_at = EXCLUDED.trial_ends_at,
    has_used_trial = true,
    updated_at = now()
  WHERE current_subscription.has_used_trial IS FALSE
    AND current_subscription.plan_type IS NOT NULL
    AND current_subscription.status IS NOT NULL
    AND current_subscription.status <> 'trialing'
    AND (current_subscription.status <> 'active' OR current_subscription.plan_type = 'free')
  RETURNING * INTO v_result;

  IF FOUND THEN
    RETURN v_result;
  END IF;

  -- No mutation occurred. The upsert still holds the row lock, so this message
  -- describes the state on which admission was actually refused.
  SELECT * INTO v_existing FROM purama_ai.subscriptions WHERE user_id = v_user_id;
  IF v_existing.has_used_trial OR v_existing.status = 'trialing' THEN
    RAISE EXCEPTION 'Essai déjà utilisé ou en cours — 1 seul essai gratuit par compte';
  END IF;
  IF v_existing.status = 'active' AND v_existing.plan_type <> 'free' THEN
    RAISE EXCEPTION 'Déjà abonné — passe par le portail de facturation pour changer de plan';
  END IF;
  RAISE EXCEPTION 'État de l''abonnement incompatible avec un essai';
END;
$$;

-- Historical ALL grants included TRUNCATE, which is not protected by RLS.
-- Versioned clients only read this table and call start_trial. Webhooks and
-- other trusted service_role writers retain their existing privileges.
REVOKE ALL ON TABLE purama_ai.subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE purama_ai.subscriptions TO authenticated;
REVOKE ALL ON FUNCTION purama_ai.start_trial(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION purama_ai.start_trial(TEXT) TO authenticated;

COMMIT;
