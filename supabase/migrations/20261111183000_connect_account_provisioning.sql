-- Candidate only: private durable Stripe Connect creation intent.
-- No provider call, payment, existing binding rewrite or destructive migration.
-- Deliberately no auth.users ON DELETE CASCADE: an uncertain external operation
-- must remain traceable after auth deletion. Retention/manual reconciliation of
-- this private journal must be qualified before production rollout.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.connect_account_provisions (
  user_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE,
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
  api_version text NOT NULL,
  provider_context text NOT NULL CHECK (provider_context ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  retry_until timestamptz NOT NULL,
  lease_until timestamptz,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'bound', 'reconcile')),
  reconcile_reason text,
  stripe_account_id text,
  observed_account_ids text[] NOT NULL DEFAULT '{}',
  CHECK (retry_until = created_at + interval '23 hours'),
  CHECK (stripe_account_id IS NULL OR stripe_account_id ~ '^acct_[A-Za-z0-9_]+$'),
  CHECK (state <> 'bound' OR stripe_account_id IS NOT NULL)
);
ALTER TABLE public.connect_account_provisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.connect_account_provisions FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.guard_connect_account_provision_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.user_id, NEW.operation_id, NEW.parameters, NEW.api_version,
         NEW.provider_context, NEW.created_at, NEW.retry_until)
     IS DISTINCT FROM
     ROW(OLD.user_id, OLD.operation_id, OLD.parameters, OLD.api_version,
         OLD.provider_context, OLD.created_at, OLD.retry_until) THEN
    RAISE EXCEPTION 'connect_provision_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connect_account_provision_immutable
