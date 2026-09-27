-- PURAMA CHEF hardening II: worker generations, strict evidence, resource serialization and recovery.
BEGIN;

ALTER TABLE purama_ai.chef_workers
  ADD COLUMN IF NOT EXISTS report_sequence bigint NOT NULL DEFAULT 0 CHECK (report_sequence >= 0);

UPDATE purama_ai.chef_workers
SET session_id = COALESCE(NULLIF(session_id, ''), 'legacy-' || worker_id)
WHERE session_id IS NULL OR session_id = '';

ALTER TABLE purama_ai.chef_workers
  ALTER COLUMN session_id SET NOT NULL;

ALTER TABLE purama_ai.chef_evidence
  DROP CONSTRAINT IF EXISTS chef_evidence_sha256_hex;
ALTER TABLE purama_ai.chef_evidence
  ADD CONSTRAINT chef_evidence_sha256_hex
  CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');

-- A moving worktree/scope is serialized for ALL tasks. Parallel readers stay possible
-- by using distinct immutable worktrees/snapshots, never by reading while another worker writes.
DROP INDEX IF EXISTS purama_ai.chef_one_writer_per_worktree;
DROP INDEX IF EXISTS purama_ai.chef_one_writer_per_scope;

CREATE UNIQUE INDEX IF NOT EXISTS chef_one_active_per_worktree
  ON purama_ai.chef_tasks(worktree)
  WHERE worktree IS NOT NULL
    AND state IN ('claimed','running','verifying');

CREATE UNIQUE INDEX IF NOT EXISTS chef_one_active_per_scope
  ON purama_ai.chef_tasks(scope_key)
  WHERE scope_key IS NOT NULL
    AND state IN ('claimed','running','verifying');

-- Evidence and event history are append-only for the engine role.
REVOKE UPDATE, DELETE, TRUNCATE ON purama_ai.chef_evidence FROM service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON purama_ai.chef_events FROM service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON purama_ai.chef_usage_events FROM service_role;
GRANT SELECT, INSERT ON purama_ai.chef_evidence TO service_role;
GRANT SELECT, INSERT ON purama_ai.chef_events TO service_role;
GRANT SELECT, INSERT ON purama_ai.chef_usage_events TO service_role;

-- Replace the legacy heartbeat with a session-fenced, monotonic report stream.
DROP FUNCTION IF EXISTS purama_ai.chef_heartbeat_worker(text,text,text,text,text,integer,text,text,text,jsonb);

