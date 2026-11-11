-- One platform subscription projection, with an explicit provider identity and
-- a database-owned revision. No historical Stripe identity is guessed/backfilled.
-- Requires the existing purama_ai table, atomic trial admission and customer
-- uniqueness migrations; this does not copy/move public.subscriptions.
BEGIN;

ALTER TABLE purama_ai.subscriptions
  ADD COLUMN stripe_subscription_id TEXT,
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT subscriptions_stripe_subscription_identity_check CHECK (
    stripe_subscription_id IS NULL OR (
      length(stripe_subscription_id) <= 255
      AND stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
      AND stripe_customer_id IS NOT NULL
      AND btrim(stripe_customer_id) <> ''
    )
  ),
  ADD CONSTRAINT subscriptions_revision_safe_integer_check
    CHECK (revision BETWEEN 0 AND 9007199254740991);

CREATE UNIQUE INDEX subscriptions_stripe_subscription_unique
  ON purama_ai.subscriptions (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE FUNCTION purama_ai.advance_subscription_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.revision >= 9007199254740991 THEN
    RAISE EXCEPTION 'Subscription revision exhausted; reconciliation required'
      USING ERRCODE = '22003';
  END IF;
  -- Ignore a caller-supplied NEW.revision. Every actual row update, including a
  -- confirmation with unchanged business fields, invalidates older snapshots.
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.advance_subscription_revision()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.advance_subscription_revision() TO service_role;

CREATE TRIGGER subscriptions_revision_before_update
  BEFORE UPDATE ON purama_ai.subscriptions
  FOR EACH ROW EXECUTE FUNCTION purama_ai.advance_subscription_revision();

COMMENT ON COLUMN purama_ai.subscriptions.stripe_subscription_id IS
  'Verified platform Stripe subscription identity; NULL remains unbound and is never inferred by this migration.';
COMMENT ON COLUMN purama_ai.subscriptions.revision IS
  'Database-owned compare-and-swap revision, incremented for every row update independently of timestamps.';

-- A newly admitted local trial is independent of any previous Stripe
-- subscription. Keep the atomic admission policy and trial markers unchanged.
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
    stripe_subscription_id = NULL,
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

COMMIT;
