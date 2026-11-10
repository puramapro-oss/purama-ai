-- Legacy overage credits: one confirmed payment, one immutable credit.
-- No price/quota changes, no credit deletion, no historical proof backfill.
BEGIN;

LOCK TABLE purama_ai.overage_credits IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM purama_ai.overage_credits
    WHERE stripe_session_id IS NOT NULL
    GROUP BY stripe_session_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'overage_duplicate_sessions_require_reconciliation'
      USING ERRCODE = '23505', HINT = 'Reconcile existing duplicate session credits; this migration deletes no data.';
  END IF;
END;
$$;

ALTER TABLE purama_ai.overage_credits
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_event_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_amount_total BIGINT,
  ADD COLUMN IF NOT EXISTS payment_currency TEXT,
  ADD COLUMN IF NOT EXISTS payment_livemode BOOLEAN;

CREATE UNIQUE INDEX IF NOT EXISTS overage_credits_stripe_session_unique
  ON purama_ai.overage_credits (stripe_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS overage_credits_stripe_event_unique
  ON purama_ai.overage_credits (stripe_event_id);

CREATE OR REPLACE FUNCTION purama_ai.credit_overage_pack(
  p_user_id UUID,
  p_stripe_session_id TEXT,
  p_stripe_payment_intent_id TEXT,
  p_stripe_event_id TEXT,
  p_payment_confirmed_at TIMESTAMPTZ,
  p_payment_amount_total BIGINT,
  p_payment_currency TEXT,
  p_payment_livemode BOOLEAN,
  p_actions INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, purama_ai
AS $$
DECLARE
  v_period_start DATE;
  v_credit purama_ai.overage_credits%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
    OR p_stripe_session_id IS NULL OR length(p_stripe_session_id) > 255 OR p_stripe_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR p_stripe_payment_intent_id IS NULL OR length(p_stripe_payment_intent_id) > 255 OR p_stripe_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
    OR p_stripe_event_id IS NULL OR length(p_stripe_event_id) > 255 OR p_stripe_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR p_payment_confirmed_at IS NULL OR NOT isfinite(p_payment_confirmed_at)
    OR p_payment_confirmed_at < '1970-01-01 UTC'::timestamptz
    OR p_payment_confirmed_at > '9999-12-31 23:59:59 UTC'::timestamptz
    OR p_payment_amount_total IS NULL OR p_payment_amount_total <= 0
    OR p_payment_currency IS NULL OR p_payment_currency !~ '^[a-z]{3}$'
    OR p_payment_livemode IS NULL OR p_actions IS NULL OR p_actions <= 0 THEN
    RAISE EXCEPTION 'overage_payment_evidence_invalid' USING ERRCODE = '22023';
  END IF;

  v_period_start := date_trunc('month', p_payment_confirmed_at AT TIME ZONE 'UTC')::date;

  INSERT INTO purama_ai.overage_credits (
    user_id, actions, period_start, stripe_session_id, stripe_payment_intent_id,
    stripe_event_id, payment_confirmed_at, payment_amount_total, payment_currency, payment_livemode
  ) VALUES (
    p_user_id, p_actions, v_period_start, p_stripe_session_id, p_stripe_payment_intent_id,
    p_stripe_event_id, p_payment_confirmed_at, p_payment_amount_total, p_payment_currency, p_payment_livemode
  )
  -- Identical concurrent deliveries can conflict on either unique index.
  -- Arbitrate all uniqueness conflicts, then validate the stored session below.
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_credit;

  IF FOUND THEN
    RETURN jsonb_build_object('credited', true, 'credit_id', v_credit.id, 'period_start', v_credit.period_start);
  END IF;

  SELECT * INTO v_credit FROM purama_ai.overage_credits
  WHERE stripe_session_id = p_stripe_session_id FOR UPDATE;
  IF NOT FOUND
    OR v_credit.user_id IS DISTINCT FROM p_user_id
    OR v_credit.actions IS DISTINCT FROM p_actions
    OR v_credit.period_start IS DISTINCT FROM v_period_start
    OR v_credit.stripe_payment_intent_id IS DISTINCT FROM p_stripe_payment_intent_id
    OR v_credit.payment_confirmed_at IS DISTINCT FROM p_payment_confirmed_at
    OR v_credit.payment_amount_total IS DISTINCT FROM p_payment_amount_total
    OR v_credit.payment_currency IS DISTINCT FROM p_payment_currency
    OR v_credit.payment_livemode IS DISTINCT FROM p_payment_livemode
    OR EXISTS (
      SELECT 1 FROM purama_ai.overage_credits event_credit
      WHERE event_credit.stripe_event_id = p_stripe_event_id
        AND event_credit.stripe_session_id IS DISTINCT FROM p_stripe_session_id
    ) THEN
    -- Includes historical credits without evidence. Never silently mutate them
    -- or grant a second credit in order to make an old replay succeed.
    RAISE EXCEPTION 'overage_session_conflict_requires_reconciliation' USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('credited', false, 'credit_id', v_credit.id, 'period_start', v_credit.period_start);
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.credit_overage_pack(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, BIGINT, TEXT, BOOLEAN, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.credit_overage_pack(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, BIGINT, TEXT, BOOLEAN, INTEGER)
  TO service_role;

COMMIT;