CREATE OR REPLACE FUNCTION purama_ai.chef_heartbeat_worker(
  p_worker_id text,
  p_provider text,
  p_model text,
  p_state text,
  p_session_id text,
  p_sequence bigint,
  p_pid integer,
  p_repo text,
  p_worktree text,
  p_branch text,
  p_capabilities jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  current_row purama_ai.chef_workers%ROWTYPE;
  replacing_session boolean := false;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id !~ '^[A-Za-z0-9._:-]{1,200}$' THEN
    RAISE EXCEPTION 'Invalid worker id';
  END IF;
  IF p_provider NOT IN ('codex','claude','glm') THEN RAISE EXCEPTION 'Invalid provider'; END IF;
  IF p_state NOT IN ('offline','idle','claimed','running','verifying','blocked','failed') THEN
    RAISE EXCEPTION 'Invalid worker state';
  END IF;
  IF p_session_id IS NULL OR length(p_session_id) < 8 OR length(p_session_id) > 256 THEN
    RAISE EXCEPTION 'Invalid worker session';
  END IF;
  IF p_sequence IS NULL OR p_sequence < 1 THEN RAISE EXCEPTION 'Invalid worker sequence'; END IF;

  SELECT * INTO current_row
  FROM purama_ai.chef_workers
  WHERE worker_id = p_worker_id
  FOR UPDATE;

  IF NOT FOUND THEN
    IF p_state IN ('claimed','running','verifying') THEN
      RAISE EXCEPTION 'New worker cannot start active';
    END IF;
    INSERT INTO purama_ai.chef_workers(
      worker_id, provider, model, state, session_id, report_sequence, pid,
      repo, worktree, branch, capabilities, heartbeat_at, updated_at
    ) VALUES (
      p_worker_id, p_provider, p_model, p_state, p_session_id, p_sequence, p_pid,
      p_repo, p_worktree, p_branch, COALESCE(p_capabilities,'{}'::jsonb), now(), now()
    );
    RETURN true;
  END IF;

  replacing_session := current_row.session_id <> p_session_id;
  IF replacing_session THEN
    IF current_row.current_task_id IS NOT NULL
       OR current_row.state NOT IN ('offline','idle','failed')
       OR current_row.heartbeat_at >= now() - interval '2 minutes' THEN
      RAISE EXCEPTION 'Worker session conflict';
    END IF;
  ELSE
    IF p_sequence <= current_row.report_sequence THEN
      RETURN false;
    END IF;
  END IF;

  IF NOT replacing_session AND current_row.provider <> p_provider THEN
    RAISE EXCEPTION 'Worker provider cannot change inside a session';
  END IF;

  IF current_row.current_task_id IS NOT NULL THEN
    IF p_state NOT IN ('claimed','running','verifying') THEN
      RAISE EXCEPTION 'Worker with active task cannot report inactive state';
    END IF;
    IF p_repo IS DISTINCT FROM current_row.repo
       OR p_worktree IS DISTINCT FROM current_row.worktree
       OR p_branch IS DISTINCT FROM current_row.branch THEN
      RAISE EXCEPTION 'Worker location cannot change while task is active';
    END IF;
  ELSIF p_state IN ('claimed','running','verifying') THEN
    RAISE EXCEPTION 'Worker cannot report active without a claimed task';
  END IF;

  UPDATE purama_ai.chef_workers
  SET
    provider = p_provider,
    model = p_model,
    state = p_state,
    session_id = p_session_id,
    report_sequence = p_sequence,
    pid = p_pid,
    repo = p_repo,
    worktree = p_worktree,
    branch = p_branch,
    capabilities = COALESCE(p_capabilities,'{}'::jsonb),
    heartbeat_at = now(),
    updated_at = now(),
    last_error = CASE WHEN p_state IN ('idle','claimed','running','verifying') THEN NULL ELSE last_error END
  WHERE worker_id = p_worker_id;

  RETURN true;
END;
$$;

-- Replace claim RPC: the current worker session, repository and exact worktree must match.
DROP FUNCTION IF EXISTS purama_ai.chef_claim_next_task(uuid,text,text,integer);

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
BEGIN
  IF p_provider NOT IN ('codex','claude','glm') THEN RAISE EXCEPTION 'Invalid provider'; END IF;
  IF p_session_id IS NULL OR length(p_session_id) < 8 OR length(p_session_id) > 256 THEN
    RAISE EXCEPTION 'Invalid worker session';
  END IF;
  IF p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'Invalid lease'; END IF;

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
    AND (t.worktree IS NULL OR t.worktree = worker_worktree)
    AND (
      mission_token_budget IS NULL
      OR mission_tokens_used + COALESCE(t.estimated_tokens, 0) <= mission_token_budget
    )
    AND (
      mission_cost_budget IS NULL
      OR mission_cost_used + COALESCE(t.estimated_cost_micros, 0) <= mission_cost_budget
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
  WHERE worker_id = p_worker_id AND session_id = p_session_id;

  INSERT INTO purama_ai.chef_events(mission_id, task_id, worker_id, kind, payload)
  SELECT mission_id, id, p_worker_id, 'task_claimed',
    jsonb_build_object('provider', p_provider, 'fencing_token', fencing_token, 'attempt', attempt, 'session_id', p_session_id)
  FROM purama_ai.chef_tasks WHERE id = selected_id;

  RETURN QUERY SELECT * FROM purama_ai.chef_tasks WHERE id = selected_id;
END;
$$;

-- Blocking on a person/provider is not a failed coding attempt. Return that attempt
-- to the budget so max_attempts=1 can still resume after the external block clears.
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
  SET
    state = 'pending',
    attempt = GREATEST(attempt - 1, 0),
    last_error = p_reason,
    updated_at = now()
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

-- Expired final attempts must make a required mission fail instead of leaving it active forever.
CREATE OR REPLACE FUNCTION purama_ai.chef_requeue_expired_tasks(p_mission_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  changed integer;
BEGIN
  WITH expired AS (
    SELECT id, mission_id, attempt, max_attempts
    FROM purama_ai.chef_tasks
    WHERE state IN ('claimed','running','verifying')
      AND lease_expires_at <= now()
      AND (p_mission_id IS NULL OR mission_id = p_mission_id)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE purama_ai.chef_tasks t
  SET
    state = CASE WHEN e.attempt >= e.max_attempts THEN 'failed' ELSE 'retryable' END,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error = 'Lease expirée : worker perdu ou non réactif',
    finished_at = CASE WHEN e.attempt >= e.max_attempts THEN now() ELSE NULL END,
    updated_at = now()
  FROM expired e
  WHERE t.id = e.id;

  GET DIAGNOSTICS changed = ROW_COUNT;

  UPDATE purama_ai.chef_workers w
  SET state = 'offline', current_task_id = NULL, updated_at = now(),
      last_error = 'Lease de tâche expirée'
  WHERE w.current_task_id IN (
    SELECT id FROM purama_ai.chef_tasks
    WHERE lease_owner IS NULL AND last_error = 'Lease expirée : worker perdu ou non réactif'
  );

  UPDATE purama_ai.chef_missions m
  SET state = 'failed', finished_at = now(), updated_at = now()
  WHERE m.state <> 'cancelled'
    AND (p_mission_id IS NULL OR m.id = p_mission_id)
    AND EXISTS (
      SELECT 1 FROM purama_ai.chef_tasks t
      WHERE t.mission_id = m.id AND t.required AND t.state = 'failed'
    );

  IF p_mission_id IS NOT NULL THEN PERFORM purama_ai.chef_refresh_ready_tasks(p_mission_id); END IF;
  RETURN changed;
END;
$$;

-- A task cannot be certified by a diff alone. Independent review is enforced at
-- mission/requirement level so an implementation task can finish before its review task runs.
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
  strong_evidence_count integer;
BEGIN
  SELECT * INTO task_row FROM purama_ai.chef_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF task_row.lease_owner IS DISTINCT FROM p_worker_id OR task_row.fencing_token <> p_fencing_token THEN RETURN false; END IF;
  IF task_row.lease_expires_at IS NULL OR task_row.lease_expires_at <= now() THEN RETURN false; END IF;

  final_state := p_target_state;
  IF p_target_state = 'running' AND task_row.state <> 'claimed' THEN RETURN false; END IF;
  IF p_target_state = 'verifying' AND task_row.state <> 'running' THEN RETURN false; END IF;
  IF p_target_state = 'verified_done' AND task_row.state <> 'verifying' THEN RETURN false; END IF;
  IF p_target_state IN ('retryable','blocked_human','blocked_external','failed')
     AND task_row.state NOT IN ('claimed','running','verifying') THEN RETURN false; END IF;
  IF p_target_state NOT IN ('running','verifying','verified_done','retryable','blocked_human','blocked_external','failed') THEN RETURN false; END IF;

  IF p_target_state = 'verified_done' THEN
    SELECT count(*) INTO strong_evidence_count
    FROM purama_ai.chef_evidence
    WHERE task_id = p_task_id
      AND kind IN ('test','build','typecheck','lint','security','review','receipt','runtime');

    IF strong_evidence_count = 0 THEN
      RAISE EXCEPTION 'Verified task requires strong evidence';
    END IF;

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
    UPDATE purama_ai.chef_missions SET state = 'human_required', updated_at = now()
    WHERE id = task_row.mission_id AND state = 'active';
  ELSIF final_state = 'blocked_external' THEN
    UPDATE purama_ai.chef_missions SET state = 'external_required', updated_at = now()
    WHERE id = task_row.mission_id AND state = 'active';
  ELSIF final_state = 'failed' AND task_row.required THEN
    UPDATE purama_ai.chef_missions SET state = 'failed', finished_at = now(), updated_at = now()
    WHERE id = task_row.mission_id AND state <> 'cancelled';
  ELSIF final_state = 'verified_done' THEN
    PERFORM purama_ai.chef_refresh_ready_tasks(task_row.mission_id);
    PERFORM purama_ai.chef_try_finish_mission(task_row.mission_id);
  END IF;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.chef_missing_requirements(p_mission_id uuid)
RETURNS TABLE(requirement_id uuid, requirement_key text, description text, critical boolean)
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT r.id, r.requirement_key, r.description, r.critical
  FROM purama_ai.chef_requirements r
  WHERE r.mission_id = p_mission_id
    AND (
      -- Every requirement needs at least one direct, reproducible proof or review
      -- from a task that itself reached VERIFIED_DONE.
      NOT EXISTS (
        SELECT 1
        FROM purama_ai.chef_task_requirements tr
        JOIN purama_ai.chef_tasks t ON t.id = tr.task_id AND t.state = 'verified_done'
        JOIN purama_ai.chef_evidence e ON e.task_id = t.id
          AND e.requirement_id = r.id
          AND e.kind IN ('test','build','typecheck','lint','security','review','receipt','runtime')
        WHERE tr.requirement_id = r.id
      )
      OR (
        r.critical
        AND (
          -- Critical requirements need concrete non-review proof...
          NOT EXISTS (
            SELECT 1
            FROM purama_ai.chef_task_requirements tr
            JOIN purama_ai.chef_tasks t ON t.id = tr.task_id AND t.state = 'verified_done'
            JOIN purama_ai.chef_evidence e ON e.task_id = t.id
              AND e.requirement_id = r.id
              AND e.kind IN ('test','build','typecheck','lint','security','receipt','runtime')
            WHERE tr.requirement_id = r.id
          )
          -- ...and an independent review, which may deliberately be a later task.
          OR NOT EXISTS (
            SELECT 1
            FROM purama_ai.chef_task_requirements tr
            JOIN purama_ai.chef_tasks t ON t.id = tr.task_id AND t.state = 'verified_done'
            JOIN purama_ai.chef_evidence e ON e.task_id = t.id
              AND e.requirement_id = r.id
              AND e.kind = 'review'
            WHERE tr.requirement_id = r.id
          )
        )
      )
    )
  ORDER BY r.requirement_key;
$$;

REVOKE ALL ON FUNCTION purama_ai.chef_heartbeat_worker(text,text,text,text,text,bigint,integer,text,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_claim_next_task(uuid,text,text,text,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_unblock_task(uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_requeue_expired_tasks(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_transition_task(uuid,text,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_missing_requirements(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION purama_ai.chef_heartbeat_worker(text,text,text,text,text,bigint,integer,text,text,text,jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_claim_next_task(uuid,text,text,text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_unblock_task(uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_requeue_expired_tasks(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_transition_task(uuid,text,bigint,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_missing_requirements(uuid)
  TO service_role;

COMMIT;
