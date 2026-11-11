-- Incremental correction of the existing durable Connect protocol.
-- Preserve all bindings/intents. Historical links require reconciliation;
-- SQL NULL is resolution-only and cannot reserve or renew a provider creation.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.claim_connect_account_provision(
  p_user_id uuid, p_parameters jsonb, p_api_version text, p_provider_context text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET lock_timeout = '5s' AS $$
DECLARE
  provision public.connect_account_provisions%ROWTYPE;
  existing_account text;
  operation uuid;
  observed_now timestamptz;
BEGIN
  IF p_user_id IS NULL
     OR (p_parameters IS NOT NULL AND (jsonb_typeof(p_parameters) <> 'object' OR p_parameters ? 'metadata'))
     OR p_api_version IS DISTINCT FROM '2025-09-30.clover'
     OR p_provider_context IS NULL OR p_provider_context !~ '^[0-9a-f]{64}$'
     OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
  END IF;

  SELECT * INTO provision FROM public.connect_account_provisions WHERE user_id = p_user_id FOR UPDATE;
  SELECT stripe_account_id INTO existing_account FROM public.connect_accounts WHERE user_id = p_user_id;
  IF provision.user_id IS NULL THEN
    -- A user/account pair alone does not attest how a historical link arose.
    -- A closed policy must not freeze an unqualified payload in a new intent.
    IF existing_account IS NOT NULL OR p_parameters IS NULL THEN
      RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
    END IF;
    operation := gen_random_uuid();
    observed_now := clock_timestamp();
    INSERT INTO public.connect_account_provisions
      (user_id, operation_id, parameters, api_version, provider_context, created_at, retry_until)
    VALUES (p_user_id, operation,
      p_parameters || jsonb_build_object('metadata', jsonb_build_object('purama_connect_operation', operation::text)),
      p_api_version, p_provider_context, observed_now, observed_now + interval '23 hours')
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  SELECT * INTO STRICT provision FROM public.connect_account_provisions WHERE user_id = p_user_id FOR UPDATE;
  -- Refresh the clock after any wait, including a concurrent first insert.
  observed_now := clock_timestamp();
  IF provision.state = 'reconcile'
     OR provision.provider_context <> p_provider_context OR provision.api_version <> p_api_version THEN
    RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
  END IF;
  SELECT stripe_account_id INTO existing_account FROM public.connect_accounts WHERE user_id = p_user_id;
  IF provision.state = 'bound' OR existing_account IS NOT NULL THEN
    IF provision.state = 'bound' AND existing_account = provision.stripe_account_id THEN
      -- The key fingerprint is conservative: even rotation needs explicit
      -- requalification before opening a session in a different context.
      RETURN jsonb_build_object('decision', 'bound', 'user_id', p_user_id,
        'stripe_account_id', existing_account, 'operation_id', provision.operation_id,
        'api_version', provision.api_version, 'provider_context', provision.provider_context);
    END IF;
    UPDATE public.connect_account_provisions SET state = 'reconcile', reconcile_reason = 'binding_conflict', lease_until = NULL WHERE user_id = p_user_id;
    RETURN jsonb_build_object('decision', 'reconcile', 'user_id', p_user_id);
  END IF;
  IF p_parameters IS NULL THEN
    -- An unresolved old intent stays intact. No lease, key or deadline reset.
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

-- Only the existing SECURITY DEFINER finalizer may insert an identity binding.
-- Old handlers must still be withdrawn before rollout: a denied SQL write
-- cannot undo a provider request they already sent.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.connect_accounts FROM PUBLIC, anon, authenticated, service_role;
DO $$
DECLARE columns text;
BEGIN
  -- Table-level revocation does not remove independently granted column ACLs.
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO columns
    FROM pg_attribute WHERE attrelid = 'public.connect_accounts'::regclass
      AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON public.connect_accounts FROM PUBLIC, anon, authenticated, service_role', columns);
END;
$$;
GRANT SELECT ON public.connect_accounts TO service_role;
GRANT UPDATE (onboarding_completed, payouts_enabled, charges_enabled, kyc_verified_at, requirements, updated_at)
  ON public.connect_accounts TO service_role;
COMMIT;
