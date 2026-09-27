-- PURAMA CHEF hardening: exclusive writers, stale-worker detection and idempotent usage budgets.
BEGIN;

ALTER TABLE purama_ai.chef_tasks
  ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'write'
    CHECK (access_mode IN ('read','write')),
  ADD COLUMN IF NOT EXISTS scope_key text,
  ADD COLUMN IF NOT EXISTS estimated_tokens bigint
    CHECK (estimated_tokens IS NULL OR estimated_tokens >= 0),
  ADD COLUMN IF NOT EXISTS estimated_cost_micros bigint
    CHECK (estimated_cost_micros IS NULL OR estimated_cost_micros >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS chef_one_writer_per_worktree
  ON purama_ai.chef_tasks(worktree)
  WHERE worktree IS NOT NULL
    AND access_mode = 'write'
    AND state IN ('claimed','running','verifying');

CREATE UNIQUE INDEX IF NOT EXISTS chef_one_writer_per_scope
  ON purama_ai.chef_tasks(repo, scope_key)
  WHERE scope_key IS NOT NULL
    AND access_mode = 'write'
    AND state IN ('claimed','running','verifying');

CREATE TABLE IF NOT EXISTS purama_ai.chef_usage_events (
  id bigserial PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  mission_id uuid NOT NULL REFERENCES purama_ai.chef_missions(id) ON DELETE CASCADE,
  task_id uuid REFERENCES purama_ai.chef_tasks(id) ON DELETE CASCADE,
  worker_id text,
  provider text CHECK (provider IS NULL OR provider IN ('codex','claude','glm')),
  model text,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_input_tokens bigint NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE purama_ai.chef_usage_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.chef_usage_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON purama_ai.chef_usage_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE purama_ai.chef_usage_events_id_seq TO service_role;

CREATE INDEX IF NOT EXISTS idx_chef_usage_mission
  ON purama_ai.chef_usage_events(mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chef_usage_task
  ON purama_ai.chef_usage_events(task_id, created_at);

CREATE OR REPLACE FUNCTION purama_ai.chef_mark_stale_workers(p_stale_seconds integer DEFAULT 120)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  changed integer;
BEGIN
  IF p_stale_seconds < 30 OR p_stale_seconds > 86400 THEN
    RAISE EXCEPTION 'Invalid stale threshold';
  END IF;

  UPDATE purama_ai.chef_workers
  SET
    state = 'offline',
    updated_at = now(),
    last_error = 'Heartbeat expiré'
  WHERE heartbeat_at < now() - make_interval(secs => p_stale_seconds)
    AND state <> 'offline';

  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.chef_record_usage(
  p_event_key text,
  p_mission_id uuid,
  p_task_id uuid,
  p_worker_id text,
  p_provider text,
  p_model text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cached_input_tokens bigint,
  p_cost_micros bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  inserted_id bigint;
  delta_tokens bigint;
  budget_now_exceeded boolean;
BEGIN
  IF p_event_key IS NULL OR length(p_event_key) < 8 OR length(p_event_key) > 256 THEN
    RAISE EXCEPTION 'Invalid usage event key';
  END IF;
  IF p_provider IS NOT NULL AND p_provider NOT IN ('codex','claude','glm') THEN
    RAISE EXCEPTION 'Invalid provider';
  END IF;
  IF p_input_tokens < 0 OR p_output_tokens < 0 OR p_cached_input_tokens < 0 OR p_cost_micros < 0 THEN
    RAISE EXCEPTION 'Negative usage';
  END IF;
  IF p_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM purama_ai.chef_tasks
    WHERE id = p_task_id AND mission_id = p_mission_id
  ) THEN
    RAISE EXCEPTION 'Task is not part of mission';
  END IF;

  delta_tokens := p_input_tokens + p_output_tokens;

  INSERT INTO purama_ai.chef_usage_events(
    event_key, mission_id, task_id, worker_id, provider, model,
    input_tokens, output_tokens, cached_input_tokens, cost_micros
  ) VALUES (
    p_event_key, p_mission_id, p_task_id, p_worker_id, p_provider, p_model,
    p_input_tokens, p_output_tokens, p_cached_input_tokens, p_cost_micros
  )
  ON CONFLICT(event_key) DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NULL THEN
    RETURN false;
  END IF;

  IF p_task_id IS NOT NULL THEN
    UPDATE purama_ai.chef_tasks
    SET
      tokens_used = tokens_used + delta_tokens,
      cost_used_micros = cost_used_micros + p_cost_micros,
      updated_at = now()
    WHERE id = p_task_id;
  END IF;

  UPDATE purama_ai.chef_missions
  SET
    tokens_used = tokens_used + delta_tokens,
    cost_used_micros = cost_used_micros + p_cost_micros,
    updated_at = now()
  WHERE id = p_mission_id
  RETURNING (
    (token_budget IS NOT NULL AND tokens_used > token_budget)
    OR
    (cost_budget_micros IS NOT NULL AND cost_used_micros > cost_budget_micros)
  ) INTO budget_now_exceeded;

  IF budget_now_exceeded THEN
    UPDATE purama_ai.chef_missions
    SET state = 'paused', updated_at = now()
    WHERE id = p_mission_id AND state = 'active';

    INSERT INTO purama_ai.chef_events(mission_id, task_id, worker_id, kind, payload)
    VALUES (
      p_mission_id, p_task_id, p_worker_id, 'budget_exhausted',
      jsonb_build_object('event_key', p_event_key, 'tokens', delta_tokens, 'cost_micros', p_cost_micros)
    );
  END IF;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.chef_claim_next_task(
  p_mission_id uuid,
  p_worker_id text,
  p_provider text,
  p_lease_seconds integer DEFAULT 300
)
RETURNS SETOF purama_ai.chef_tasks
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_id uuid;
  parallel_limit integer;
  active_count integer;
  mission_token_budget bigint;
  mission_cost_budget bigint;
  mission_tokens_used bigint;
  mission_cost_used bigint;
  worker_provider text;
  worker_state text;
  worker_task uuid;
  worker_heartbeat timestamptz;
  budget_blocked boolean;
BEGIN
  IF p_provider NOT IN ('codex','claude','glm') THEN RAISE EXCEPTION 'Invalid provider'; END IF;
  IF p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'Invalid lease'; END IF;

  SELECT provider, state, current_task_id, heartbeat_at
    INTO worker_provider, worker_state, worker_task, worker_heartbeat
  FROM purama_ai.chef_workers
  WHERE worker_id = p_worker_id
  FOR UPDATE;

  IF worker_provider IS NULL
     OR worker_provider <> p_provider
     OR worker_state <> 'idle'
     OR worker_task IS NOT NULL
     OR worker_heartbeat < now() - interval '2 minutes' THEN
    RETURN;
  END IF;

  PERFORM purama_ai.chef_refresh_ready_tasks(p_mission_id);

  SELECT max_parallel, token_budget, cost_budget_micros, tokens_used, cost_used_micros
    INTO parallel_limit, mission_token_budget, mission_cost_budget, mission_tokens_used, mission_cost_used
  FROM purama_ai.chef_missions
  WHERE id = p_mission_id AND state IN ('active','human_required','external_required')
  FOR UPDATE;
  IF parallel_limit IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO active_count
  FROM purama_ai.chef_tasks
  WHERE mission_id = p_mission_id AND state IN ('claimed','running','verifying');
  IF active_count >= parallel_limit THEN RETURN; END IF;

  SELECT t.id INTO selected_id
  FROM purama_ai.chef_tasks t
  WHERE t.mission_id = p_mission_id
    AND t.state = 'ready'
    AND t.attempt < t.max_attempts
    AND (t.provider = 'auto' OR t.provider = p_provider)
    AND (
      mission_token_budget IS NULL
      OR mission_tokens_used + COALESCE(t.estimated_tokens, 0) <= mission_token_budget
    )
    AND (
      mission_cost_budget IS NULL
      OR mission_cost_used + COALESCE(t.estimated_cost_micros, 0) <= mission_cost_budget
    )
    AND (
      t.access_mode = 'read'
      OR (
        (t.worktree IS NULL OR NOT EXISTS (
          SELECT 1 FROM purama_ai.chef_tasks busy
          WHERE busy.id <> t.id
            AND busy.worktree = t.worktree
            AND busy.access_mode = 'write'
            AND busy.state IN ('claimed','running','verifying')
        ))
        AND
        (t.scope_key IS NULL OR NOT EXISTS (
          SELECT 1 FROM purama_ai.chef_tasks busy
          WHERE busy.id <> t.id
            AND busy.repo = t.repo
            AND busy.scope_key = t.scope_key
            AND busy.access_mode = 'write'
            AND busy.state IN ('claimed','running','verifying')
        ))
      )
    )
  ORDER BY t.priority DESC, t.created_at, t.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF selected_id IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM purama_ai.chef_tasks t
      WHERE t.mission_id = p_mission_id
        AND t.state = 'ready'
        AND t.attempt < t.max_attempts
        AND (t.provider = 'auto' OR t.provider = p_provider)
        AND (
          (mission_token_budget IS NOT NULL
            AND mission_tokens_used + COALESCE(t.estimated_tokens, 0) > mission_token_budget)
          OR
          (mission_cost_budget IS NOT NULL
            AND mission_cost_used + COALESCE(t.estimated_cost_micros, 0) > mission_cost_budget)
        )
    ) INTO budget_blocked;

    IF budget_blocked THEN
      UPDATE purama_ai.chef_missions
      SET state = 'paused', updated_at = now()
      WHERE id = p_mission_id AND state = 'active';

      INSERT INTO purama_ai.chef_events(mission_id, worker_id, kind, payload)
      VALUES (p_mission_id, p_worker_id, 'budget_blocked', '{}'::jsonb);
    END IF;
    RETURN;
  END IF;

  BEGIN
    UPDATE purama_ai.chef_tasks
    SET
      state = 'claimed',
      assigned_provider = p_provider,
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      fencing_token = fencing_token + 1,
      attempt = attempt + 1,
      started_at = COALESCE(started_at, now()),
      updated_at = now(),
      last_error = NULL
    WHERE id = selected_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN;
  END;

  UPDATE purama_ai.chef_workers
  SET state = 'claimed', current_task_id = selected_id, heartbeat_at = now(), updated_at = now()
  WHERE worker_id = p_worker_id;

  INSERT INTO purama_ai.chef_events(mission_id, task_id, worker_id, kind, payload)
  SELECT mission_id, id, p_worker_id, 'task_claimed',
    jsonb_build_object('provider', p_provider, 'fencing_token', fencing_token, 'attempt', attempt)
  FROM purama_ai.chef_tasks WHERE id = selected_id;

  RETURN QUERY SELECT * FROM purama_ai.chef_tasks WHERE id = selected_id;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.chef_unblock_task(
  p_task_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  mission uuid;
  current_state text;
BEGIN
  SELECT mission_id, state INTO mission, current_state
  FROM purama_ai.chef_tasks
  WHERE id = p_task_id
  FOR UPDATE;

  IF mission IS NULL OR current_state NOT IN ('blocked_human','blocked_external') THEN RETURN false; END IF;

  UPDATE purama_ai.chef_tasks
  SET state = 'pending', last_error = p_reason, updated_at = now()
  WHERE id = p_task_id;

  PERFORM purama_ai.chef_refresh_ready_tasks(mission);

  IF NOT EXISTS (
    SELECT 1 FROM purama_ai.chef_tasks
    WHERE mission_id = mission AND state IN ('blocked_human','blocked_external')
  ) THEN
    UPDATE purama_ai.chef_missions
    SET state = 'active', updated_at = now()
    WHERE id = mission AND state IN ('human_required','external_required');
  END IF;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.chef_transition_task(
  p_task_id uuid,
  p_worker_id text,
  p_fencing_token bigint,
  p_target_state text,
  p_error text DEFAULT NULL,
  p_output_sha text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  task_row purama_ai.chef_tasks%ROWTYPE;
  final_state text;
  evidence_count integer;
BEGIN
  SELECT * INTO task_row FROM purama_ai.chef_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF task_row.lease_owner IS DISTINCT FROM p_worker_id OR task_row.fencing_token <> p_fencing_token THEN
    RETURN false;
  END IF;
  IF task_row.lease_expires_at IS NULL OR task_row.lease_expires_at <= now() THEN RETURN false; END IF;

  final_state := p_target_state;
  IF p_target_state = 'running' AND task_row.state <> 'claimed' THEN RETURN false; END IF;
  IF p_target_state = 'verifying' AND task_row.state <> 'running' THEN RETURN false; END IF;
  IF p_target_state = 'verified_done' AND task_row.state <> 'verifying' THEN RETURN false; END IF;
  IF p_target_state IN ('retryable','blocked_human','blocked_external','failed')
     AND task_row.state NOT IN ('claimed','running','verifying') THEN RETURN false; END IF;
  IF p_target_state NOT IN ('running','verifying','verified_done','retryable','blocked_human','blocked_external','failed') THEN
    RETURN false;
  END IF;

  IF p_target_state = 'verified_done' THEN
    SELECT count(*) INTO evidence_count FROM purama_ai.chef_evidence WHERE task_id = p_task_id;
    IF evidence_count = 0 THEN RAISE EXCEPTION 'Verified task requires evidence'; END IF;
  END IF;

  IF p_target_state = 'retryable' AND task_row.attempt >= task_row.max_attempts THEN
    final_state := 'failed';
  END IF;

  UPDATE purama_ai.chef_tasks
  SET
    state = final_state,
    output_sha = COALESCE(p_output_sha, output_sha),
    last_error = p_error,
    finished_at = CASE WHEN final_state IN ('verified_done','failed','cancelled') THEN now() ELSE NULL END,
    lease_owner = CASE WHEN final_state IN ('running','verifying') THEN lease_owner ELSE NULL END,
    lease_expires_at = CASE WHEN final_state IN ('running','verifying') THEN lease_expires_at ELSE NULL END,
    updated_at = now()
  WHERE id = p_task_id;

  UPDATE purama_ai.chef_workers
  SET
    state = CASE
      WHEN final_state = 'running' THEN 'running'
      WHEN final_state = 'verifying' THEN 'verifying'
      WHEN final_state IN ('blocked_human','blocked_external') THEN 'blocked'
      WHEN final_state = 'failed' THEN 'failed'
      ELSE 'idle'
    END,
    current_task_id = CASE WHEN final_state IN ('running','verifying') THEN p_task_id ELSE NULL END,
    heartbeat_at = now(),
    updated_at = now(),
    last_error = p_error
  WHERE worker_id = p_worker_id;

  INSERT INTO purama_ai.chef_events(mission_id, task_id, worker_id, kind, payload)
  VALUES(task_row.mission_id, p_task_id, p_worker_id, 'task_transition',
    jsonb_build_object('from', task_row.state, 'to', final_state, 'fencing_token', p_fencing_token));

  IF final_state = 'blocked_human' THEN
    UPDATE purama_ai.chef_missions
    SET state = 'human_required', updated_at = now()
    WHERE id = task_row.mission_id AND state = 'active';
  ELSIF final_state = 'blocked_external' THEN
    UPDATE purama_ai.chef_missions
    SET state = 'external_required', updated_at = now()
    WHERE id = task_row.mission_id AND state = 'active';
  ELSIF final_state = 'failed' AND task_row.required THEN
    UPDATE purama_ai.chef_missions
    SET state = 'failed', finished_at = now(), updated_at = now()
    WHERE id = task_row.mission_id AND state <> 'cancelled';
  ELSIF final_state = 'verified_done' THEN
    PERFORM purama_ai.chef_refresh_ready_tasks(task_row.mission_id);
    PERFORM purama_ai.chef_try_finish_mission(task_row.mission_id);
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.chef_mark_stale_workers(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_record_usage(text,uuid,uuid,text,text,text,bigint,bigint,bigint,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_unblock_task(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_claim_next_task(uuid,text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_transition_task(uuid,text,bigint,text,text,text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION purama_ai.chef_mark_stale_workers(integer) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_record_usage(text,uuid,uuid,text,text,text,bigint,bigint,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_unblock_task(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_claim_next_task(uuid,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_transition_task(uuid,text,bigint,text,text,text) TO service_role;

COMMIT;
