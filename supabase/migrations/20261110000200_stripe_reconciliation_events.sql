-- Legacy Stripe ingress evidence only. This is not a wallet, an earned-commission
-- ledger, a payout queue or an approval of the historical annual commission.
-- No historical row, rate, right or commission policy is rewritten. Additional
-- economic/customer uniqueness checks fail rather than deleting old duplicates.
BEGIN;

CREATE TABLE purama_ai.stripe_reconciliation_events (
  stripe_account_key text NOT NULL CHECK (length(stripe_account_key) BETWEEN 1 AND 255),
  livemode boolean NOT NULL,
  event_id text NOT NULL CHECK (event_id LIKE 'evt\_%' ESCAPE '\' AND length(event_id) <= 255),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 255),
  event_created bigint NOT NULL CHECK (event_created >= 0),
  api_version text,
  object_id text,
  source_facts jsonb NOT NULL CHECK (jsonb_typeof(source_facts) = 'object'),
  evidence_version integer NOT NULL CHECK (evidence_version = 1),
  reconciliation text NOT NULL DEFAULT 'required' CHECK (reconciliation = 'required'),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stripe_account_key, livemode, event_id)
);

CREATE INDEX stripe_reconciliation_events_object_idx
  ON purama_ai.stripe_reconciliation_events (stripe_account_key, livemode, object_id);
CREATE INDEX stripe_reconciliation_events_received_idx
  ON purama_ai.stripe_reconciliation_events (received_at);

ALTER TABLE purama_ai.stripe_reconciliation_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.stripe_reconciliation_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON purama_ai.stripe_reconciliation_events TO service_role;
CREATE POLICY stripe_reconciliation_service_read
  ON purama_ai.stripe_reconciliation_events FOR SELECT TO service_role USING (true);

CREATE FUNCTION purama_ai.record_stripe_reconciliation_event(p_event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, purama_ai
AS $record_event$
DECLARE
  inserted_id text;
  previous purama_ai.stripe_reconciliation_events%ROWTYPE;
BEGIN
  IF p_event IS NULL OR jsonb_typeof(p_event) <> 'object'
    OR octet_length(p_event::text) > 131072
    OR p_event->>'version' IS DISTINCT FROM '1'
    OR jsonb_typeof(p_event->'stripe_account_key') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_event->'event_id') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_event->'event_type') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_event->'livemode') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_event->'event_created') IS DISTINCT FROM 'number'
    OR (p_event->>'event_created') !~ '^[0-9]+$'
    OR jsonb_typeof(p_event->'source_facts') IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'Invalid Stripe reconciliation envelope' USING ERRCODE = '22023';
  END IF;

  INSERT INTO purama_ai.stripe_reconciliation_events (
    stripe_account_key, livemode, event_id, event_type, event_created,
    api_version, object_id, source_facts, evidence_version
  ) VALUES (
    p_event->>'stripe_account_key', (p_event->>'livemode')::boolean,
    p_event->>'event_id', p_event->>'event_type', (p_event->>'event_created')::bigint,
    p_event->>'api_version', p_event->>'object_id', p_event->'source_facts', 1
  ) ON CONFLICT (stripe_account_key, livemode, event_id) DO NOTHING
  RETURNING event_id INTO inserted_id;

  IF inserted_id IS NULL THEN
    SELECT * INTO STRICT previous FROM purama_ai.stripe_reconciliation_events
      WHERE stripe_account_key = p_event->>'stripe_account_key'
        AND livemode = (p_event->>'livemode')::boolean
        AND event_id = p_event->>'event_id';
    IF previous.event_type IS DISTINCT FROM p_event->>'event_type'
      OR previous.event_created IS DISTINCT FROM (p_event->>'event_created')::bigint
      OR previous.api_version IS DISTINCT FROM p_event->>'api_version'
      OR previous.object_id IS DISTINCT FROM p_event->>'object_id'
      OR previous.source_facts IS DISTINCT FROM p_event->'source_facts'
    THEN
      -- Never overwrite a signed observation or silently accept conflicting data.
      RAISE EXCEPTION 'Conflicting Stripe event evidence' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN jsonb_build_object('recorded', true, 'event_id', p_event->>'event_id',
    'duplicate', inserted_id IS NULL, 'reconciliation', 'required');
