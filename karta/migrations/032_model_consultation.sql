-- Explicit extension of CHEF's resource authority. No browser allocation, new
-- balance, price inference, historical backfill, or change to code missions.
BEGIN;

ALTER TABLE purama_ai.chef_missions
  ADD COLUMN kind text NOT NULL DEFAULT 'code' CHECK (kind IN ('code','consultation')),
  ADD COLUMN consultation_expires_at timestamptz,
  ALTER COLUMN repo DROP NOT NULL,
  ALTER COLUMN brief_id DROP NOT NULL,
  ADD CONSTRAINT chef_mission_resource_kind CHECK ((
    (kind = 'code' AND repo IS NOT NULL AND brief_id IS NOT NULL AND consultation_expires_at IS NULL)
    OR (kind = 'consultation' AND repo IS NULL AND brief_id IS NULL AND consultation_expires_at IS NOT NULL AND isfinite(consultation_expires_at)
      AND token_budget IS NOT NULL AND token_budget BETWEEN 0 AND 9007199254740991
      AND cost_budget_micros IS NOT NULL AND cost_budget_micros BETWEEN 0 AND 9007199254740991)
  ) IS TRUE);
CREATE UNIQUE INDEX chef_one_consultation_resource_per_owner
  ON purama_ai.chef_missions(user_id) WHERE kind = 'consultation';

-- A resource grant is reusable, including before its first operation. Preserve
-- the legacy completion checks but never close it as an empty code mission.
CREATE OR REPLACE FUNCTION purama_ai.chef_try_finish_mission(p_mission_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  open_required integer;
  missing integer;
BEGIN
  SELECT count(*) INTO open_required
  FROM purama_ai.chef_tasks
  WHERE mission_id = p_mission_id AND required AND state <> 'verified_done';

  SELECT count(*) INTO missing
  FROM purama_ai.chef_missing_requirements(p_mission_id);

  IF open_required > 0 OR missing > 0 THEN RETURN false; END IF;

  UPDATE purama_ai.chef_missions
  SET state = 'verified_done', finished_at = now(), updated_at = now()
  WHERE id = p_mission_id AND kind = 'code' AND state IN ('active','human_required','external_required');

  RETURN FOUND;
END;
$$;

ALTER TABLE purama_ai.chef_budget_reservations DROP CONSTRAINT chef_budget_reservations_provider_check;
ALTER TABLE purama_ai.chef_budget_reservations ADD CONSTRAINT chef_budget_reservations_provider_check
  CHECK (provider IN ('codex','claude','glm','consultation'));
ALTER TABLE purama_ai.chef_usage_events DROP CONSTRAINT chef_usage_events_provider_check;
ALTER TABLE purama_ai.chef_usage_events ADD CONSTRAINT chef_usage_events_provider_check
  CHECK (provider IS NULL OR provider IN ('codex','claude','glm','consultation'));
ALTER TABLE purama_ai.chef_tasks DROP CONSTRAINT chef_tasks_state_check;
ALTER TABLE purama_ai.chef_tasks ADD CONSTRAINT chef_tasks_state_check CHECK (state IN (
  'pending','ready','claimed','running','verifying','retryable','blocked_human','blocked_external',
  'verified_done','failed','cancelled','consultation_closed'));

-- These are private operations and call evidence, not a second money ledger.
CREATE TABLE purama_ai.model_consultations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 120 AND operation_id ~ '^[A-Za-z0-9]' AND operation_id !~ '[^A-Za-z0-9._:-]'),
  mission_id uuid NOT NULL REFERENCES purama_ai.chef_missions(id) ON DELETE CASCADE,
  task_id uuid NOT NULL UNIQUE REFERENCES purama_ai.chef_tasks(id) ON DELETE CASCADE,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$' AND length(request_hash) = 64),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object' AND pg_column_size(request) <= 131072),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object' AND pg_column_size(plan) <= 16384),
  estimates jsonb NOT NULL CHECK (jsonb_typeof(estimates) = 'object' AND pg_column_size(estimates) <= 32768),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','complete','partial','failed','cancelled','interrupted')),
  resource_state text NOT NULL DEFAULT 'reserved' CHECK (resource_state IN ('reserved','reconciliation_required','reconciled')),
  cancel_requested boolean NOT NULL DEFAULT false,
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND pg_column_size(result) <= 2097152)),
  deadline_at timestamptz NOT NULL,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, operation_id)
);
CREATE TABLE purama_ai.model_consultation_calls (
  operation_pk uuid NOT NULL REFERENCES purama_ai.model_consultations(id) ON DELETE CASCADE,
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 160),
  generation uuid NOT NULL,
  estimate_index integer NOT NULL CHECK (estimate_index > 0),
  call_spec jsonb NOT NULL CHECK (jsonb_typeof(call_spec) = 'object' AND pg_column_size(call_spec) <= 4096),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','completed','uncertain','blocked')),
  receipt jsonb CHECK (receipt IS NULL OR (jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 8192)),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (operation_pk, call_id)
);
-- Cancellation can precede a delayed begin. This contains no fabricated
-- request, result or allocation; both paths serialize on the same identity.
CREATE TABLE purama_ai.model_consultation_cancellations (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 120 AND operation_id ~ '^[A-Za-z0-9]' AND operation_id !~ '[^A-Za-z0-9._:-]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,operation_id)
);
ALTER TABLE purama_ai.model_consultations ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.model_consultation_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.model_consultation_cancellations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.model_consultations, purama_ai.model_consultation_calls, purama_ai.model_consultation_cancellations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON purama_ai.model_consultations, purama_ai.model_consultation_calls TO service_role;
GRANT SELECT, INSERT ON purama_ai.model_consultation_cancellations TO service_role;

