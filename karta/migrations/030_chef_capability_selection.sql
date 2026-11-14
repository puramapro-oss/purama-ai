-- PURAMA CHEF: persist task capability choices across creation, claiming and recovery.
-- This stores preferences only. Authorization and availability are rechecked by the driver.
-- The previous ownership, dependency, estimate and service-role contracts remain in force.
BEGIN;

CREATE OR REPLACE FUNCTION purama_ai.chef_normalize_capability_selection(p_selection jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  field_name text;
  field_value jsonb;
  needs jsonb;
  selected_ids jsonb;
  excluded_ids jsonb;
  max_selected numeric := 8;
BEGIN
  IF p_selection IS NULL OR jsonb_typeof(p_selection) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid capability selection';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_selection) key
    WHERE key <> ALL (ARRAY['mode','needs','selectedIds','excludedIds','maxSelected']))
    OR p_selection->>'mode' IS NULL OR p_selection->>'mode' NOT IN ('auto','manual')
    OR jsonb_typeof(p_selection->'needs') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid capability selection fields';
  END IF;
  FOREACH field_name IN ARRAY ARRAY['needs','selectedIds','excludedIds'] LOOP
    field_value := COALESCE(p_selection->field_name, '[]'::jsonb);
    IF jsonb_typeof(field_value) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid capability selection array';
    END IF;
    IF jsonb_array_length(field_value) > 32 THEN
      RAISE EXCEPTION 'Invalid capability selection array length';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(field_value) item
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
        OR (item #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$') THEN
      RAISE EXCEPTION 'Invalid capability selection identifier';
    END IF;
    SELECT COALESCE(jsonb_agg(value ORDER BY value COLLATE "C"), '[]'::jsonb)
      INTO field_value FROM (SELECT DISTINCT value FROM jsonb_array_elements_text(field_value)) canonical;
    IF field_name = 'needs' THEN needs := field_value;
    ELSIF field_name = 'selectedIds' THEN selected_ids := field_value;
    ELSE excluded_ids := field_value;
    END IF;
  END LOOP;
  IF p_selection ? 'maxSelected' THEN
    IF jsonb_typeof(p_selection->'maxSelected') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Invalid capability selection limit';
    END IF;
    max_selected := (p_selection->>'maxSelected')::numeric;
    IF max_selected < 1 OR max_selected > 16 OR max_selected <> trunc(max_selected) THEN
      RAISE EXCEPTION 'Invalid capability selection limit';
    END IF;
  END IF;
  IF p_selection->>'mode' = 'auto' AND jsonb_array_length(selected_ids) > 0 THEN
    RAISE EXCEPTION 'Invalid capability selection: auto cannot pin IDs';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(selected_ids) chosen
    JOIN jsonb_array_elements_text(excluded_ids) excluded USING (value)) THEN
    RAISE EXCEPTION 'Invalid capability selection: selected and excluded';
  END IF;
  RETURN jsonb_build_object('mode', p_selection->>'mode', 'needs', needs,
    'selectedIds', selected_ids, 'excludedIds', excluded_ids, 'maxSelected', max_selected::integer);
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.chef_normalize_capability_selection(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_normalize_capability_selection(jsonb) TO service_role;

ALTER TABLE purama_ai.chef_tasks ADD COLUMN IF NOT EXISTS capability_selection jsonb;
ALTER TABLE purama_ai.chef_tasks DROP CONSTRAINT IF EXISTS chef_capability_selection_canonical;
ALTER TABLE purama_ai.chef_tasks ADD CONSTRAINT chef_capability_selection_canonical
  CHECK (capability_selection IS NULL OR
    capability_selection = purama_ai.chef_normalize_capability_selection(capability_selection));

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
  task_access text;
  task_allowed_paths text[];
  estimate_key text;
  estimate_value numeric;
  task_estimated_tokens bigint;
  task_estimated_cost_micros bigint;
  task_capability_selection jsonb;
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

  -- Validate even replayed input before accepting an existing canonical mission.
  FOR task IN SELECT value FROM jsonb_array_elements(p_brief->'tasks') LOOP
    IF task ? 'capabilitySelection' THEN
      PERFORM purama_ai.chef_normalize_capability_selection(task->'capabilitySelection');
    END IF;
  END LOOP;

  SELECT id, brief_hash INTO mission, existing_hash
  FROM purama_ai.chef_missions
  WHERE user_id = p_user_id
    AND brief_id = p_brief->>'briefId'
    AND brief_version = (p_brief->>'version')::integer
  FOR UPDATE;

  IF mission IS NOT NULL THEN
    IF existing_hash <> lower(p_brief_hash) THEN RAISE EXCEPTION 'Brief version already exists with another hash'; END IF;
    -- A service-side hash mistake must not silently ignore a changed selection contract.
    FOR task IN SELECT value FROM jsonb_array_elements(p_brief->'tasks') LOOP
      task_capability_selection := CASE WHEN task ? 'capabilitySelection'
        THEN purama_ai.chef_normalize_capability_selection(task->'capabilitySelection') ELSE NULL END;
      IF EXISTS (SELECT 1 FROM purama_ai.chef_tasks persisted
        WHERE persisted.mission_id = mission AND persisted.task_key = task->>'key'
          AND persisted.capability_selection IS DISTINCT FROM task_capability_selection) THEN
        RAISE EXCEPTION 'Capability selection differs from existing brief';
      END IF;
    END LOOP;
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
    task_access := COALESCE(task->>'accessMode','write');
    IF task_access NOT IN ('read','write') THEN
      RAISE EXCEPTION 'Invalid access mode';
    END IF;

    task_allowed_paths := ARRAY(
      SELECT value FROM jsonb_array_elements_text(COALESCE(task->'allowedPaths','[]'::jsonb))
    );
    IF task_access = 'write' AND NOT purama_ai.chef_valid_allowed_paths(task_allowed_paths) THEN
      RAISE EXCEPTION 'Write task requires valid allowedPaths';
    END IF;

    SELECT count(*) INTO profile_count
    FROM jsonb_array_elements_text(COALESCE(task->'verificationProfiles','[]'::jsonb));
    IF profile_count < 1 OR profile_count > 32 THEN RAISE EXCEPTION 'Task requires verification profiles'; END IF;

    task_estimated_tokens := NULL;
    task_estimated_cost_micros := NULL;
    FOREACH estimate_key IN ARRAY ARRAY['estimatedTokens', 'estimatedCostMicros'] LOOP
      IF task ? estimate_key THEN
        IF jsonb_typeof(task->estimate_key) IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'Invalid task estimate: %', estimate_key;
        END IF;
        estimate_value := (task->>estimate_key)::numeric;
        IF estimate_value < 0 OR estimate_value > 9007199254740991
           OR estimate_value <> trunc(estimate_value) THEN
          RAISE EXCEPTION 'Invalid task estimate: %', estimate_key;
        END IF;
        IF estimate_key = 'estimatedTokens' THEN
          task_estimated_tokens := estimate_value::bigint;
        ELSE
          task_estimated_cost_micros := estimate_value::bigint;
        END IF;
      END IF;
    END LOOP;
    IF p_token_budget IS NOT NULL AND task_estimated_tokens IS NULL THEN
      RAISE EXCEPTION 'Task requires estimatedTokens with token budget';
    END IF;
    IF p_cost_budget_micros IS NOT NULL AND task_estimated_cost_micros IS NULL THEN
      RAISE EXCEPTION 'Task requires estimatedCostMicros with cost budget';
    END IF;

    task_capability_selection := CASE WHEN task ? 'capabilitySelection'
      THEN purama_ai.chef_normalize_capability_selection(task->'capabilitySelection') ELSE NULL END;

    INSERT INTO purama_ai.chef_tasks(
      mission_id, task_key, title, instructions, state, priority, provider,
      worktree, brief_hash, max_attempts, access_mode, scope_key, verification_profiles, allowed_paths,
      estimated_tokens, estimated_cost_micros, capability_selection
    ) VALUES (
      mission, task->>'key', task->>'title', task->>'instructions', 'pending',
      COALESCE((task->>'priority')::integer, 0),
      COALESCE(task->>'provider','auto'),
      NULLIF(task->>'worktree',''),
      lower(p_brief_hash),
      COALESCE((task->>'maxAttempts')::integer, 3),
      task_access,
      NULLIF(task->>'scopeKey',''),
      ARRAY(SELECT jsonb_array_elements_text(task->'verificationProfiles')),
      task_allowed_paths,
      task_estimated_tokens,
      task_estimated_cost_micros,
      task_capability_selection
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