END
$record_event$;

REVOKE ALL ON FUNCTION purama_ai.record_stripe_reconciliation_event(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.record_stripe_reconciliation_event(jsonb) TO service_role;

COMMENT ON TABLE purama_ai.stripe_reconciliation_events IS
  'Authenticated provider observations awaiting an explicit commerce policy and settlement reconciliation. No balance or commission is granted.';

-- The existing overage path had no economic uniqueness constraint. Never delete
-- duplicate historical credits to make this pass: stop deployment for review.
DO $overage_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM purama_ai.overage_credits
    WHERE stripe_session_id IS NOT NULL
    GROUP BY stripe_session_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate historical Stripe overage credits require reconciliation before migration';
  END IF;
END
$overage_preflight$;

CREATE UNIQUE INDEX overage_credits_stripe_session_unique
  ON purama_ai.overage_credits (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

-- The legacy handler assumes one user for a platform customer. Enforce that
-- assumption across concurrent first bindings; preserve any ambiguous history.
DO $customer_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM purama_ai.subscriptions
    WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id <> ''
    GROUP BY stripe_customer_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate historical Stripe customer bindings require reconciliation before migration';
  END IF;
END
$customer_preflight$;

CREATE UNIQUE INDEX subscriptions_stripe_customer_unique
  ON purama_ai.subscriptions (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id <> '';

CREATE FUNCTION purama_ai.apply_stripe_overage_credit(p_event_id text, p_livemode boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, purama_ai
AS $credit_overage$
DECLARE
  evidence purama_ai.stripe_reconciliation_events%ROWTYPE;
  existing purama_ai.overage_credits%ROWTYPE;
  target_user uuid;
  inserted_id uuid;
BEGIN
  SELECT * INTO STRICT evidence FROM purama_ai.stripe_reconciliation_events
    WHERE stripe_account_key = 'platform' AND livemode = p_livemode AND event_id = p_event_id;

  IF evidence.event_type NOT IN ('checkout.session.completed', 'checkout.session.async_payment_succeeded')
    OR evidence.object_id IS NULL OR evidence.object_id NOT LIKE 'cs\_%' ESCAPE '\'
    OR evidence.source_facts->>'checkout_mode' IS DISTINCT FROM 'payment'
    OR evidence.source_facts->>'checkout_payment_status' IS DISTINCT FROM 'paid'
    OR evidence.source_facts->>'checkout_purchase_type' IS DISTINCT FROM 'overage_pack'
    OR evidence.source_facts#>>'{attribution_hints,user_id}' IS NULL
  THEN
    RAISE EXCEPTION 'Paid Stripe overage evidence is missing or invalid' USING ERRCODE = '22023';
  END IF;
  target_user := (evidence.source_facts#>>'{attribution_hints,user_id}')::uuid;

  -- Same pack and credit-month behavior as the existing checkout. The unique
  -- session identity makes retries (even after a month boundary) harmless.
  INSERT INTO purama_ai.overage_credits (user_id, actions, period_start, stripe_session_id)
    VALUES (target_user, 2000, date_trunc('month', now() AT TIME ZONE 'UTC')::date, evidence.object_id)
    ON CONFLICT (stripe_session_id) WHERE stripe_session_id IS NOT NULL DO NOTHING
    RETURNING id INTO inserted_id;

  IF inserted_id IS NULL THEN
    SELECT * INTO STRICT existing FROM purama_ai.overage_credits WHERE stripe_session_id = evidence.object_id;
    IF existing.user_id IS DISTINCT FROM target_user OR existing.actions IS DISTINCT FROM 2000 THEN
      RAISE EXCEPTION 'Conflicting historical overage credit; reconciliation required' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN jsonb_build_object('credited', true, 'session_id', evidence.object_id, 'duplicate', inserted_id IS NULL);
END
$credit_overage$;

REVOKE ALL ON FUNCTION purama_ai.apply_stripe_overage_credit(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.apply_stripe_overage_credit(text, boolean) TO service_role;

COMMIT;
