-- PURAMA CHEF: atomic ingestion of one canonical brief into the durable control plane.
BEGIN;

CREATE OR REPLACE FUNCTION purama_ai.chef_create_mission(
  p_user_id uuid,
  p_brief jsonb,
  p_brief_hash text,
  p_max_parallel integer DEFAULT 4,
  p_token_budget bigint DEFAULT NULL,
  p_cost_budget_micros bigint DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  mission uuid;
  existing_hash text;
  req jsonb;
  task jsonb;
  dep_key text;
  req_key text;
  task_id_value uuid;
  dep_id uuid;
  req_id uuid;
  profile_count integer;
BEGIN
  IF p_user_id IS NULL OR p_brief IS NULL OR jsonb_typeof(p_brief) <> 'object' THEN
    RAISE EXCEPTION 'Invalid mission brief';
  END IF;
  IF p_brief_hash IS NULL OR p_brief_hash !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'Invalid brief hash';
  END IF;
  IF p_max_parallel < 1 OR p_max_parallel > 64 THEN RAISE EXCEPTION 'Invalid max_parallel'; END IF;
  IF p_token_budget IS NOT NULL AND p_token_budget < 0 THEN RAISE EXCEPTION 'Invalid token budget'; END IF;
  IF p_cost_budget_micros IS NOT NULL AND p_cost_budget_micros < 0 THEN RAISE EXCEPTION 'Invalid cost budget'; END IF;
  IF NULLIF(btrim(p_brief->>'briefId'), '') IS NULL
     OR NULLIF(btrim(p_brief->>'goal'), '') IS NULL
     OR NULLIF(btrim(p_brief->>'repo'), '') IS NULL
     OR COALESCE((p_brief->>'version')::integer, 0) < 1
     OR jsonb_typeof(p_brief->'requirements') <> 'array'
     OR jsonb_array_length(p_brief->'requirements') = 0
     OR jsonb_typeof(p_brief->'tasks') <> 'array'
     OR jsonb_array_length(p_brief->'tasks') = 0 THEN
    RAISE EXCEPTION 'Incomplete mission brief';
  END IF;

  SELECT id, brief_hash INTO mission, existing_hash
  FROM purama_ai.chef_missions
  WHERE user_id = p_user_id
    AND brief_id = p_brief->>'briefId'
    AND brief_version = (p_brief->>'version')::integer
  FOR UPDATE;

  IF mission IS NOT NULL THEN
    IF existing_hash <> lower(p_brief_hash) THEN RAISE EXCEPTION 'Brief version already exists with another hash'; END IF;
    RETURN mission;
  END IF;

  INSERT INTO purama_ai.chef_missions(
    user_id, brief_id, brief_version, brief_hash, goal, repo, state, max_parallel,
    token_budget, cost_budget_micros, started_at
  ) VALUES (
    p_user_id, p_brief->>'briefId', (p_brief->>'version')::integer, lower(p_brief_hash),
    p_brief->>'goal', p_brief->>'repo', 'planning', p_max_parallel,
    p_token_budget, p_cost_budget_micros, now()
  ) RETURNING id INTO mission;

  FOR req IN SELECT value FROM jsonb_array_elements(p_brief->'requirements') LOOP
    IF NULLIF(btrim(req->>'key'), '') IS NULL OR NULLIF(btrim(req->>'description'), '') IS NULL THEN
      RAISE EXCEPTION 'Invalid requirement';
    END IF;
    INSERT INTO purama_ai.chef_requirements(mission_id, requirement_key, description, critical)
    VALUES(mission, req->>'key', req->>'description', COALESCE((req->>'critical')::boolean, true));
  END LOOP;

  FOR task IN SELECT value FROM jsonb_array_elements(p_brief->'tasks') LOOP
    IF NULLIF(btrim(task->>'key'), '') IS NULL
       OR NULLIF(btrim(task->>'title'), '') IS NULL
       OR NULLIF(btrim(task->>'instructions'), '') IS NULL THEN
      RAISE EXCEPTION 'Invalid task';
    END IF;
    IF COALESCE(task->>'provider','auto') NOT IN ('auto','codex','claude','glm') THEN
      RAISE EXCEPTION 'Invalid provider';
    END IF;
    IF COALESCE(task->>'accessMode','write') NOT IN ('read','write') THEN
      RAISE EXCEPTION 'Invalid access mode';
    END IF;

    SELECT count(*) INTO profile_count
    FROM jsonb_array_elements_text(COALESCE(task->'verificationProfiles','[]'::jsonb));
    IF profile_count < 1 OR profile_count > 32 THEN RAISE EXCEPTION 'Task requires verification profiles'; END IF;

    INSERT INTO purama_ai.chef_tasks(
      mission_id, task_key, title, instructions, state, priority, provider,
      worktree, brief_hash, max_attempts, access_mode, scope_key, verification_profiles
    ) VALUES (
      mission, task->>'key', task->>'title', task->>'instructions', 'pending',
      COALESCE((task->>'priority')::integer, 0),
      COALESCE(task->>'provider','auto'),
      NULLIF(task->>'worktree',''),
      lower(p_brief_hash),
      COALESCE((task->>'maxAttempts')::integer, 3),
      COALESCE(task->>'accessMode','write'),
      NULLIF(task->>'scopeKey',''),
      ARRAY(SELECT jsonb_array_elements_text(task->'verificationProfiles'))
    );
  END LOOP;

  FOR task IN SELECT value FROM jsonb_array_elements(p_brief->'tasks') LOOP
    SELECT id INTO task_id_value
    FROM purama_ai.chef_tasks
    WHERE mission_id = mission AND task_key = task->>'key';

    FOR dep_key IN SELECT value FROM jsonb_array_elements_text(COALESCE(task->'dependsOn','[]'::jsonb)) LOOP
      SELECT id INTO dep_id
      FROM purama_ai.chef_tasks
      WHERE mission_id = mission AND task_key = dep_key;
      IF dep_id IS NULL THEN RAISE EXCEPTION 'Unknown dependency: %', dep_key; END IF;
      INSERT INTO purama_ai.chef_task_dependencies(task_id, depends_on_task_id)
      VALUES(task_id_value, dep_id);
    END LOOP;

    FOR req_key IN SELECT value FROM jsonb_array_elements_text(COALESCE(task->'requirementKeys','[]'::jsonb)) LOOP
      SELECT id INTO req_id
      FROM purama_ai.chef_requirements
      WHERE mission_id = mission AND requirement_key = req_key;
      IF req_id IS NULL THEN RAISE EXCEPTION 'Unknown requirement: %', req_key; END IF;
      INSERT INTO purama_ai.chef_task_requirements(task_id, requirement_id)
      VALUES(task_id_value, req_id);
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM purama_ai.chef_requirements r
    WHERE r.mission_id = mission
      AND NOT EXISTS (
        SELECT 1 FROM purama_ai.chef_task_requirements tr WHERE tr.requirement_id = r.id
      )
  ) THEN
    RAISE EXCEPTION 'Requirement without task';
  END IF;

  UPDATE purama_ai.chef_missions
  SET state = 'active', updated_at = now()
  WHERE id = mission;

  PERFORM purama_ai.chef_refresh_ready_tasks(mission);

  INSERT INTO purama_ai.chef_events(mission_id, kind, payload)
  VALUES(
    mission,
    'mission_created',
    jsonb_build_object('brief_id', p_brief->>'briefId', 'version', (p_brief->>'version')::integer, 'brief_hash', lower(p_brief_hash))
  );

  RETURN mission;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.chef_create_mission(uuid,jsonb,text,integer,bigint,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_create_mission(uuid,jsonb,text,integer,bigint,bigint)
  TO service_role;

COMMIT;