BEFORE UPDATE ON public.connect_account_provisions
FOR EACH ROW EXECUTE FUNCTION public.guard_connect_account_provision_immutable();
REVOKE ALL ON FUNCTION public.guard_connect_account_provision_immutable() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_connect_account_provision(
  p_user_id uuid, p_parameters jsonb, p_api_version text, p_provider_context text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET lock_timeout = '5s' AS $$
DECLARE
  provision public.connect_account_provisions%ROWTYPE;
  existing_account text;
  operation uuid := gen_random_uuid();
  observed_now timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_parameters IS NULL OR jsonb_typeof(p_parameters) <> 'object'
     OR p_parameters ? 'metadata'
     OR p_api_version IS DISTINCT FROM '2025-09-30.clover'
     OR p_provider_context IS NULL OR p_provider_context !~ '^[0-9a-f]{64}$'
     OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
  END IF;

  -- A single canonical resolution owns both the journal and the binding.
  -- Historical bindings without a journal remain valid; a quarantined intent
  -- cannot be bypassed merely because an earlier binding still exists.
  SELECT * INTO provision FROM public.connect_account_provisions WHERE user_id = p_user_id FOR UPDATE;
  SELECT stripe_account_id INTO existing_account FROM public.connect_accounts WHERE user_id = p_user_id;
  IF provision.user_id IS NULL AND existing_account IS NOT NULL THEN
    RETURN jsonb_build_object('decision', 'bound', 'user_id', p_user_id, 'stripe_account_id', existing_account);
  END IF;

  observed_now := clock_timestamp();
  INSERT INTO public.connect_account_provisions
    (user_id, operation_id, parameters, api_version, provider_context, created_at, retry_until)
  VALUES (p_user_id, operation,
    p_parameters || jsonb_build_object('metadata', jsonb_build_object('purama_connect_operation', operation::text)),
    p_api_version, p_provider_context, observed_now, observed_now + interval '23 hours')
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO STRICT provision FROM public.connect_account_provisions WHERE user_id = p_user_id FOR UPDATE;
  -- Read the time after waiting for the row lock, not before it.
  observed_now := clock_timestamp();
  IF provision.state = 'reconcile' THEN
    RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
  END IF;
  SELECT stripe_account_id INTO existing_account FROM public.connect_accounts WHERE user_id = p_user_id;
  IF provision.state = 'bound' OR existing_account IS NOT NULL THEN
    IF provision.state = 'bound' AND existing_account = provision.stripe_account_id THEN
      -- Credential rotation cannot create anything here; an already confirmed
      -- binding need not match the historical creation credential fingerprint.
      RETURN jsonb_build_object('decision', 'bound', 'user_id', p_user_id, 'stripe_account_id', existing_account);
    END IF;
    UPDATE public.connect_account_provisions SET state = 'reconcile', reconcile_reason = 'binding_conflict', lease_until = NULL WHERE user_id = p_user_id;
    RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
  END IF;
  IF provision.provider_context <> p_provider_context OR provision.api_version <> p_api_version THEN
    RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
  END IF;
  IF observed_now >= provision.retry_until - interval '15 seconds' THEN
    UPDATE public.connect_account_provisions SET state = 'reconcile',
      reconcile_reason = coalesce(reconcile_reason, 'expired'), lease_until = NULL WHERE user_id = p_user_id;
    RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
  END IF;
  IF provision.lease_until IS NOT NULL AND observed_now < provision.lease_until THEN
    RETURN jsonb_build_object('decision', 'busy', 'user_id', p_user_id);
  END IF;
  UPDATE public.connect_account_provisions SET lease_until = observed_now + interval '60 seconds'
    WHERE user_id = p_user_id RETURNING * INTO provision;
  RETURN jsonb_build_object(
    'decision', 'create', 'user_id', provision.user_id, 'operation_id', provision.operation_id,
    'parameters', provision.parameters, 'api_version', provision.api_version,
    'provider_context', provision.provider_context,
    'idempotency_key', 'connect-create:' || provision.operation_id::text,
    'server_now', observed_now, 'retry_until', provision.retry_until, 'lease_until', provision.lease_until
  );
END;
$$;
REVOKE ALL ON FUNCTION public.claim_connect_account_provision(uuid, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_connect_account_provision(uuid, jsonb, text, text) TO service_role;

CREATE FUNCTION public.finalize_connect_account_provision(
  p_user_id uuid, p_operation_id uuid, p_account_id text, p_provider_verified boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET lock_timeout = '5s' AS $$
DECLARE
  provision public.connect_account_provisions%ROWTYPE;
  linked_account text;
  user_exists boolean;
BEGIN
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_account_id IS NULL
     OR p_account_id !~ '^acct_[A-Za-z0-9_]+$' THEN
    RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
  END IF;
  SELECT * INTO provision FROM public.connect_account_provisions WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR provision.operation_id <> p_operation_id THEN
    RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
  END IF;
  -- Serialize the final FK insertion with concurrent authentication deletion.
  -- If deletion won, retain the receipt privately without recreating a user.
  PERFORM id FROM auth.users WHERE id = p_user_id FOR KEY SHARE;
  user_exists := FOUND;

  -- Retain every observed external account ID even on a conflicting receipt.
  UPDATE public.connect_account_provisions SET
    observed_account_ids = CASE WHEN p_account_id = ANY(observed_account_ids)
      THEN observed_account_ids ELSE array_append(observed_account_ids, p_account_id) END,
    lease_until = NULL
    WHERE user_id = p_user_id;
  IF (provision.state = 'reconcile' AND provision.reconcile_reason IS DISTINCT FROM 'expired')
     OR cardinality(provision.observed_account_ids) > 1
     OR (cardinality(provision.observed_account_ids) = 1 AND NOT p_account_id = ANY(provision.observed_account_ids))
     OR p_provider_verified IS DISTINCT FROM true
     OR (provision.stripe_account_id IS NOT NULL AND provision.stripe_account_id <> p_account_id)
     OR NOT user_exists THEN
    UPDATE public.connect_account_provisions SET state = 'reconcile', reconcile_reason =
      coalesce(nullif(reconcile_reason, 'expired'), CASE
        WHEN NOT user_exists THEN 'user_missing'
        WHEN p_provider_verified IS DISTINCT FROM true THEN 'provider_unverified'
        ELSE 'ambiguous_accounts' END)
      WHERE user_id = p_user_id;
    RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
  END IF;

  -- One transaction owns both the operation receipt and the user/account link.
  -- ON CONFLICT never replaces a historical link (either unique constraint).
  INSERT INTO public.connect_accounts
    (user_id, stripe_account_id, onboarding_completed, payouts_enabled, charges_enabled, country)
  VALUES (p_user_id, p_account_id, false, false, false, 'FR')
  ON CONFLICT DO NOTHING;
  SELECT stripe_account_id INTO linked_account FROM public.connect_accounts WHERE user_id = p_user_id;
  IF linked_account IS DISTINCT FROM p_account_id THEN
    UPDATE public.connect_account_provisions SET state = 'reconcile', reconcile_reason = 'binding_conflict', stripe_account_id = p_account_id
      WHERE user_id = p_user_id;
    RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
  END IF;
  UPDATE public.connect_account_provisions SET state = 'bound', reconcile_reason = NULL, stripe_account_id = p_account_id
    WHERE user_id = p_user_id;
  RETURN jsonb_build_object('decision', 'bound', 'user_id', p_user_id,
    'operation_id', p_operation_id, 'stripe_account_id', p_account_id);
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_connect_account_provision(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_connect_account_provision(uuid, uuid, text, boolean) TO service_role;

COMMENT ON TABLE public.connect_account_provisions IS
  'Private durable Connect intents. No automatic reset/delete or provider compensation. Reconcile uncertain outcomes and qualify retention before production.';
COMMIT;