CREATE FUNCTION purama_ai.model_consultation_guard_task() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE mission_kind text;
BEGIN
  SELECT kind INTO mission_kind FROM purama_ai.chef_missions WHERE id = NEW.mission_id;
  IF mission_kind = 'consultation' THEN
    IF NEW.state NOT IN ('blocked_external','consultation_closed') OR NEW.access_mode <> 'read'
      OR NEW.worktree IS NOT NULL OR NEW.scope_key IS NOT NULL OR NEW.assigned_provider IS NOT NULL
      OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
      OR NEW.attempt <> 1 OR NEW.fencing_token <> 1 OR NEW.max_attempts <> 1 THEN
      RAISE EXCEPTION 'Consultations never enter a code worker';
    END IF;
  ELSIF NEW.state = 'consultation_closed' THEN RAISE EXCEPTION 'Invalid code task state';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_model_consultation_task BEFORE INSERT OR UPDATE ON purama_ai.chef_tasks
  FOR EACH ROW EXECUTE FUNCTION purama_ai.model_consultation_guard_task();

CREATE FUNCTION purama_ai.model_consultation_guard_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME = 'model_consultation_calls' THEN
    IF ROW(NEW.operation_pk,NEW.call_id,NEW.generation,NEW.estimate_index,NEW.call_spec,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.operation_pk,OLD.call_id,OLD.generation,OLD.estimate_index,OLD.call_spec,OLD.created_at)
      OR (OLD.receipt IS NOT NULL AND ROW(NEW.receipt,NEW.state,NEW.settled_at) IS DISTINCT FROM ROW(OLD.receipt,OLD.state,OLD.settled_at)) THEN
      RAISE EXCEPTION 'Consultation call evidence is immutable';
    END IF;
  ELSE
    IF ROW(NEW.id,NEW.user_id,NEW.operation_id,NEW.mission_id,NEW.task_id,NEW.generation,NEW.request_hash,NEW.request,NEW.plan,NEW.estimates,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.operation_id,OLD.mission_id,OLD.task_id,OLD.generation,OLD.request_hash,OLD.request,OLD.plan,OLD.estimates,OLD.created_at)
      OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
      OR (OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at)
      OR (OLD.cancel_requested AND NOT NEW.cancel_requested) THEN RAISE EXCEPTION 'Consultation identity or result is immutable'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_model_consultation_call_evidence BEFORE UPDATE ON purama_ai.model_consultation_calls
  FOR EACH ROW EXECUTE FUNCTION purama_ai.model_consultation_guard_evidence();
CREATE TRIGGER trg_model_consultation_identity BEFORE UPDATE ON purama_ai.model_consultations
  FOR EACH ROW EXECUTE FUNCTION purama_ai.model_consultation_guard_evidence();

CREATE FUNCTION purama_ai.model_consultation_view(o purama_ai.model_consultations) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('operationId',o.operation_id,
    'state',CASE WHEN o.state IN ('pending','running') AND o.deadline_at <= statement_timestamp() THEN 'interrupted' ELSE o.state END,
    'resourceState',CASE WHEN o.resource_state = 'reserved' AND o.deadline_at <= statement_timestamp() THEN 'reconciliation_required' ELSE o.resource_state END,
    'cancelRequested',o.cancel_requested,'result',o.result,'createdAt',o.created_at,'updatedAt',o.updated_at)
$$;
CREATE FUNCTION purama_ai.model_consultation_cancelled_view(p_user_id uuid,p_operation_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('operationId',c.operation_id,'state','cancelled','resourceState','reconciled',
    'cancelRequested',true,'result',NULL,'createdAt',c.created_at,'updatedAt',c.created_at)
  FROM purama_ai.model_consultation_cancellations c WHERE c.user_id=p_user_id AND c.operation_id=p_operation_id
$$;
CREATE FUNCTION purama_ai.model_consultation_gate() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE allowed boolean;
BEGIN
  IF to_regclass('purama_ai.karta_global_state') IS NULL THEN RETURN true; END IF;
  EXECUTE 'SELECT NOT kill_switch FROM purama_ai.karta_global_state WHERE id = ''global''' INTO allowed;
  RETURN COALESCE(allowed,false);
END; $$;

-- Operator-only provisioning. Repetition confirms the same grant; it never
-- increases/reset budgets or invents a new period after exhaustion/expiration.
CREATE FUNCTION purama_ai.model_consultation_provision(p_user_id uuid, p_token_budget bigint,
  p_cost_budget_micros bigint, p_expires_at timestamptz, p_max_parallel integer DEFAULT 1)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE m purama_ai.chef_missions%ROWTYPE; grant_hash text;
BEGIN
  IF p_user_id IS NULL OR p_token_budget IS NULL OR p_token_budget NOT BETWEEN 1 AND 9007199254740991
    OR p_cost_budget_micros IS NULL OR p_cost_budget_micros NOT BETWEEN 1 AND 9007199254740991
    OR p_expires_at IS NULL OR p_expires_at <= clock_timestamp() OR p_expires_at = 'infinity'
    OR p_max_parallel IS NULL OR p_max_parallel NOT BETWEEN 1 AND 8 THEN RAISE EXCEPTION 'Invalid consultation grant'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('consultation-resource:' || p_user_id::text,0));
  SELECT * INTO m FROM purama_ai.chef_missions WHERE user_id=p_user_id AND kind='consultation' FOR UPDATE;
  IF FOUND THEN
    IF ROW(m.token_budget,m.cost_budget_micros,m.consultation_expires_at,m.max_parallel)
      IS DISTINCT FROM ROW(p_token_budget,p_cost_budget_micros,p_expires_at,p_max_parallel) THEN
      RAISE EXCEPTION USING ERRCODE='PCO01', MESSAGE='Consultation grant already exists; explicit operator reconciliation required';
    END IF;
    RETURN m.id;
  END IF;
  grant_hash := encode(sha256(convert_to(jsonb_build_array(p_user_id,p_token_budget,p_cost_budget_micros,p_expires_at,p_max_parallel)::text,'UTF8')),'hex');
  -- A resource has no code brief; NULL preserves the legacy code uniqueness
  -- constraint without reserving a user-selectable brief identifier.
  INSERT INTO purama_ai.chef_missions(user_id,brief_id,brief_hash,goal,repo,kind,state,max_parallel,token_budget,cost_budget_micros,consultation_expires_at,started_at)
    VALUES(p_user_id,NULL,grant_hash,'Operator-provisioned consultation resources',NULL,'consultation','active',p_max_parallel,p_token_budget,p_cost_budget_micros,p_expires_at,now())
    RETURNING id INTO m.id;
  RETURN m.id;
