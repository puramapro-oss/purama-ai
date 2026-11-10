-- PURAMA CHEF: preserve an exclusion scope when process death cannot be proved.
-- This is an append-only incident journal, not an expiring lease. Normal task
-- unblocking, housekeeping, deletion, or retries cannot clear a quarantine.
BEGIN;

CREATE TABLE IF NOT EXISTS purama_ai.chef_process_quarantines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Deliberately independent snapshots: cascaded task/mission deletion must not
  -- erase protection. Foreign keys here would also acquire parent-row locks in
  -- the reverse order of admission (mission -> task -> advisory lock).
  task_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  worker_id text NOT NULL CHECK (length(btrim(worker_id)) > 0),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  attempt integer NOT NULL CHECK (attempt > 0),
  repo text,
  worktree text,
  scope_key text,
  global_scope boolean NOT NULL,
  historical_claim boolean NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 10000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(task_id, fencing_token)
);

CREATE INDEX IF NOT EXISTS idx_chef_process_quarantines_repo
  ON purama_ai.chef_process_quarantines(repo);
ALTER TABLE purama_ai.chef_process_quarantines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.chef_process_quarantines FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON purama_ai.chef_process_quarantines TO service_role;

-- Lexically normalize server-registered POSIX paths; never use LIKE patterns
-- for scope comparisons. Physical symlink aliases still require canonical
-- worktree registration by the trusted runtime, as with existing scope locks.
CREATE OR REPLACE FUNCTION purama_ai.chef_quarantine_path(p_path text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  part text;
  parts text[] := ARRAY[]::text[];
BEGIN
  IF left(p_path, 1) <> '/' THEN RETURN NULL; END IF;
  FOREACH part IN ARRAY string_to_array(p_path, '/') LOOP
    IF part = '' OR part = '.' THEN CONTINUE; END IF;
    IF part = '..' THEN
      parts := parts[1:greatest(cardinality(parts) - 1, 0)];
    ELSE
      parts := array_append(parts, part);
    END IF;
  END LOOP;
  RETURN '/' || array_to_string(parts, '/');
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.chef_quarantine_process(
  p_task_id uuid,
  p_worker_id text,
  p_fencing_token bigint,
  p_attempt integer,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  task_row purama_ai.chef_tasks%ROWTYPE;
  snapshot_mission uuid;
  snapshot_repo text;
  snapshot_worktree text;
  snapshot_scope text;
  current_claim boolean;
  historical_claim boolean := false;
  broad_scope boolean;
BEGIN
  IF p_task_id IS NULL OR p_worker_id IS NULL OR length(btrim(p_worker_id)) = 0
     OR p_fencing_token IS NULL OR p_fencing_token <= 0
     OR p_attempt IS NULL OR p_attempt <= 0
     OR p_reason IS NULL OR length(btrim(p_reason)) = 0 OR length(p_reason) > 10000 THEN
    RAISE EXCEPTION 'Invalid process quarantine claim';
  END IF;

  -- Retrying a confirmed write remains safe even after task deletion/lease loss.
  IF EXISTS (
    SELECT 1 FROM purama_ai.chef_process_quarantines
    WHERE task_id = p_task_id AND fencing_token = p_fencing_token
      AND worker_id = p_worker_id AND attempt = p_attempt
  ) THEN RETURN true; END IF;

  SELECT * INTO task_row FROM purama_ai.chef_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Take this only AFTER the task row, like the admission trigger. Do not take
  -- worker/mission locks or insert FK-backed events after this advisory lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('purama_ai.chef.process_quarantine', 0));

  IF EXISTS (
    SELECT 1 FROM purama_ai.chef_process_quarantines
    WHERE task_id = p_task_id AND fencing_token = p_fencing_token
  ) THEN
    RETURN EXISTS (
      SELECT 1 FROM purama_ai.chef_process_quarantines
      WHERE task_id = p_task_id AND fencing_token = p_fencing_token
        AND worker_id = p_worker_id AND attempt = p_attempt
    );
  END IF;

  current_claim := task_row.lease_owner IS NOT DISTINCT FROM p_worker_id
    AND task_row.fencing_token = p_fencing_token AND task_row.attempt = p_attempt
    AND task_row.state IN ('claimed','running','verifying');
  snapshot_mission := task_row.mission_id;
  IF NOT current_claim THEN
    -- Expiry/reassignment must not let an old live process disappear from the
    -- safety ledger. Authenticate its exact generation from server-only history;
    -- never relabel it with the replacement worker's current fencing token.
    SELECT e.mission_id INTO snapshot_mission
    FROM purama_ai.chef_events e
    WHERE e.task_id = p_task_id AND e.worker_id = p_worker_id AND e.kind = 'task_claimed'
      AND e.payload->'fencing_token' = to_jsonb(p_fencing_token)
      AND e.payload->'attempt' = to_jsonb(p_attempt)
    ORDER BY e.id DESC LIMIT 1;
    IF NOT FOUND THEN RETURN false; END IF;
    historical_claim := true;
  END IF;

  SELECT NULLIF(btrim(repo), '') INTO snapshot_repo
  FROM purama_ai.chef_missions WHERE id = snapshot_mission;
  snapshot_scope := NULLIF(rtrim(btrim(task_row.scope_key), '/'), '');
  snapshot_worktree := purama_ai.chef_quarantine_path(task_row.worktree);
  IF snapshot_worktree IS NULL AND current_claim THEN
    SELECT purama_ai.chef_quarantine_path(worktree) INTO snapshot_worktree
    FROM purama_ai.chef_workers WHERE worker_id = p_worker_id;
  END IF;
  -- Unscoped jobs and historical generations cannot establish a narrow safe
  -- boundary. Freeze all admissions instead of guessing a current location.
  broad_scope := historical_claim OR snapshot_repo IS NULL OR snapshot_worktree IS NULL
    OR (purama_ai.chef_quarantine_path(task_row.worktree) IS NULL AND snapshot_scope IS NULL);

  INSERT INTO purama_ai.chef_process_quarantines(
    task_id, mission_id, worker_id, fencing_token, attempt, repo, worktree,
    scope_key, global_scope, historical_claim, reason
  ) VALUES (
    p_task_id, snapshot_mission, p_worker_id, p_fencing_token, p_attempt,
    snapshot_repo, snapshot_worktree, snapshot_scope, broad_scope, historical_claim, p_reason
  ) ON CONFLICT(task_id, fencing_token) DO NOTHING;

  RETURN EXISTS (
    SELECT 1 FROM purama_ai.chef_process_quarantines
    WHERE task_id = p_task_id AND fencing_token = p_fencing_token
      AND worker_id = p_worker_id AND attempt = p_attempt
  );
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.chef_guard_process_quarantine()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate_repo text;
  candidate_worktree text;
  candidate_scope text;
  candidate_worker text;
  quarantine_id uuid;
BEGIN
  IF NEW.state NOT IN ('claimed','running','verifying','verified_done') THEN RETURN NEW; END IF;
  -- Admissions/completions are readers. Shared locks avoid an inversion
  -- between a claim holding a mission and a completion holding its task.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('purama_ai.chef.process_quarantine', 0));

  SELECT NULLIF(btrim(repo), '') INTO candidate_repo
  FROM purama_ai.chef_missions WHERE id = NEW.mission_id;
  candidate_worktree := purama_ai.chef_quarantine_path(NEW.worktree);
  candidate_scope := NULLIF(rtrim(btrim(NEW.scope_key), '/'), '');
  candidate_worker := NEW.lease_owner;
  IF candidate_worker IS NULL AND TG_OP = 'UPDATE' THEN candidate_worker := OLD.lease_owner; END IF;
  IF candidate_worktree IS NULL AND candidate_worker IS NOT NULL THEN
    SELECT purama_ai.chef_quarantine_path(worktree) INTO candidate_worktree
    FROM purama_ai.chef_workers WHERE worker_id = candidate_worker;
  END IF;

  SELECT q.id INTO quarantine_id FROM purama_ai.chef_process_quarantines q
  WHERE q.global_scope
    OR candidate_repo IS NULL OR candidate_worktree IS NULL
    OR q.repo = candidate_repo
    OR (q.worktree IS NOT NULL AND (
      q.worktree = candidate_worktree OR q.worktree = '/' OR candidate_worktree = '/'
      OR left(candidate_worktree, length(q.worktree) + 1) = q.worktree || '/'
      OR left(q.worktree, length(candidate_worktree) + 1) = candidate_worktree || '/'
    ))
    OR (q.scope_key IS NOT NULL AND candidate_scope IS NOT NULL AND (
      q.scope_key = candidate_scope
      OR left(candidate_scope, length(q.scope_key) + 1) = q.scope_key || '/'
      OR left(q.scope_key, length(candidate_scope) + 1) = candidate_scope || '/'
    ))
  ORDER BY q.created_at, q.id LIMIT 1;
  IF quarantine_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'PCQ01',
      MESSAGE = 'CHEF admission blocked by persistent process quarantine',
      DETAIL = 'quarantine_id=' || quarantine_id::text,
      HINT = 'Confirm process containment before an operator reconciles this incident; lease expiry is not clearance.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chef_process_quarantine ON purama_ai.chef_tasks;
