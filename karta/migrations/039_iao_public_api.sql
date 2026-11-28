-- Developer credentials and project operation bindings. CHEF remains the only
-- resource authority; these tables contain neither balances nor provider keys.
BEGIN;

CREATE FUNCTION purama_ai.iao_api_valid_models(p_models text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT COALESCE(array_ndims(p_models)=1 AND array_lower(p_models,1)=1
    AND cardinality(p_models) BETWEEN 1 AND 32
    AND (SELECT count(*)=count(DISTINCT model) AND bool_and(model IS NOT NULL
      AND length(model) BETWEEN 1 AND 200 AND model ~ '^[A-Za-z0-9]'
      AND model !~ '[^A-Za-z0-9._:/-]') FROM unnest(p_models) model),false)
$$;

CREATE TABLE purama_ai.iao_api_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  allowed_models text[] NOT NULL CHECK (purama_ai.iao_api_valid_models(allowed_models)),
  max_operation_cost_micros bigint NOT NULL CHECK (max_operation_cost_micros BETWEEN 1 AND 9007199254740991),
  requests_per_minute integer NOT NULL CHECK (requests_per_minute BETWEEN 1 AND 600),
  rate_window timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(rate_window)),
  rate_count integer NOT NULL DEFAULT 0 CHECK (rate_count BETWEEN 0 AND 600),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX iao_api_projects_owner ON purama_ai.iao_api_projects(user_id);
