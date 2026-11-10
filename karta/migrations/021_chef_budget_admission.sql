-- PURAMA CHEF: serialize cumulative estimated-budget admission across workers.
-- Estimates reserve capacity only while tasks are claimed/running/verifying.
-- Actual provider charges, unknown outcomes, expired leases, and missing usage
-- receipts still require provider-side ceilings and reconciliation; this RPC
-- must not be marketed as a hard currency spending cap.
BEGIN;

CREATE OR REPLACE FUNCTION purama_ai.chef_claim_next_task(
  p_mission_id uuid,
  p_worker_id text,
  p_session_id text,
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
  mission_repo text;
  mission_token_budget bigint;
  mission_cost_budget bigint;
  mission_tokens_used bigint;
  mission_cost_used bigint;
  worker_provider text;
  worker_state text;
  worker_task uuid;
  worker_heartbeat timestamptz;
  worker_session text;
  worker_repo text;
  worker_worktree text;
  budget_blocked boolean;
  reserved_tokens numeric;
  reserved_cost numeric;
  unknown_token_reservation boolean;
  unknown_cost_reservation boolean;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('codex','claude','glm') THEN RAISE EXCEPTION 'Invalid provider'; END IF;
  IF p_session_id IS NULL OR length(p_session_id) < 8 OR length(p_session_id) > 256 THEN
    RAISE EXCEPTION 'Invalid worker session';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'Invalid lease'; END IF;

  SELECT provider, state, current_task_id, heartbeat_at, session_id, repo, worktree
    INTO worker_provider, worker_state, worker_task, worker_heartbeat, worker_session, worker_repo, worker_worktree
  FROM purama_ai.chef_workers
  WHERE worker_id = p_worker_id
  FOR UPDATE;

  IF worker_provider IS NULL
     OR worker_provider <> p_provider
     OR worker_session <> p_session_id
     OR worker_state <> 'idle'
     OR worker_task IS NOT NULL
     OR worker_heartbeat < now() - interval '2 minutes' THEN
    RETURN;
  END IF;

  PERFORM purama_ai.chef_refresh_ready_tasks(p_mission_id);

  SELECT repo, max_parallel, token_budget, cost_budget_micros, tokens_used, cost_used_micros
    INTO mission_repo, parallel_limit, mission_token_budget, mission_cost_budget, mission_tokens_used, mission_cost_used
  FROM purama_ai.chef_missions
  WHERE id = p_mission_id AND state IN ('active','human_required','external_required')
  FOR UPDATE;
  IF parallel_limit IS NULL THEN RETURN; END IF;
  IF worker_repo IS DISTINCT FROM mission_repo THEN RETURN; END IF;

  -- The mission row lock serializes admissions. Keep the whole estimate until
  -- the attempt leaves an active state: task usage is cumulative across retries
  -- and cannot safely be subtracted as if it belonged to this claim generation.
  -- This is conservative admission accounting, not a provider spending limit.
  SELECT count(*), COALESCE(sum(estimated_tokens), 0),
         COALESCE(sum(estimated_cost_micros), 0),
         COALESCE(bool_or(estimated_tokens IS NULL), false),
         COALESCE(bool_or(estimated_cost_micros IS NULL), false)
    INTO active_count, reserved_tokens, reserved_cost,
         unknown_token_reservation, unknown_cost_reservation
  FROM purama_ai.chef_tasks
  WHERE mission_id = p_mission_id AND state IN ('claimed','running','verifying');
  IF active_count >= parallel_limit THEN RETURN; END IF;

  SELECT t.id INTO selected_id
  FROM purama_ai.chef_tasks t
  WHERE t.mission_id = p_mission_id
    AND t.state = 'ready'
    AND t.attempt < t.max_attempts
    AND (t.provider = 'auto' OR t.provider = p_provider)
    AND (t.worktree IS NULL OR t.worktree = worker_worktree)
    AND (
      mission_token_budget IS NULL
      OR (t.estimated_tokens IS NOT NULL AND NOT unknown_token_reservation
        AND mission_tokens_used::numeric + reserved_tokens + t.estimated_tokens <= mission_token_budget)
    )
    AND (
      mission_cost_budget IS NULL
      OR (t.estimated_cost_micros IS NOT NULL AND NOT unknown_cost_reservation
        AND mission_cost_used::numeric + reserved_cost + t.estimated_cost_micros <= mission_cost_budget)
    )
    AND (
      t.worktree IS NULL OR NOT EXISTS (
        SELECT 1 FROM purama_ai.chef_tasks busy
        WHERE busy.id <> t.id
          AND busy.worktree = t.worktree
          AND busy.state IN ('claimed','running','verifying')
      )
    )
    AND (
      t.scope_key IS NULL OR NOT EXISTS (
        SELECT 1 FROM purama_ai.chef_tasks busy
        WHERE busy.id <> t.id
          AND busy.scope_key = t.scope_key
          AND busy.state IN ('claimed','running','verifying')
      )
    )
  ORDER BY t.priority DESC, t.created_at, t.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF selected_id IS NULL THEN
    -- Capacity held by another attempt is temporary. Do not pause the mission
    -- while an active worker can finish and release its admission estimate.
    IF active_count > 0 THEN RETURN; END IF;

    SELECT EXISTS (
      SELECT 1 FROM purama_ai.chef_tasks t
      WHERE t.mission_id = p_mission_id
        AND t.state = 'ready' AND t.attempt < t.max_attempts
        AND (t.provider = 'auto' OR t.provider = p_provider)
        AND (t.worktree IS NULL OR t.worktree = worker_worktree)
        AND (
          (mission_token_budget IS NOT NULL AND (t.estimated_tokens IS NULL
            OR mission_tokens_used::numeric + t.estimated_tokens > mission_token_budget))
          OR
          (mission_cost_budget IS NOT NULL AND (t.estimated_cost_micros IS NULL
            OR mission_cost_used::numeric + t.estimated_cost_micros > mission_cost_budget))
        )
    ) AND NOT EXISTS (
      -- A different provider/worktree may still have affordable ready work.
      SELECT 1 FROM purama_ai.chef_tasks t
      WHERE t.mission_id = p_mission_id
        AND t.state = 'ready' AND t.attempt < t.max_attempts
        AND (mission_token_budget IS NULL OR (t.estimated_tokens IS NOT NULL
          AND mission_tokens_used::numeric + t.estimated_tokens <= mission_token_budget))
        AND (mission_cost_budget IS NULL OR (t.estimated_cost_micros IS NOT NULL
          AND mission_cost_used::numeric + t.estimated_cost_micros <= mission_cost_budget))
    ) INTO budget_blocked;

    IF budget_blocked THEN
      UPDATE purama_ai.chef_missions
      SET state = 'paused', updated_at = now()
      WHERE id = p_mission_id AND state = 'active';
      IF FOUND THEN
        INSERT INTO purama_ai.chef_events(mission_id, worker_id, kind, payload)
        VALUES (p_mission_id, p_worker_id, 'budget_blocked',
          jsonb_build_object('reason', 'estimate_missing_or_budget_exhausted',
            'tokens_used', mission_tokens_used, 'cost_used_micros', mission_cost_used));
      END IF;
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
  WHERE worker_id = p_worker_id AND session_id = p_session_id;

  INSERT INTO purama_ai.chef_events(mission_id, task_id, worker_id, kind, payload)
  SELECT mission_id, id, p_worker_id, 'task_claimed',
    jsonb_build_object('provider', p_provider, 'fencing_token', fencing_token, 'attempt', attempt, 'session_id', p_session_id)
  FROM purama_ai.chef_tasks WHERE id = selected_id;

  RETURN QUERY SELECT * FROM purama_ai.chef_tasks WHERE id = selected_id;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.chef_claim_next_task(uuid,text,text,text,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_claim_next_task(uuid,text,text,text,integer)
  TO service_role;

COMMIT;
