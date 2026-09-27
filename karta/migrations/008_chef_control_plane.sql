-- PURAMA CHEF control plane: durable missions, DAG tasks, workers, leases and evidence.
-- Server-only. Future IAO surfaces must go through an authenticated API, never direct table writes.
BEGIN;

CREATE TABLE IF NOT EXISTS purama_ai.chef_missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brief_id text NOT NULL,
  brief_version integer NOT NULL DEFAULT 1 CHECK (brief_version > 0),
  brief_hash text NOT NULL CHECK (length(brief_hash) = 64),
  goal text NOT NULL,
  repo text NOT NULL,
  state text NOT NULL DEFAULT 'planning'
    CHECK (state IN ('planning','active','paused','human_required','external_required','verified_done','failed','cancelled')),
  max_parallel integer NOT NULL DEFAULT 4 CHECK (max_parallel BETWEEN 1 AND 64),
  token_budget bigint CHECK (token_budget IS NULL OR token_budget >= 0),
  cost_budget_micros bigint CHECK (cost_budget_micros IS NULL OR cost_budget_micros >= 0),
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  cost_used_micros bigint NOT NULL DEFAULT 0 CHECK (cost_used_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE(user_id, brief_id, brief_version)
);

CREATE TABLE IF NOT EXISTS purama_ai.chef_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES purama_ai.chef_missions(id) ON DELETE CASCADE,
  requirement_key text NOT NULL,
  description text NOT NULL,
  critical boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(mission_id, requirement_key)
);

CREATE TABLE IF NOT EXISTS purama_ai.chef_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES purama_ai.chef_missions(id) ON DELETE CASCADE,
  task_key text NOT NULL,
  title text NOT NULL,
  instructions text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','ready','claimed','running','verifying','retryable','blocked_human','blocked_external','verified_done','failed','cancelled')),
  required boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  provider text NOT NULL DEFAULT 'auto'
    CHECK (provider IN ('auto','codex','claude','glm')),
  assigned_provider text CHECK (assigned_provider IS NULL OR assigned_provider IN ('codex','claude','glm')),
  model text,
  worktree text,
  branch text,
  base_sha text,
  brief_hash text NOT NULL CHECK (length(brief_hash) = 64),
  input_fingerprint text,
  output_sha text,
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  cost_used_micros bigint NOT NULL DEFAULT 0 CHECK (cost_used_micros >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE(mission_id, task_key)
);