END; $$;

CREATE FUNCTION purama_ai.model_consultation_availability(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM purama_ai.chef_missions m WHERE m.user_id=p_user_id AND m.kind='consultation'
    AND m.state='active' AND m.consultation_expires_at > statement_timestamp() AND purama_ai.model_consultation_gate()
    AND m.token_budget > m.tokens_used + COALESCE((SELECT sum(r.reserved_tokens) FROM purama_ai.chef_budget_reservations r WHERE r.mission_id=m.id AND r.actual_input_tokens IS NULL),0)
    AND m.cost_budget_micros > m.cost_used_micros + COALESCE((SELECT sum(r.reserved_cost_micros) FROM purama_ai.chef_budget_reservations r WHERE r.mission_id=m.id AND r.actual_cost_micros IS NULL),0))
$$;
CREATE FUNCTION purama_ai.model_consultation_status(p_user_id uuid,p_operation_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT COALESCE((SELECT purama_ai.model_consultation_view(o) FROM purama_ai.model_consultations o WHERE o.user_id=p_user_id AND o.operation_id=p_operation_id),
    purama_ai.model_consultation_cancelled_view(p_user_id,p_operation_id))
$$;
CREATE FUNCTION purama_ai.model_consultation_resume(p_user_id uuid,p_operation_id text,p_request_hash text,p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE o purama_ai.model_consultations%ROWTYPE;
BEGIN
  SELECT * INTO o FROM purama_ai.model_consultations WHERE user_id=p_user_id AND operation_id=p_operation_id;
  IF NOT FOUND THEN RETURN purama_ai.model_consultation_cancelled_view(p_user_id,p_operation_id); END IF;
  IF o.request_hash IS DISTINCT FROM p_request_hash OR o.request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION USING ERRCODE='PCO01',MESSAGE='Consultation request identity conflict'; END IF;
  RETURN purama_ai.model_consultation_view(o);
END; $$;

CREATE FUNCTION purama_ai.model_consultation_create(p_user_id uuid,p_operation_id text,p_request_hash text,
  p_request jsonb,p_plan jsonb,p_estimates jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE o purama_ai.model_consultations%ROWTYPE; m purama_ai.chef_missions%ROWTYPE;
  estimate jsonb; n numeric; token_total numeric:=0; cost_total numeric:=0; call_total integer:=0;
  pending_tokens numeric; pending_cost numeric; task uuid; routes text[]:='{}'; route text; key text;
BEGIN
  IF p_user_id IS NULL OR p_operation_id IS NULL OR length(p_operation_id) NOT BETWEEN 1 AND 120
    OR p_operation_id !~ '^[A-Za-z0-9]' OR p_operation_id ~ '[^A-Za-z0-9._:-]'
    OR p_request_hash IS NULL OR length(p_request_hash)<>64 OR p_request_hash !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' OR p_request->>'userId' IS DISTINCT FROM p_user_id::text
    OR p_request->>'operationId' IS DISTINCT FROM p_operation_id OR pg_column_size(p_request)>131072
    OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object' OR pg_column_size(p_plan)>16384
    OR jsonb_typeof(p_plan->'timeoutMs') IS DISTINCT FROM 'number'
    OR (p_plan->>'timeoutMs')::numeric NOT BETWEEN 1000 AND 120000
    OR trunc((p_plan->>'timeoutMs')::numeric)<>(p_plan->>'timeoutMs')::numeric
    OR jsonb_typeof(p_estimates) IS DISTINCT FROM 'object' OR pg_column_size(p_estimates)>32768
    OR p_estimates - ARRAY['policyVersion','calls'] <> '{}'::jsonb
    OR jsonb_typeof(p_estimates->'policyVersion') IS DISTINCT FROM 'string'
    OR length(p_estimates->>'policyVersion') NOT BETWEEN 1 AND 120
    OR jsonb_typeof(p_estimates->'calls') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_estimates->'calls') NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'Invalid consultation request'; END IF;
  FOR estimate IN SELECT value FROM jsonb_array_elements(p_estimates->'calls') LOOP
    IF jsonb_typeof(estimate) IS DISTINCT FROM 'object'
      OR estimate - ARRAY['kind','provider','model','maxCalls','maxInputTokens','maxOutputTokens','maxCostMicros'] <> '{}'::jsonb
      OR estimate->>'kind' IS NULL OR estimate->>'kind' NOT IN ('search','scrape','proposal','critique','synthesis')
      OR jsonb_typeof(estimate->'provider') IS DISTINCT FROM 'string' OR length(estimate->>'provider') NOT BETWEEN 1 AND 120
      OR (estimate ? 'model' AND (jsonb_typeof(estimate->'model') IS DISTINCT FROM 'string' OR length(estimate->>'model') NOT BETWEEN 1 AND 200))
      OR (estimate->>'kind' IN ('proposal','critique','synthesis') AND NOT estimate ? 'model') THEN RAISE EXCEPTION 'Invalid consultation estimate'; END IF;
    FOREACH key IN ARRAY ARRAY['maxCalls','maxInputTokens','maxOutputTokens','maxCostMicros'] LOOP
      IF jsonb_typeof(estimate->key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid consultation estimate amount'; END IF;
      n := (estimate->>key)::numeric;
      IF n<0 OR n>9007199254740991 OR n<>trunc(n) THEN RAISE EXCEPTION 'Invalid consultation estimate amount'; END IF;
    END LOOP;
    IF (estimate->>'maxCalls')::integer NOT BETWEEN 1 AND 32 OR (estimate->>'maxOutputTokens')::numeric>65536 THEN RAISE EXCEPTION 'Invalid consultation call limit'; END IF;
    route := jsonb_build_array(estimate->>'kind',estimate->>'provider',estimate->>'model')::text;
    IF route=ANY(routes) THEN RAISE EXCEPTION 'Duplicate consultation estimate'; END IF;
    routes:=array_append(routes,route);
    call_total:=call_total+(estimate->>'maxCalls')::integer;
    token_total:=token_total+((estimate->>'maxInputTokens')::numeric+(estimate->>'maxOutputTokens')::numeric)*(estimate->>'maxCalls')::integer;
    cost_total:=cost_total+(estimate->>'maxCostMicros')::numeric*(estimate->>'maxCalls')::integer;
  END LOOP;
  IF call_total>32 OR token_total>9007199254740991 OR cost_total>9007199254740991 THEN RAISE EXCEPTION 'Consultation envelope too large'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('consultation:'||p_user_id::text||':'||p_operation_id,0));
  SELECT * INTO o FROM purama_ai.model_consultations WHERE user_id=p_user_id AND operation_id=p_operation_id FOR UPDATE;
  IF FOUND THEN
    IF o.request_hash<>p_request_hash OR o.request<>p_request THEN RAISE EXCEPTION USING ERRCODE='PCO01',MESSAGE='Consultation request identity conflict'; END IF;
    RETURN jsonb_build_object('created',false,'operation',purama_ai.model_consultation_view(o));
  END IF;
  IF EXISTS(SELECT 1 FROM purama_ai.model_consultation_cancellations WHERE user_id=p_user_id AND operation_id=p_operation_id) THEN
    RETURN jsonb_build_object('created',false,'operation',purama_ai.model_consultation_cancelled_view(p_user_id,p_operation_id)); END IF;
  IF NOT purama_ai.model_consultation_gate() THEN RAISE EXCEPTION USING ERRCODE='PCO02',MESSAGE='Consultation admission stopped'; END IF;
  SELECT * INTO m FROM purama_ai.chef_missions WHERE user_id=p_user_id AND kind='consultation' FOR UPDATE;
  IF NOT FOUND OR m.state<>'active' OR m.consultation_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='PCO02',MESSAGE='Consultation resource grant unavailable'; END IF;
  SELECT COALESCE(sum(reserved_tokens) FILTER(WHERE actual_input_tokens IS NULL),0),COALESCE(sum(reserved_cost_micros) FILTER(WHERE actual_cost_micros IS NULL),0)
    INTO pending_tokens,pending_cost FROM purama_ai.chef_budget_reservations WHERE mission_id=m.id;
  IF m.tokens_used::numeric+pending_tokens+token_total>m.token_budget OR m.cost_used_micros::numeric+pending_cost+cost_total>m.cost_budget_micros
    OR (SELECT count(*) FROM purama_ai.model_consultations WHERE mission_id=m.id AND state IN ('pending','running') AND deadline_at>clock_timestamp())>=m.max_parallel THEN
    RAISE EXCEPTION USING ERRCODE='PCO02',MESSAGE='Consultation resource envelope unavailable'; END IF;
  INSERT INTO purama_ai.chef_tasks(mission_id,task_key,title,instructions,state,access_mode,verification_profiles,brief_hash,attempt,fencing_token,max_attempts,estimated_tokens,estimated_cost_micros)
    VALUES(m.id,'consultation:'||p_operation_id,'Model consultation','Private request retained in model_consultations','blocked_external','read',ARRAY['consultation_receipts'],p_request_hash,1,1,1,token_total::bigint,cost_total::bigint)
    RETURNING id INTO task;
  INSERT INTO purama_ai.model_consultations(user_id,operation_id,mission_id,task_id,request_hash,request,plan,estimates,deadline_at)
    VALUES(p_user_id,p_operation_id,m.id,task,p_request_hash,p_request,p_plan,p_estimates,clock_timestamp()+interval '30 seconds') RETURNING * INTO o;
  INSERT INTO purama_ai.chef_budget_reservations(task_id,attempt,fencing_token,mission_id,worker_id,provider,reserved_tokens,reserved_cost_micros,require_tokens,require_cost)
    VALUES(task,1,1,m.id,'consultation:'||o.id::text,'consultation',token_total::bigint,cost_total::bigint,true,true);
  RETURN jsonb_build_object('created',true,'generation',o.generation,'operation',purama_ai.model_consultation_view(o));
END; $$;

CREATE FUNCTION purama_ai.model_consultation_start(p_user_id uuid,p_operation_id text,p_request_hash text,p_generation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE o purama_ai.model_consultations%ROWTYPE; m purama_ai.chef_missions%ROWTYPE;
BEGIN
  SELECT * INTO o FROM purama_ai.model_consultations WHERE user_id=p_user_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR o.generation IS DISTINCT FROM p_generation OR o.request_hash IS DISTINCT FROM p_request_hash
    OR o.state<>'pending' OR o.cancel_requested OR o.claimed_at IS NOT NULL OR o.deadline_at<=clock_timestamp() THEN RETURN false; END IF;
  SELECT * INTO m FROM purama_ai.chef_missions WHERE id=o.mission_id FOR UPDATE;
  IF m.user_id<>p_user_id OR m.kind<>'consultation' OR m.state<>'active' OR m.consultation_expires_at<=clock_timestamp() OR NOT purama_ai.model_consultation_gate() THEN RETURN false; END IF;
  UPDATE purama_ai.model_consultations SET state='running',claimed_at=clock_timestamp(),
    deadline_at=clock_timestamp()+make_interval(secs=>(o.plan->>'timeoutMs')::double precision/1000),updated_at=now() WHERE id=o.id;
  RETURN true;
END; $$;

CREATE FUNCTION purama_ai.model_consultation_reserve(p_user_id uuid,p_operation_id text,p_generation uuid,p_call jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE o purama_ai.model_consultations%ROWTYPE; m purama_ai.chef_missions%ROWTYPE; estimate jsonb; ordinal integer; prior integer;
BEGIN
  SELECT * INTO o FROM purama_ai.model_consultations WHERE user_id=p_user_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR o.generation IS DISTINCT FROM p_generation OR o.state<>'running' OR o.cancel_requested OR o.deadline_at<=clock_timestamp() THEN RETURN false; END IF;
  SELECT * INTO m FROM purama_ai.chef_missions WHERE id=o.mission_id FOR UPDATE;
  IF m.user_id<>p_user_id OR m.kind<>'consultation' OR m.state<>'active' OR m.consultation_expires_at<=clock_timestamp() OR NOT purama_ai.model_consultation_gate() THEN RETURN false; END IF;
  IF jsonb_typeof(p_call) IS DISTINCT FROM 'object' OR pg_column_size(p_call)>4096
    OR p_call - ARRAY['userId','operationId','callId','kind','provider','model','inputHash','maxOutputTokens']<>'{}'::jsonb
    OR p_call->>'userId' IS DISTINCT FROM p_user_id::text OR p_call->>'operationId' IS DISTINCT FROM p_operation_id
    OR jsonb_typeof(p_call->'callId') IS DISTINCT FROM 'string' OR length(p_call->>'callId') NOT BETWEEN 1 AND 160
    OR p_call->>'inputHash' IS NULL OR length(p_call->>'inputHash')<>64 OR p_call->>'inputHash' !~ '^[0-9a-f]{64}$'
    OR (p_call ? 'maxOutputTokens' AND (jsonb_typeof(p_call->'maxOutputTokens') IS DISTINCT FROM 'number'
      OR (p_call->>'maxOutputTokens')::numeric<0 OR (p_call->>'maxOutputTokens')::numeric<>trunc((p_call->>'maxOutputTokens')::numeric))) THEN RAISE EXCEPTION 'Invalid consultation call'; END IF;
  SELECT value, ord::integer INTO estimate,ordinal FROM jsonb_array_elements(o.estimates->'calls') WITH ORDINALITY e(value,ord)
    WHERE value->>'kind'=p_call->>'kind' AND value->>'provider'=p_call->>'provider' AND value->>'model' IS NOT DISTINCT FROM p_call->>'model';
  IF NOT FOUND OR COALESCE((p_call->>'maxOutputTokens')::numeric,0)>(estimate->>'maxOutputTokens')::numeric THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM purama_ai.model_consultation_calls WHERE operation_pk=o.id AND call_id=p_call->>'callId') THEN RETURN false; END IF;
  SELECT count(*) INTO prior FROM purama_ai.model_consultation_calls WHERE operation_pk=o.id AND estimate_index=ordinal;
  IF prior >= (estimate->>'maxCalls')::integer THEN RETURN false; END IF;
  PERFORM 1 FROM purama_ai.chef_budget_reservations WHERE task_id=o.task_id AND attempt=1 AND fencing_token=1
    AND mission_id=m.id AND provider='consultation' AND actual_input_tokens IS NULL AND actual_cost_micros IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO purama_ai.model_consultation_calls(operation_pk,call_id,generation,estimate_index,call_spec)
    VALUES(o.id,p_call->>'callId',p_generation,ordinal,p_call);
  RETURN true;
END; $$;

CREATE FUNCTION purama_ai.model_consultation_valid_usage(u jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE key text; v jsonb;
BEGIN
  IF jsonb_typeof(u) IS DISTINCT FROM 'object' OR NOT u ?& ARRAY['version','apiFormat','routeKind','requestedModel','responseModel','responseId','inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','cacheCreation5mInputTokens','cacheCreation1hInputTokens']
    OR u - ARRAY['version','apiFormat','routeKind','requestedModel','responseModel','responseId','inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','cacheCreation5mInputTokens','cacheCreation1hInputTokens']<>'{}'::jsonb
    OR u->'version' IS DISTINCT FROM '1'::jsonb OR u->>'apiFormat' IS DISTINCT FROM 'anthropic_messages'
    OR u->>'routeKind' IS NULL OR u->>'routeKind' NOT IN ('anthropic','compatible') THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['requestedModel','responseModel','responseId'] LOOP
    v:=u->key;
    IF v<>'null'::jsonb AND (jsonb_typeof(v)<>'string' OR length(u->>key) NOT BETWEEN 1 AND 200 OR u->>key !~ '^[A-Za-z0-9]' OR u->>key ~ '[^A-Za-z0-9_.:/-]') THEN RETURN false; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','cacheCreation5mInputTokens','cacheCreation1hInputTokens'] LOOP
    v:=u->key;
    IF v<>'null'::jsonb THEN
      IF jsonb_typeof(v)<>'number' THEN RETURN false; END IF;
      IF (u->>key)::numeric NOT BETWEEN 0 AND 9007199254740991 OR (u->>key)::numeric<>trunc((u->>key)::numeric) THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END; $$;

CREATE FUNCTION purama_ai.model_consultation_settle(p_user_id uuid,p_operation_id text,p_generation uuid,p_receipt jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE o purama_ai.model_consultations%ROWTYPE; c purama_ai.model_consultation_calls%ROWTYPE; u jsonb;
BEGIN
  SELECT * INTO o FROM purama_ai.model_consultations WHERE user_id=p_user_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR o.generation IS DISTINCT FROM p_generation THEN RETURN false; END IF;
  IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR pg_column_size(p_receipt)>8192
    OR NOT p_receipt ?& ARRAY['call','status','usage'] OR p_receipt - ARRAY['call','status','usage']<>'{}'::jsonb
    OR p_receipt->>'status' IS NULL OR p_receipt->>'status' NOT IN ('completed','uncertain','blocked')
    OR jsonb_typeof(p_receipt->'usage') IS DISTINCT FROM 'array' OR jsonb_array_length(p_receipt->'usage')>1 THEN RAISE EXCEPTION 'Invalid consultation receipt'; END IF;
  SELECT * INTO c FROM purama_ai.model_consultation_calls WHERE operation_pk=o.id AND call_id=p_receipt->'call'->>'callId' FOR UPDATE;
  IF NOT FOUND THEN
    -- A denied reserve generated no dispatch. It must never manufacture usage.
    IF p_receipt->>'status'='blocked' AND p_receipt->'usage'='[]'::jsonb THEN RETURN true; END IF;
    RAISE EXCEPTION 'Consultation receipt has no reservation';
  END IF;
  IF c.generation<>p_generation OR c.call_spec IS DISTINCT FROM p_receipt->'call' THEN RAISE EXCEPTION USING ERRCODE='PCO01',MESSAGE='Consultation receipt identity conflict'; END IF;
  IF c.receipt IS NOT NULL THEN
    IF c.receipt<>p_receipt THEN RAISE EXCEPTION USING ERRCODE='PCO01',MESSAGE='Consultation receipt conflict'; END IF;
    RETURN true;
  END IF;
  IF p_receipt->>'status'='blocked' AND p_receipt->'usage'<>'[]'::jsonb THEN RAISE EXCEPTION 'Blocked call cannot report usage'; END IF;
  FOR u IN SELECT value FROM jsonb_array_elements(p_receipt->'usage') LOOP
    IF NOT purama_ai.model_consultation_valid_usage(u) OR u->>'requestedModel' IS DISTINCT FROM c.call_spec->>'model' THEN RAISE EXCEPTION 'Invalid provider usage receipt'; END IF;
  END LOOP;
  UPDATE purama_ai.model_consultation_calls SET state=p_receipt->>'status',receipt=p_receipt,settled_at=now() WHERE operation_pk=o.id AND call_id=c.call_id;
  RETURN true;
END; $$;

-- Final observed totals fill unknown dimensions of the EXISTING CHEF ledger.
-- This service-only RPC also supports later operator/provider reconciliation.
CREATE FUNCTION purama_ai.model_consultation_reconcile(p_user_id uuid,p_operation_id text,p_receipt_key text,
  p_input_tokens bigint,p_output_tokens bigint,p_cached_input_tokens bigint,p_cost_micros bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE o purama_ai.model_consultations%ROWTYPE; r purama_ai.chef_budget_reservations%ROWTYPE;
  m purama_ai.chef_missions%ROWTYPE; previous purama_ai.chef_usage_events%ROWTYPE; event_key_value text;
  delta_tokens bigint:=0; delta_cost bigint:=0; done boolean; pending_tokens numeric; pending_cost numeric;
BEGIN
  IF p_receipt_key IS NULL OR length(p_receipt_key) NOT BETWEEN 1 AND 160
    OR (p_input_tokens IS NULL)<>(p_output_tokens IS NULL)
    OR p_input_tokens<0 OR p_output_tokens<0 OR p_cached_input_tokens<0 OR p_cost_micros<0
    OR p_input_tokens::numeric+p_output_tokens>9007199254740991 OR p_cached_input_tokens>9007199254740991 OR p_cost_micros>9007199254740991 THEN RAISE EXCEPTION 'Invalid final consultation usage'; END IF;
  SELECT * INTO o FROM purama_ai.model_consultations WHERE user_id=p_user_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF o.state IN ('pending','running') AND NOT o.cancel_requested THEN
    IF o.deadline_at>clock_timestamp() THEN RAISE EXCEPTION 'Consultation still active'; END IF;
    UPDATE purama_ai.model_consultations SET state='interrupted',finished_at=now(),updated_at=now() WHERE id=o.id;
  END IF;
  -- Matches CHEF's task -> mission -> reservation settlement order.
  PERFORM 1 FROM purama_ai.chef_tasks WHERE id=o.task_id FOR UPDATE;
  SELECT * INTO m FROM purama_ai.chef_missions WHERE id=o.mission_id FOR UPDATE;
  SELECT * INTO r FROM purama_ai.chef_budget_reservations WHERE task_id=o.task_id AND attempt=1 AND fencing_token=1 FOR UPDATE;
  IF NOT FOUND OR r.provider<>'consultation' OR r.mission_id<>m.id OR m.user_id<>p_user_id OR m.kind<>'consultation' THEN RAISE EXCEPTION 'Consultation financial identity unavailable'; END IF;
  IF (r.actual_input_tokens IS NOT NULL AND p_input_tokens IS NOT NULL AND ROW(r.actual_input_tokens,r.actual_output_tokens) IS DISTINCT FROM ROW(p_input_tokens,p_output_tokens))
    OR (r.actual_cached_input_tokens IS NOT NULL AND p_cached_input_tokens IS NOT NULL AND r.actual_cached_input_tokens<>p_cached_input_tokens)
    OR (r.actual_cost_micros IS NOT NULL AND p_cost_micros IS NOT NULL AND r.actual_cost_micros<>p_cost_micros) THEN RAISE EXCEPTION USING ERRCODE='PCO01',MESSAGE='Conflicting final consultation usage'; END IF;
  event_key_value:='consultation|'||o.id::text||'|'||p_receipt_key;
  SELECT * INTO previous FROM purama_ai.chef_usage_events WHERE event_key=event_key_value;
  IF FOUND THEN
    IF ROW(previous.task_id,previous.mission_id,previous.input_tokens,previous.output_tokens,previous.cached_input_tokens,previous.cost_micros)
      IS DISTINCT FROM ROW(o.task_id,o.mission_id,p_input_tokens,p_output_tokens,p_cached_input_tokens,p_cost_micros) THEN RAISE EXCEPTION USING ERRCODE='PCO01',MESSAGE='Consultation usage event conflict'; END IF;
  ELSE
    INSERT INTO purama_ai.chef_usage_events(event_key,mission_id,task_id,worker_id,provider,input_tokens,output_tokens,cached_input_tokens,cost_micros,attempt,fencing_token)
      VALUES(event_key_value,o.mission_id,o.task_id,r.worker_id,'consultation',p_input_tokens,p_output_tokens,p_cached_input_tokens,p_cost_micros,1,1);
  END IF;
  IF r.actual_input_tokens IS NULL AND p_input_tokens IS NOT NULL THEN delta_tokens:=p_input_tokens+p_output_tokens; END IF;
  IF r.actual_cost_micros IS NULL AND p_cost_micros IS NOT NULL THEN delta_cost:=p_cost_micros; END IF;
  UPDATE purama_ai.chef_budget_reservations SET actual_input_tokens=COALESCE(actual_input_tokens,p_input_tokens),actual_output_tokens=COALESCE(actual_output_tokens,p_output_tokens),
    actual_cached_input_tokens=COALESCE(actual_cached_input_tokens,p_cached_input_tokens),actual_cost_micros=COALESCE(actual_cost_micros,p_cost_micros),updated_at=now()
    WHERE task_id=o.task_id AND attempt=1 AND fencing_token=1 RETURNING * INTO r;
  UPDATE purama_ai.chef_tasks SET tokens_used=tokens_used+delta_tokens,cost_used_micros=cost_used_micros+delta_cost,updated_at=now() WHERE id=o.task_id;
  UPDATE purama_ai.chef_missions SET tokens_used=tokens_used+delta_tokens,cost_used_micros=cost_used_micros+delta_cost,updated_at=now() WHERE id=o.mission_id RETURNING * INTO m;
  SELECT COALESCE(sum(reserved_tokens) FILTER(WHERE actual_input_tokens IS NULL),0),COALESCE(sum(reserved_cost_micros) FILTER(WHERE actual_cost_micros IS NULL),0)
    INTO pending_tokens,pending_cost FROM purama_ai.chef_budget_reservations WHERE mission_id=o.mission_id;
  IF m.tokens_used::numeric+pending_tokens>m.token_budget OR m.cost_used_micros::numeric+pending_cost>m.cost_budget_micros THEN
    UPDATE purama_ai.chef_missions SET state='paused' WHERE id=o.mission_id AND state='active';
  END IF;
  done:=r.actual_input_tokens IS NOT NULL AND r.actual_cost_micros IS NOT NULL;
  UPDATE purama_ai.model_consultations SET resource_state=CASE WHEN done THEN 'reconciled' ELSE 'reconciliation_required' END,updated_at=now() WHERE id=o.id RETURNING * INTO o;
  IF done THEN UPDATE purama_ai.chef_tasks SET state='consultation_closed',finished_at=now() WHERE id=o.task_id; END IF;
  RETURN purama_ai.model_consultation_view(o);
END; $$;

CREATE FUNCTION purama_ai.model_consultation_observe(p_user_id uuid,p_operation_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE o purama_ai.model_consultations%ROWTYPE; c purama_ai.model_consultation_calls%ROWTYPE; u jsonb;
  input_total numeric:=0; output_total numeric:=0; cached_total numeric:=0; tokens_known boolean:=true; any_dispatch boolean:=false; key text;
BEGIN
  SELECT * INTO o FROM purama_ai.model_consultations WHERE user_id=p_user_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  FOR c IN SELECT * FROM purama_ai.model_consultation_calls WHERE operation_pk=o.id LOOP
    IF c.state='blocked' THEN CONTINUE; END IF;
    any_dispatch:=true;
    IF c.call_spec->>'kind' IN ('search','scrape') THEN CONTINUE; END IF;
    u:=c.receipt->'usage'->0;
    IF u IS NULL OR u->>'inputTokens' IS NULL OR u->>'outputTokens' IS NULL OR u->>'cacheReadInputTokens' IS NULL OR u->>'cacheCreationInputTokens' IS NULL THEN
      tokens_known:=false;
    ELSE
      -- Cache creation TTL buckets are subsets, never added again.
      input_total:=input_total+(u->>'inputTokens')::numeric+(u->>'cacheReadInputTokens')::numeric+(u->>'cacheCreationInputTokens')::numeric;
      output_total:=output_total+(u->>'outputTokens')::numeric;
      cached_total:=cached_total+(u->>'cacheReadInputTokens')::numeric;
    END IF;
  END LOOP;
  IF input_total+output_total>9007199254740991 OR cached_total>9007199254740991 THEN RAISE EXCEPTION 'Consultation totals exceed safe range'; END IF;
  key:='observed:'||encode(sha256(convert_to(jsonb_build_array(CASE WHEN tokens_known THEN input_total ELSE NULL END,CASE WHEN tokens_known THEN output_total ELSE NULL END,CASE WHEN tokens_known THEN cached_total ELSE NULL END,CASE WHEN any_dispatch THEN NULL ELSE 0 END)::text,'UTF8')),'hex');
  RETURN purama_ai.model_consultation_reconcile(p_user_id,p_operation_id,key,
    CASE WHEN tokens_known THEN input_total::bigint ELSE NULL END,CASE WHEN tokens_known THEN output_total::bigint ELSE NULL END,
    CASE WHEN tokens_known THEN cached_total::bigint ELSE NULL END,CASE WHEN any_dispatch THEN NULL ELSE 0 END);
END; $$;

CREATE FUNCTION purama_ai.model_consultation_finalize(p_user_id uuid,p_operation_id text,p_generation uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE o purama_ai.model_consultations%ROWTYPE; final_state text;
BEGIN
  SELECT * INTO o FROM purama_ai.model_consultations WHERE user_id=p_user_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR o.generation IS DISTINCT FROM p_generation THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR pg_column_size(p_result)>2097152 OR p_result->'plan' IS DISTINCT FROM o.plan
    OR p_result->>'status' IS NULL OR p_result->>'status' NOT IN ('complete','partial','failed','blocked') THEN RAISE EXCEPTION 'Invalid consultation result'; END IF;
  IF o.result IS NOT NULL THEN
    IF o.result<>p_result THEN RAISE EXCEPTION USING ERRCODE='PCO01',MESSAGE='Consultation result conflict'; END IF;
    RETURN purama_ai.model_consultation_view(o);
  END IF;
  final_state:=CASE WHEN o.cancel_requested THEN 'cancelled' WHEN p_result->>'status'='blocked' THEN 'failed' ELSE p_result->>'status' END;
  UPDATE purama_ai.model_consultations SET result=p_result,state=final_state,finished_at=now(),updated_at=now() WHERE id=o.id;
  RETURN purama_ai.model_consultation_observe(p_user_id,p_operation_id);
END; $$;

CREATE FUNCTION purama_ai.model_consultation_cancel(p_user_id uuid,p_operation_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE o purama_ai.model_consultations%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_operation_id IS NULL OR length(p_operation_id) NOT BETWEEN 1 AND 120
    OR p_operation_id !~ '^[A-Za-z0-9]' OR p_operation_id ~ '[^A-Za-z0-9._:-]' THEN RAISE EXCEPTION 'Invalid consultation cancellation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('consultation:'||p_user_id::text||':'||p_operation_id,0));
  SELECT * INTO o FROM purama_ai.model_consultations WHERE user_id=p_user_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO purama_ai.model_consultation_cancellations(user_id,operation_id) VALUES(p_user_id,p_operation_id) ON CONFLICT DO NOTHING;
    RETURN purama_ai.model_consultation_cancelled_view(p_user_id,p_operation_id);
  END IF;
  IF o.state NOT IN ('pending','running','interrupted') THEN RETURN purama_ai.model_consultation_view(o); END IF;
  UPDATE purama_ai.model_consultations SET cancel_requested=true,state='cancelled',finished_at=now(),updated_at=now() WHERE id=o.id;
  RETURN purama_ai.model_consultation_observe(p_user_id,p_operation_id);
END; $$;

-- No authenticated/browser entry point may allocate, reserve, settle or read.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='purama_ai' AND p.proname LIKE 'model_consultation_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
END; $$;
COMMIT;