CREATE TABLE purama_ai.iao_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES purama_ai.iao_api_projects(id) ON DELETE CASCADE,
  key_hash text NOT NULL UNIQUE CHECK (length(key_hash)=64 AND key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (array_ndims(scopes)=1 AND array_lower(scopes,1)=1
    AND cardinality(scopes) BETWEEN 1 AND 4 AND array_position(scopes,NULL) IS NULL
    AND scopes <@ ARRAY['catalog','read','create','cancel']::text[]),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  revoked_at timestamptz CHECK (revoked_at IS NULL OR isfinite(revoked_at)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX iao_api_keys_project ON purama_ai.iao_api_keys(project_id);
CREATE TABLE purama_ai.iao_api_operations (
  project_id uuid NOT NULL REFERENCES purama_ai.iao_api_projects(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  internal_operation_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,operation_id)
);
ALTER TABLE purama_ai.iao_api_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.iao_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.iao_api_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.iao_api_projects,purama_ai.iao_api_keys,purama_ai.iao_api_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON purama_ai.iao_api_projects,purama_ai.iao_api_keys TO service_role;
-- UPDATE privilege permits a row lock; the trigger below rejects any changed
-- binding, including from the trusted provisioning role.
GRANT SELECT,INSERT,UPDATE ON purama_ai.iao_api_operations TO service_role;

CREATE FUNCTION purama_ai.iao_api_guard_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='iao_api_projects' THEN
    IF ROW(NEW.id,NEW.user_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='API project identity is immutable';
    END IF;
  ELSIF TG_TABLE_NAME='iao_api_keys' THEN
    IF ROW(NEW.id,NEW.project_id,NEW.key_hash,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.key_hash,OLD.created_at)
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
      RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='API key identity and revocation are immutable';
    END IF;
  ELSE
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='API operation binding is immutable';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_iao_api_project_identity BEFORE UPDATE ON purama_ai.iao_api_projects
  FOR EACH ROW EXECUTE FUNCTION purama_ai.iao_api_guard_identity();
CREATE TRIGGER trg_iao_api_key_identity BEFORE UPDATE ON purama_ai.iao_api_keys
  FOR EACH ROW EXECUTE FUNCTION purama_ai.iao_api_guard_identity();
CREATE TRIGGER trg_iao_api_operation_identity BEFORE UPDATE ON purama_ai.iao_api_operations
  FOR EACH ROW EXECUTE FUNCTION purama_ai.iao_api_guard_identity();

-- The preliminary lookup conveys no authority. Lock order is always project,
-- key, binding, then the existing consultation/CHEF locks. The key row lock
-- serializes this admission with a concurrent revocation or scope change.
CREATE FUNCTION purama_ai.iao_api_authorize(p_key_hash text,p_scope text,p_consume_rate boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE project_id_value uuid; p purama_ai.iao_api_projects%ROWTYPE; k purama_ai.iao_api_keys%ROWTYPE;
  current_time_value timestamptz;
BEGIN
  IF p_key_hash IS NULL OR length(p_key_hash)<>64 OR p_key_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='PIA01',MESSAGE='API authentication required';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('catalog','read','create','cancel') OR p_consume_rate IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API authorization request';
  END IF;
  SELECT project_id INTO project_id_value FROM purama_ai.iao_api_keys WHERE key_hash=p_key_hash;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PIA01',MESSAGE='API authentication required'; END IF;
  SELECT * INTO p FROM purama_ai.iao_api_projects WHERE id=project_id_value FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PIA01',MESSAGE='API authentication required'; END IF;
  SELECT * INTO k FROM purama_ai.iao_api_keys WHERE key_hash=p_key_hash AND project_id=p.id FOR UPDATE;
  current_time_value:=clock_timestamp();
  IF NOT FOUND OR k.revoked_at IS NOT NULL OR k.expires_at<=current_time_value
    OR NOT p.active OR p.expires_at<=current_time_value THEN
    RAISE EXCEPTION USING ERRCODE='PIA01',MESSAGE='API authentication required';
  END IF;
  IF NOT p_scope=ANY(k.scopes) THEN RAISE EXCEPTION USING ERRCODE='PIA02',MESSAGE='API scope unavailable'; END IF;
  IF p_consume_rate THEN
    IF p.rate_window<=current_time_value-interval '1 minute' THEN
      UPDATE purama_ai.iao_api_projects SET rate_window=current_time_value,rate_count=1 WHERE id=p.id;
    ELSE
      IF p.rate_count>=p.requests_per_minute THEN RAISE EXCEPTION USING ERRCODE='PIA03',MESSAGE='API rate limit reached'; END IF;
      UPDATE purama_ai.iao_api_projects SET rate_count=rate_count+1 WHERE id=p.id;
    END IF;
  END IF;
  RETURN jsonb_build_object('keyId',k.id,'projectId',p.id,'userId',p.user_id,
    'allowedModels',p.allowed_models,'maxOperationCostMicros',p.max_operation_cost_micros);
END; $$;

-- A cancellation may bind an unseen external ID, so that a delayed creation
-- observes the durable cancellation tombstone. Binding allocates no resources.
CREATE FUNCTION purama_ai.iao_api_bind_operation(p_key_hash text,p_operation_id uuid,p_create boolean,p_scope text DEFAULT 'read')
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE grant_value jsonb; project_id_value uuid; internal_id uuid;
BEGIN
  IF p_operation_id IS NULL OR p_create IS NULL OR p_scope IS NULL
    OR p_scope NOT IN ('read','create','cancel') OR (p_create AND p_scope='read') THEN
    RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API operation binding';
  END IF;
  grant_value:=purama_ai.iao_api_authorize(p_key_hash,p_scope,false);
  project_id_value:=(grant_value->>'projectId')::uuid;
  -- The project lock already serializes concurrent binds, including keys that
  -- belong to the same project. The unique constraint is the durable invariant.
  SELECT internal_operation_id INTO internal_id FROM purama_ai.iao_api_operations
    WHERE project_id=project_id_value AND operation_id=p_operation_id FOR KEY SHARE;
  IF FOUND OR NOT p_create THEN RETURN internal_id; END IF;
  INSERT INTO purama_ai.iao_api_operations(project_id,operation_id)
    VALUES(project_id_value,p_operation_id) RETURNING internal_operation_id INTO internal_id;
  RETURN internal_id;
END; $$;

-- Reuse the host's conservative envelope; this is a ceiling, not a price or an
-- invoice. Numeric arithmetic avoids bigint overflow on hostile JSON amounts.
CREATE FUNCTION purama_ai.iao_api_check_envelope(p_models text[],p_limit bigint,p_request jsonb,p_plan jsonb,p_estimates jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE estimate jsonb; reviewer jsonb; total_cost numeric:=0; max_calls numeric; max_cost numeric;
BEGIN
  IF jsonb_typeof(p_request) IS DISTINCT FROM 'object' OR jsonb_typeof(p_request#>'{preferences,model}') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object' OR jsonb_typeof(p_plan->'model') IS DISTINCT FROM 'string'
    OR p_plan->>'model' IS DISTINCT FROM p_request#>>'{preferences,model}'
    OR jsonb_typeof(p_estimates) IS DISTINCT FROM 'object' OR jsonb_typeof(p_estimates->'calls') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation envelope';
  END IF;
  IF NOT (p_request#>>'{preferences,model}')=ANY(p_models) THEN
    RAISE EXCEPTION USING ERRCODE='PIA02',MESSAGE='API model unavailable';
  END IF;
  IF p_request ? 'reviewerModels' THEN
    IF jsonb_typeof(p_request->'reviewerModels') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation models';
    END IF;
    FOR reviewer IN SELECT value FROM jsonb_array_elements(p_request->'reviewerModels') LOOP
      IF jsonb_typeof(reviewer) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation models';
      END IF;
      IF NOT (reviewer#>>'{}')=ANY(p_models) THEN RAISE EXCEPTION USING ERRCODE='PIA02',MESSAGE='API model unavailable'; END IF;
    END LOOP;
  END IF;
  IF jsonb_array_length(p_estimates->'calls') NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation envelope';
  END IF;
  FOR estimate IN SELECT value FROM jsonb_array_elements(p_estimates->'calls') LOOP
    IF jsonb_typeof(estimate) IS DISTINCT FROM 'object'
      OR jsonb_typeof(estimate->'maxCalls') IS DISTINCT FROM 'number'
      OR jsonb_typeof(estimate->'maxCostMicros') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Unknown API consultation cost';
    END IF;
    max_calls:=(estimate->>'maxCalls')::numeric; max_cost:=(estimate->>'maxCostMicros')::numeric;
    IF max_calls<>trunc(max_calls) OR max_calls NOT BETWEEN 1 AND 32
      OR max_cost<>trunc(max_cost) OR max_cost NOT BETWEEN 0 AND 9007199254740991 THEN
      RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation cost';
    END IF;
    IF estimate ? 'model' THEN
      IF jsonb_typeof(estimate->'model') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation model';
      END IF;
      IF NOT (estimate->>'model')=ANY(p_models) THEN RAISE EXCEPTION USING ERRCODE='PIA02',MESSAGE='API model unavailable'; END IF;
    ELSIF estimate->>'kind' IN ('proposal','critique','synthesis') THEN
      RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Missing API consultation model';
    END IF;
    total_cost:=total_cost+max_calls*max_cost;
  END LOOP;
  IF p_limit IS NULL OR p_limit<1 OR total_cost>p_limit THEN
    RAISE EXCEPTION USING ERRCODE='PIA04',MESSAGE='API operation ceiling exceeded';
  END IF;
END; $$;

-- The public adapter calls only this allowlisted gate for reads and admission.
-- Settlement/finalization deliberately remain trusted private RPCs: revoking a
-- key must stop new paid work without discarding evidence of an earlier call.
CREATE FUNCTION purama_ai.iao_api_consultation_call(p_key_hash text,p_operation_id uuid,p_method text,p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE grant_value jsonb; scope_value text; expected text[]; owner_id uuid; internal_id uuid;
  models text[]; ceiling bigint; stored purama_ai.model_consultations%ROWTYPE;
BEGIN
  IF p_method IS NULL OR p_method NOT IN ('availability','status','resume','cancel','create','start','reserve')
    OR jsonb_typeof(p_args) IS DISTINCT FROM 'object' OR pg_column_size(p_args)>262144 THEN
    RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation method';
  END IF;
  scope_value:=CASE p_method WHEN 'availability' THEN 'catalog' WHEN 'status' THEN 'read' WHEN 'cancel' THEN 'cancel' ELSE 'create' END;
  grant_value:=purama_ai.iao_api_authorize(p_key_hash,scope_value,false);
  owner_id:=(grant_value->>'userId')::uuid;
  IF p_args->>'p_user_id' IS DISTINCT FROM owner_id::text THEN
    RAISE EXCEPTION USING ERRCODE='PIA02',MESSAGE='API consultation identity mismatch';
  END IF;
  expected:=CASE p_method
    WHEN 'availability' THEN ARRAY['p_user_id']
    WHEN 'status' THEN ARRAY['p_user_id','p_operation_id']
    WHEN 'cancel' THEN ARRAY['p_user_id','p_operation_id']
    WHEN 'resume' THEN ARRAY['p_user_id','p_operation_id','p_request_hash','p_request']
    WHEN 'create' THEN ARRAY['p_user_id','p_operation_id','p_request_hash','p_request','p_plan','p_estimates']
    WHEN 'start' THEN ARRAY['p_user_id','p_operation_id','p_request_hash','p_generation']
    ELSE ARRAY['p_user_id','p_operation_id','p_generation','p_call'] END;
  IF p_args-expected<>'{}'::jsonb OR NOT p_args ?& expected THEN
    RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation arguments';
  END IF;
  IF p_method='availability' THEN
    IF p_operation_id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API catalogue operation'; END IF;
    RETURN to_jsonb(purama_ai.model_consultation_availability(owner_id));
  END IF;
  IF p_operation_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Missing API operation'; END IF;
  SELECT internal_operation_id INTO internal_id FROM purama_ai.iao_api_operations
    WHERE project_id=(grant_value->>'projectId')::uuid AND operation_id=p_operation_id FOR KEY SHARE;
  IF NOT FOUND OR p_args->>'p_operation_id' IS DISTINCT FROM internal_id::text THEN
    RAISE EXCEPTION USING ERRCODE='PIA02',MESSAGE='API consultation identity mismatch';
  END IF;
  IF p_method IN ('resume','create') THEN
    IF jsonb_typeof(p_args->'p_request') IS DISTINCT FROM 'object'
      OR p_args#>>'{p_request,userId}' IS DISTINCT FROM owner_id::text
      OR p_args#>>'{p_request,operationId}' IS DISTINCT FROM internal_id::text
      OR jsonb_typeof(p_args->'p_request_hash') IS DISTINCT FROM 'string'
      OR length(p_args->>'p_request_hash')<>64 OR p_args->>'p_request_hash' !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation request identity';
    END IF;
  END IF;
  IF p_method IN ('create','start','reserve') THEN
    SELECT array_agg(value) INTO models FROM jsonb_array_elements_text(grant_value->'allowedModels');
    ceiling:=(grant_value->>'maxOperationCostMicros')::bigint;
    IF p_method='create' THEN
      PERFORM purama_ai.iao_api_check_envelope(models,ceiling,p_args->'p_request',p_args->'p_plan',p_args->'p_estimates');
    ELSE
      SELECT * INTO stored FROM purama_ai.model_consultations WHERE user_id=owner_id AND operation_id=internal_id::text FOR UPDATE;
      IF FOUND THEN
        PERFORM purama_ai.iao_api_check_envelope(models,ceiling,stored.request,stored.plan,stored.estimates);
      END IF;
      IF jsonb_typeof(p_args->'p_generation') IS DISTINCT FROM 'string'
        OR p_args->>'p_generation' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        OR length(p_args->>'p_generation')<>36 THEN
        RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation generation';
      END IF;
      IF p_method='start' AND (jsonb_typeof(p_args->'p_request_hash') IS DISTINCT FROM 'string'
        OR length(p_args->>'p_request_hash')<>64 OR p_args->>'p_request_hash' !~ '^[0-9a-f]{64}$') THEN
        RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation request hash';
      END IF;
      IF p_method='reserve' THEN
        IF jsonb_typeof(p_args->'p_call') IS DISTINCT FROM 'object'
          OR p_args#>>'{p_call,userId}' IS DISTINCT FROM owner_id::text
          OR p_args#>>'{p_call,operationId}' IS DISTINCT FROM internal_id::text THEN
          RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation call identity';
        END IF;
        IF p_args->'p_call' ? 'model' AND NOT (p_args#>>'{p_call,model}')=ANY(models) THEN
          RAISE EXCEPTION USING ERRCODE='PIA02',MESSAGE='API model unavailable';
        END IF;
      END IF;
    END IF;
  END IF;
  CASE p_method
    WHEN 'status' THEN RETURN purama_ai.model_consultation_status(owner_id,internal_id::text);
    WHEN 'resume' THEN RETURN purama_ai.model_consultation_resume(owner_id,internal_id::text,p_args->>'p_request_hash',p_args->'p_request');
    WHEN 'cancel' THEN RETURN purama_ai.model_consultation_cancel(owner_id,internal_id::text);
    WHEN 'create' THEN RETURN purama_ai.model_consultation_create(owner_id,internal_id::text,p_args->>'p_request_hash',p_args->'p_request',p_args->'p_plan',p_args->'p_estimates');
    WHEN 'start' THEN RETURN to_jsonb(purama_ai.model_consultation_start(owner_id,internal_id::text,p_args->>'p_request_hash',(p_args->>'p_generation')::uuid));
    WHEN 'reserve' THEN RETURN to_jsonb(purama_ai.model_consultation_reserve(owner_id,internal_id::text,(p_args->>'p_generation')::uuid,p_args->'p_call'));
    ELSE RAISE EXCEPTION USING ERRCODE='PIA05',MESSAGE='Invalid API consultation method';
  END CASE;
END; $$;

-- No API key or browser JWT is a PostgreSQL role. Only the trusted server may
-- call these RPCs after hashing a supplied secret; all other roles fail closed.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='purama_ai' AND p.proname LIKE 'iao_api_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
END; $$;
COMMIT;