CREATE TABLE IF NOT EXISTS purama_ai.chef_task_dependencies (
  task_id uuid NOT NULL REFERENCES purama_ai.chef_tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES purama_ai.chef_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS purama_ai.chef_task_requirements (
  task_id uuid NOT NULL REFERENCES purama_ai.chef_tasks(id) ON DELETE CASCADE,
  requirement_id uuid NOT NULL REFERENCES purama_ai.chef_requirements(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, requirement_id)
);

CREATE TABLE IF NOT EXISTS purama_ai.chef_workers (
  worker_id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('codex','claude','glm')),
  model text,
  state text NOT NULL DEFAULT 'idle'
    CHECK (state IN ('offline','idle','claimed','running','verifying','blocked','failed')),
  session_id text,
  pid integer,
  repo text,
  worktree text,
  branch text,
  current_task_id uuid REFERENCES purama_ai.chef_tasks(id) ON DELETE SET NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.chef_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES purama_ai.chef_tasks(id) ON DELETE CASCADE,
  requirement_id uuid REFERENCES purama_ai.chef_requirements(id) ON DELETE CASCADE,
  kind text NOT NULL
    CHECK (kind IN ('diff','test','build','typecheck','lint','security','review','receipt','runtime','benchmark','other')),
  sha256 text CHECK (sha256 IS NULL OR length(sha256) = 64),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.chef_events (
  id bigserial PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES purama_ai.chef_missions(id) ON DELETE CASCADE,
  task_id uuid REFERENCES purama_ai.chef_tasks(id) ON DELETE CASCADE,
  worker_id text,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chef_tasks_mission_state
  ON purama_ai.chef_tasks(mission_id, state, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_chef_tasks_lease
  ON purama_ai.chef_tasks(lease_expires_at) WHERE lease_owner IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chef_workers_heartbeat
  ON purama_ai.chef_workers(heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_chef_evidence_task
  ON purama_ai.chef_evidence(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chef_events_mission
  ON purama_ai.chef_events(mission_id, created_at);

ALTER TABLE purama_ai.chef_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.chef_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.chef_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.chef_task_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.chef_task_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.chef_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.chef_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.chef_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON purama_ai.chef_missions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purama_ai.chef_requirements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purama_ai.chef_tasks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purama_ai.chef_task_dependencies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purama_ai.chef_task_requirements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purama_ai.chef_workers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purama_ai.chef_evidence FROM PUBLIC, anon, authenticated;
REVOKE ALL ON purama_ai.chef_events FROM PUBLIC, anon, authenticated;

GRANT ALL ON purama_ai.chef_missions TO service_role;
GRANT ALL ON purama_ai.chef_requirements TO service_role;
GRANT ALL ON purama_ai.chef_tasks TO service_role;
GRANT ALL ON purama_ai.chef_task_dependencies TO service_role;
GRANT ALL ON purama_ai.chef_task_requirements TO service_role;
GRANT ALL ON purama_ai.chef_workers TO service_role;
GRANT ALL ON purama_ai.chef_evidence TO service_role;
GRANT ALL ON purama_ai.chef_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE purama_ai.chef_events_id_seq TO service_role;

CREATE OR REPLACE FUNCTION purama_ai.chef_reject_dependency_cycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  task_mission uuid;
  dependency_mission uuid;
  cycle_found boolean;
BEGIN
  SELECT mission_id INTO task_mission FROM purama_ai.chef_tasks WHERE id = NEW.task_id;
  SELECT mission_id INTO dependency_mission FROM purama_ai.chef_tasks WHERE id = NEW.depends_on_task_id;
  IF task_mission IS NULL OR dependency_mission IS NULL OR task_mission <> dependency_mission THEN
    RAISE EXCEPTION 'Dependency must stay inside one mission';
  END IF;

  WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.depends_on_task_id
    UNION
    SELECT d.depends_on_task_id
    FROM purama_ai.chef_task_dependencies d
    JOIN ancestors a ON d.task_id = a.id
  )
  SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = NEW.task_id) INTO cycle_found;

  IF cycle_found THEN
    RAISE EXCEPTION 'Dependency cycle rejected';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chef_dependency_cycle ON purama_ai.chef_task_dependencies;
CREATE TRIGGER trg_chef_dependency_cycle
BEFORE INSERT OR UPDATE ON purama_ai.chef_task_dependencies
FOR EACH ROW EXECUTE FUNCTION purama_ai.chef_reject_dependency_cycle();

CREATE OR REPLACE FUNCTION purama_ai.chef_refresh_ready_tasks(p_mission_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  changed integer;
BEGIN
  UPDATE purama_ai.chef_tasks t
  SET state = 'ready', updated_at = now()
  WHERE t.mission_id = p_mission_id
    AND t.state IN ('pending','retryable')
    AND t.attempt < t.max_attempts
    AND NOT EXISTS (
      SELECT 1
      FROM purama_ai.chef_task_dependencies d
      JOIN purama_ai.chef_tasks dependency ON dependency.id = d.depends_on_task_id
      WHERE d.task_id = t.id AND dependency.state <> 'verified_done'
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.chef_heartbeat_worker(
  p_worker_id text,
  p_provider text,
  p_model text,
  p_state text,
  p_session_id text,
  p_pid integer,
  p_repo text,
  p_worktree text,
  p_branch text,
  p_capabilities jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_provider NOT IN ('codex','claude','glm') THEN RAISE EXCEPTION 'Invalid provider'; END IF;
  IF p_state NOT IN ('offline','idle','claimed','running','verifying','blocked','failed') THEN RAISE EXCEPTION 'Invalid worker state'; END IF;
  INSERT INTO purama_ai.chef_workers(
    worker_id, provider, model, state, session_id, pid, repo, worktree, branch, capabilities, heartbeat_at, updated_at
  ) VALUES (
    p_worker_id, p_provider, p_model, p_state, p_session_id, p_pid, p_repo, p_worktree, p_branch,
    COALESCE(p_capabilities, '{}'::jsonb), now(), now()
  )
  ON CONFLICT(worker_id) DO UPDATE SET
    provider = EXCLUDED.provider,
    model = EXCLUDED.model,
    state = EXCLUDED.state,
    session_id = EXCLUDED.session_id,
    pid = EXCLUDED.pid,
    repo = EXCLUDED.repo,
    worktree = EXCLUDED.worktree,
    branch = EXCLUDED.branch,
    capabilities = EXCLUDED.capabilities,
    heartbeat_at = now(),
    updated_at = now();
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
BEGIN
  IF p_provider NOT IN ('codex','claude','glm') THEN RAISE EXCEPTION 'Invalid provider'; END IF;
  IF p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'Invalid lease'; END IF;

  PERFORM purama_ai.chef_refresh_ready_tasks(p_mission_id);

  SELECT max_parallel INTO parallel_limit
  FROM purama_ai.chef_missions
  WHERE id = p_mission_id AND state = 'active'
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
  ORDER BY t.priority DESC, t.created_at, t.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF selected_id IS NULL THEN RETURN; END IF;

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

CREATE OR REPLACE FUNCTION purama_ai.chef_renew_task_lease(
  p_task_id uuid,
  p_worker_id text,
  p_fencing_token bigint,
  p_lease_seconds integer DEFAULT 300
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  changed integer;
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'Invalid lease'; END IF;
  UPDATE purama_ai.chef_tasks
  SET lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  WHERE id = p_task_id
    AND lease_owner = p_worker_id
    AND fencing_token = p_fencing_token
    AND lease_expires_at > now()
    AND state IN ('claimed','running','verifying');
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
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

  IF final_state = 'verified_done' THEN
    PERFORM purama_ai.chef_refresh_ready_tasks(task_row.mission_id);
  END IF;
  RETURN true;
END;
$$;

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

  IF p_mission_id IS NOT NULL THEN PERFORM purama_ai.chef_refresh_ready_tasks(p_mission_id); END IF;
  RETURN changed;
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
    AND NOT EXISTS (
      SELECT 1
      FROM purama_ai.chef_task_requirements tr
      JOIN purama_ai.chef_tasks t ON t.id = tr.task_id AND t.state = 'verified_done'
      JOIN purama_ai.chef_evidence e ON e.task_id = t.id
        AND (e.requirement_id = r.id OR e.requirement_id IS NULL)
      WHERE tr.requirement_id = r.id
    )
  ORDER BY r.requirement_key;
$$;

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
  WHERE id = p_mission_id AND state IN ('active','human_required','external_required');

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.chef_refresh_ready_tasks(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_heartbeat_worker(text,text,text,text,text,integer,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_claim_next_task(uuid,text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_renew_task_lease(uuid,text,bigint,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_transition_task(uuid,text,bigint,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_requeue_expired_tasks(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_missing_requirements(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_try_finish_mission(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION purama_ai.chef_refresh_ready_tasks(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_heartbeat_worker(text,text,text,text,text,integer,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_claim_next_task(uuid,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_renew_task_lease(uuid,text,bigint,integer) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_transition_task(uuid,text,bigint,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_requeue_expired_tasks(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_missing_requirements(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_try_finish_mission(uuid) TO service_role;

COMMIT;
