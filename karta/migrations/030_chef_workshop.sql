-- Authenticated workshop admission around the existing CHEF control plane.
-- No client receives direct table/RPC access. Apply after 029.
BEGIN;
CREATE TABLE purama_ai.chef_workshop_runtimes (
  project_id text PRIMARY KEY CHECK (project_id ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  instance_id uuid NOT NULL,
  config_hash text NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  online boolean NOT NULL DEFAULT true,
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE purama_ai.chef_workshop_runs (
  mission_id uuid PRIMARY KEY REFERENCES purama_ai.chef_missions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  cancel_requested_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, request_id)
);
CREATE UNIQUE INDEX chef_workshop_one_open_project
  ON purama_ai.chef_workshop_runs(project_id) WHERE finished_at IS NULL;
CREATE INDEX chef_workshop_user_history ON purama_ai.chef_workshop_runs(user_id, created_at DESC);
ALTER TABLE purama_ai.chef_workshop_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.chef_workshop_runtimes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.chef_workshop_runs, purama_ai.chef_workshop_runtimes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON purama_ai.chef_workshop_runs, purama_ai.chef_workshop_runtimes TO service_role;

CREATE FUNCTION purama_ai.chef_workshop_heartbeat(
  p_project_id text, p_instance_id uuid, p_config_hash text, p_online boolean DEFAULT true
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE changed integer;
BEGIN
  IF p_project_id IS NULL OR p_instance_id IS NULL OR p_config_hash IS NULL OR p_online IS NULL THEN
    RAISE EXCEPTION 'Invalid workshop runtime';
  END IF;
  INSERT INTO purama_ai.chef_workshop_runtimes(project_id, instance_id, config_hash, online)
  VALUES(p_project_id, p_instance_id, p_config_hash, p_online)
  ON CONFLICT(project_id) DO UPDATE SET
    instance_id = EXCLUDED.instance_id, config_hash = EXCLUDED.config_hash,
    online = EXCLUDED.online, heartbeat_at = clock_timestamp()
  WHERE chef_workshop_runtimes.instance_id = p_instance_id
     OR (p_online AND chef_workshop_runtimes.heartbeat_at < clock_timestamp() - interval '60 seconds');
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

-- A lease expiring is not evidence that its process stopped. Every historical
-- generation must have an authenticated worker transition out of active state.
CREATE FUNCTION purama_ai.chef_workshop_processes_stopped(p_mission_id uuid)
RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT NOT EXISTS (SELECT 1 FROM purama_ai.chef_tasks t WHERE t.mission_id = p_mission_id
    AND (t.state IN ('claimed','running','verifying') OR (t.attempt > 0 AND NOT EXISTS (
      SELECT 1 FROM purama_ai.chef_events e WHERE e.task_id=t.id AND e.kind='task_claimed'
        AND e.payload->>'attempt'=t.attempt::text AND e.payload->>'fencing_token'=t.fencing_token::text))))
    AND NOT EXISTS (SELECT 1 FROM purama_ai.chef_process_quarantines WHERE mission_id=p_mission_id)
    AND NOT EXISTS (SELECT 1 FROM purama_ai.chef_events claim
      WHERE claim.mission_id=p_mission_id AND claim.kind='task_claimed' AND NOT EXISTS (
        SELECT 1 FROM purama_ai.chef_events stopped WHERE stopped.task_id=claim.task_id
          AND stopped.worker_id=claim.worker_id AND stopped.kind='task_transition'
          AND stopped.id>claim.id
          AND stopped.payload->>'fencing_token'=claim.payload->>'fencing_token'
          AND stopped.payload->>'to' IN ('retryable','blocked_human','blocked_external','failed','verified_done')));
$$;

CREATE FUNCTION purama_ai.chef_workshop_submit(
  p_user_id uuid, p_project_id text, p_request_id uuid, p_request_hash text,
  p_config_hash text, p_brief jsonb, p_brief_hash text, p_max_parallel integer,
  p_token_budget bigint, p_cost_budget_micros bigint DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE old_run purama_ai.chef_workshop_runs%ROWTYPE; new_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_request_id IS NULL OR p_project_id IS NULL
    OR p_project_id !~ '^[a-z0-9][a-z0-9-]{0,47}$'
    OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'WORKSHOP_INVALID' USING ERRCODE = 'PW400';
  END IF;
  -- Serializes retries and the durable per-user admission limit across API instances.
  PERFORM pg_advisory_xact_lock(hashtextextended('workshop:user:' || p_user_id::text, 0));
  SELECT * INTO old_run FROM purama_ai.chef_workshop_runs
    WHERE user_id = p_user_id AND request_id = p_request_id;
  IF FOUND THEN
    IF old_run.project_id <> p_project_id OR old_run.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'WORKSHOP_CONFLICT' USING ERRCODE = 'PW409';
    END IF;
    RETURN old_run.mission_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workshop:project:' || p_project_id, 0));
  IF NOT EXISTS (SELECT 1 FROM purama_ai.chef_workshop_runtimes
    WHERE project_id = p_project_id AND online AND config_hash = p_config_hash
      AND heartbeat_at > clock_timestamp() - interval '20 seconds') THEN
    RAISE EXCEPTION 'WORKSHOP_UNAVAILABLE' USING ERRCODE = 'PW503';
  END IF;
  IF (SELECT count(*) FROM purama_ai.chef_workshop_runs
      WHERE user_id = p_user_id AND created_at > clock_timestamp() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'WORKSHOP_RATE_LIMIT' USING ERRCODE = 'PW429';
  END IF;
  -- A finished state alone must never release a workspace with a surviving process.
  UPDATE purama_ai.chef_workshop_runs r SET finished_at = clock_timestamp()
  FROM purama_ai.chef_missions m
  WHERE r.project_id = p_project_id AND r.finished_at IS NULL AND r.cancel_requested_at IS NULL
    AND m.id = r.mission_id AND m.state IN ('verified_done', 'failed')
    AND NOT EXISTS (SELECT 1 FROM purama_ai.chef_tasks t
      WHERE t.mission_id = m.id AND t.state IN ('claimed','running','verifying'))
    AND purama_ai.chef_workshop_processes_stopped(m.id);
  IF EXISTS (SELECT 1 FROM purama_ai.chef_workshop_runs WHERE project_id = p_project_id AND finished_at IS NULL) THEN
    RAISE EXCEPTION 'WORKSHOP_BUSY' USING ERRCODE = 'PW423';
  END IF;
  new_id := purama_ai.chef_create_mission(p_user_id, p_brief, p_brief_hash,
    p_max_parallel, p_token_budget, p_cost_budget_micros);
  INSERT INTO purama_ai.chef_workshop_runs(mission_id,user_id,project_id,request_id,request_hash)
    VALUES(new_id,p_user_id,p_project_id,p_request_id,p_request_hash);
  RETURN new_id;
END;
$$;

CREATE FUNCTION purama_ai.chef_workshop_cancel(p_user_id uuid, p_mission_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE current_state text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM purama_ai.chef_workshop_runs
    WHERE mission_id = p_mission_id AND user_id = p_user_id) THEN RETURN false; END IF;
  SELECT state INTO current_state FROM purama_ai.chef_missions WHERE id = p_mission_id FOR UPDATE;
  IF current_state IN ('verified_done','failed') THEN RETURN true; END IF;
  UPDATE purama_ai.chef_workshop_runs SET cancel_requested_at = COALESCE(cancel_requested_at,clock_timestamp())
    WHERE mission_id = p_mission_id;
  -- Blocks further claims but deliberately keeps active task leases and scope locks.
  -- The public projection remains 'cancelling' until process stop is confirmed.
  UPDATE purama_ai.chef_missions SET state = 'cancelled', finished_at = NULL, updated_at = clock_timestamp()
    WHERE id = p_mission_id;
  RETURN true;
END;
$$;

CREATE FUNCTION purama_ai.chef_workshop_finish_cancel(p_mission_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM purama_ai.chef_missions WHERE id = p_mission_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM purama_ai.chef_workshop_runs
    WHERE mission_id = p_mission_id AND cancel_requested_at IS NOT NULL) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM purama_ai.chef_tasks
      WHERE mission_id = p_mission_id AND state IN ('claimed','running','verifying'))
    OR NOT purama_ai.chef_workshop_processes_stopped(p_mission_id) THEN
    RETURN false;
  END IF;
  UPDATE purama_ai.chef_tasks SET state = 'cancelled', updated_at = clock_timestamp(),
    finished_at = clock_timestamp()
    WHERE mission_id = p_mission_id AND state NOT IN ('verified_done','failed','cancelled');
  UPDATE purama_ai.chef_missions SET state = 'cancelled',
    updated_at = clock_timestamp(), finished_at = clock_timestamp() WHERE id = p_mission_id;
  UPDATE purama_ai.chef_workshop_runs SET finished_at = clock_timestamp() WHERE mission_id = p_mission_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.chef_workshop_heartbeat(text,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_workshop_submit(uuid,text,uuid,text,text,jsonb,text,integer,bigint,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_workshop_cancel(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_workshop_finish_cancel(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_workshop_heartbeat(text,uuid,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_workshop_submit(uuid,text,uuid,text,text,jsonb,text,integer,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_workshop_cancel(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_workshop_finish_cancel(uuid) TO service_role;
REVOKE ALL ON FUNCTION purama_ai.chef_workshop_processes_stopped(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_workshop_processes_stopped(uuid) TO service_role;
COMMIT;