CREATE TRIGGER trg_chef_process_quarantine
BEFORE INSERT OR UPDATE OF state, mission_id, worktree, scope_key, lease_owner,
  fencing_token, attempt, lease_expires_at ON purama_ai.chef_tasks
FOR EACH ROW EXECUTE FUNCTION purama_ai.chef_guard_process_quarantine();

-- Optional tasks are ignored by the ordinary requirement-completion gate.
-- An unresolved process incident must nevertheless prevent a success label.
CREATE OR REPLACE FUNCTION purama_ai.chef_guard_quarantined_mission_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.state <> 'verified_done' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('purama_ai.chef.process_quarantine', 0));
  IF EXISTS (
    SELECT 1 FROM purama_ai.chef_process_quarantines q
    WHERE q.global_scope OR q.mission_id = NEW.id OR q.repo = NULLIF(btrim(NEW.repo), '')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'PCQ01',
      MESSAGE = 'CHEF mission completion blocked by persistent process quarantine';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chef_quarantined_mission_completion ON purama_ai.chef_missions;
CREATE TRIGGER trg_chef_quarantined_mission_completion
BEFORE INSERT OR UPDATE OF state, repo ON purama_ai.chef_missions
FOR EACH ROW EXECUTE FUNCTION purama_ai.chef_guard_quarantined_mission_completion();

-- Keep the existing RPC signature, but expiry no longer proves process death.
-- A bounded pass avoids taking additional worker/mission locks after obtaining
-- the advisory lock. Other expired rows remain active/excluded until a later
-- pass; none becomes retryable merely because its clock ran out.
CREATE OR REPLACE FUNCTION purama_ai.chef_requeue_expired_tasks(p_mission_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate purama_ai.chef_tasks%ROWTYPE;
  task_row purama_ai.chef_tasks%ROWTYPE;
  locked_worker text;
  reason text := 'Lease expirée sans confirmation d''arrêt; quarantaine persistante, intervention requise';
BEGIN
  SELECT * INTO candidate FROM purama_ai.chef_tasks
  WHERE state IN ('claimed','running','verifying')
    AND lease_expires_at <= clock_timestamp()
    AND (p_mission_id IS NULL OR mission_id = p_mission_id)
  ORDER BY lease_expires_at, id LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;

  -- Match admission's lock order, never waiting on a task held by a transition
  -- while holding its worker row. A busy candidate is safely left active.
  SELECT worker_id INTO locked_worker FROM purama_ai.chef_workers
  WHERE worker_id = candidate.lease_owner FOR UPDATE SKIP LOCKED;
  IF NOT FOUND AND EXISTS (
    SELECT 1 FROM purama_ai.chef_workers WHERE worker_id = candidate.lease_owner
  ) THEN RETURN 0; END IF;

  PERFORM 1 FROM purama_ai.chef_missions WHERE id = candidate.mission_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT * INTO task_row FROM purama_ai.chef_tasks
  WHERE id = candidate.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF task_row.mission_id <> candidate.mission_id
     OR task_row.lease_owner IS DISTINCT FROM candidate.lease_owner
     OR task_row.fencing_token <> candidate.fencing_token
     OR task_row.state NOT IN ('claimed','running','verifying')
     OR task_row.lease_expires_at IS NULL
     OR task_row.lease_expires_at > clock_timestamp() THEN RETURN 0; END IF;

  -- A completion may already hold a shared guard while waiting for this
  -- mission. Never wait in the reverse order: a busy candidate stays active.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('purama_ai.chef.process_quarantine', 0)) THEN
    RETURN 0;
  END IF;

  IF task_row.lease_owner IS NULL OR length(btrim(task_row.lease_owner)) = 0
     OR task_row.fencing_token <= 0 OR task_row.attempt <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'PCQ01',
      MESSAGE = 'Expired CHEF claim cannot be authenticated; active exclusion retained';
  END IF;
  IF NOT purama_ai.chef_quarantine_process(
    task_row.id, task_row.lease_owner, task_row.fencing_token, task_row.attempt, reason
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'PCQ01',
      MESSAGE = 'Expired CHEF process quarantine was refused; active exclusion retained';
  END IF;

  UPDATE purama_ai.chef_tasks
  SET state = 'blocked_external', lease_owner = NULL, lease_expires_at = NULL,
      last_error = reason, updated_at = clock_timestamp()
  WHERE id = task_row.id;
  UPDATE purama_ai.chef_workers
  SET state = 'blocked', current_task_id = NULL, last_error = reason, updated_at = clock_timestamp()
  WHERE worker_id = locked_worker AND current_task_id = task_row.id;
  UPDATE purama_ai.chef_missions
  SET state = 'external_required', updated_at = clock_timestamp()
  WHERE id = task_row.mission_id AND state IN ('active','human_required','external_required');
  RETURN 1;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.chef_quarantine_path(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_quarantine_process(uuid,text,bigint,integer,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_guard_process_quarantine() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_guard_quarantined_mission_completion() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.chef_requeue_expired_tasks(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_quarantine_path(text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_quarantine_process(uuid,text,bigint,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_guard_process_quarantine() TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_guard_quarantined_mission_completion() TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.chef_requeue_expired_tasks(uuid) TO service_role;

COMMIT;
