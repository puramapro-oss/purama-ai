-- PURAMA CHEF: evidence belongs to one live claim, never to a later retry.
-- Nullable columns preserve historical rows; the trigger refuses new unstamped rows.
BEGIN;

ALTER TABLE purama_ai.chef_evidence
  ADD COLUMN IF NOT EXISTS attempt integer CHECK (attempt > 0),
  ADD COLUMN IF NOT EXISTS fencing_token bigint CHECK (fencing_token > 0),
  ADD COLUMN IF NOT EXISTS worker_id text CHECK (length(btrim(worker_id)) > 0);

CREATE INDEX IF NOT EXISTS idx_chef_evidence_generation
  ON purama_ai.chef_evidence(task_id, attempt, fencing_token);

CREATE OR REPLACE FUNCTION purama_ai.chef_guard_evidence_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  task_row purama_ai.chef_tasks%ROWTYPE;
BEGIN
  -- Serialize against claim, lease renewal, retry and completion on this task.
  SELECT * INTO task_row FROM purama_ai.chef_tasks WHERE id = NEW.task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'PCE01', MESSAGE = 'Evidence task no longer exists';
  END IF;
  IF NEW.attempt IS NULL OR NEW.fencing_token IS NULL OR NEW.worker_id IS NULL
     OR length(btrim(NEW.worker_id)) = 0
     OR task_row.attempt <> NEW.attempt
     OR task_row.fencing_token <> NEW.fencing_token
     OR task_row.lease_owner IS DISTINCT FROM NEW.worker_id
     OR task_row.state NOT IN ('running','verifying')
     OR task_row.lease_expires_at IS NULL
     OR task_row.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = 'PCE01', MESSAGE = 'Evidence claim is stale or inactive';
  END IF;
  -- Never stamp missing metadata from task_row: that would relabel a stale proof.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chef_evidence_claim ON purama_ai.chef_evidence;
CREATE TRIGGER trg_chef_evidence_claim
BEFORE INSERT ON purama_ai.chef_evidence
FOR EACH ROW EXECUTE FUNCTION purama_ai.chef_guard_evidence_claim();

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
  task_row purama_ai.chef_tasks%ROWTYPE;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'Invalid lease';
  END IF;
  -- Read the actual clock AFTER acquiring the row lock, not before a lock wait.
  SELECT * INTO task_row FROM purama_ai.chef_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) = 0
     OR task_row.lease_owner IS DISTINCT FROM p_worker_id
     OR task_row.fencing_token IS DISTINCT FROM p_fencing_token
     OR task_row.lease_expires_at IS NULL
     OR task_row.lease_expires_at <= clock_timestamp()
     OR task_row.state NOT IN ('claimed','running','verifying') THEN
    RETURN false;
  END IF;
  UPDATE purama_ai.chef_tasks
  SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = clock_timestamp()
  WHERE id = p_task_id;
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
  strong_evidence_count integer;
BEGIN
  SELECT * INTO task_row FROM purama_ai.chef_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) = 0
     OR task_row.lease_owner IS DISTINCT FROM p_worker_id
     OR task_row.fencing_token IS DISTINCT FROM p_fencing_token THEN RETURN false; END IF;
  IF task_row.lease_expires_at IS NULL OR task_row.lease_expires_at <= clock_timestamp() THEN RETURN false; END IF;

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
      AND kind IN ('test','build','typecheck','lint','security','review','receipt','runtime')
      AND payload -> 'ok' = 'true'::jsonb
      AND attempt = task_row.attempt
      AND fencing_token = task_row.fencing_token
      AND worker_id = p_worker_id;

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
      (
        NOT r.critical
        AND NOT EXISTS (
          SELECT 1
          FROM purama_ai.chef_task_requirements tr
          JOIN purama_ai.chef_tasks t ON t.id = tr.task_id AND t.state = 'verified_done'
          JOIN purama_ai.chef_evidence e ON e.task_id = t.id
            AND e.requirement_id = r.id
            AND e.attempt = t.attempt
            AND e.fencing_token = t.fencing_token
            AND length(btrim(e.worker_id)) > 0
            AND e.kind IN ('test','build','typecheck','lint','security','review','receipt','runtime')
            AND e.payload -> 'ok' = 'true'::jsonb
            AND e.payload -> 'scopeVersion' = '1'::jsonb
            AND jsonb_typeof(e.payload -> 'requirementKeys') = 'array'
            AND (e.payload -> 'requirementKeys') ? r.requirement_key
          WHERE tr.requirement_id = r.id
        )
      )
      OR (
        r.critical
        AND NOT EXISTS (
          SELECT 1
          FROM purama_ai.chef_task_requirements proof_link
          JOIN purama_ai.chef_tasks proof_task
            ON proof_task.id = proof_link.task_id
           AND proof_task.state = 'verified_done'
          JOIN purama_ai.chef_evidence proof
            ON proof.task_id = proof_task.id
           AND proof.requirement_id = r.id
           AND proof.attempt = proof_task.attempt
           AND proof.fencing_token = proof_task.fencing_token
           AND length(btrim(proof.worker_id)) > 0
           AND proof.kind IN ('test','build','typecheck','lint','security','receipt','runtime')
           AND proof.payload -> 'ok' = 'true'::jsonb
           AND proof.payload -> 'scopeVersion' = '1'::jsonb
           AND jsonb_typeof(proof.payload -> 'requirementKeys') = 'array'
           AND (proof.payload -> 'requirementKeys') ? r.requirement_key
          JOIN purama_ai.chef_task_requirements review_link
            ON review_link.requirement_id = r.id
          JOIN purama_ai.chef_tasks review_task
            ON review_task.id = review_link.task_id
           AND review_task.state = 'verified_done'
           AND review_task.id <> proof_task.id
          JOIN purama_ai.chef_evidence review
            ON review.task_id = review_task.id
           AND review.requirement_id = r.id
           AND review.attempt = review_task.attempt
           AND review.fencing_token = review_task.fencing_token
           AND length(btrim(review.worker_id)) > 0
           AND review.kind = 'review'
           AND review.payload -> 'ok' = 'true'::jsonb
           AND review.payload -> 'scopeVersion' = '1'::jsonb
           AND jsonb_typeof(review.payload -> 'requirementKeys') = 'array'
           AND (review.payload -> 'requirementKeys') ? r.requirement_key
          WHERE proof_link.requirement_id = r.id
        )
      )
    )
  ORDER BY r.requirement_key;
$$;

REVOKE ALL ON FUNCTION purama_ai.chef_guard_evidence_claim()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_guard_evidence_claim() TO service_role;
REVOKE ALL ON FUNCTION purama_ai.chef_renew_task_lease(uuid,text,bigint,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_renew_task_lease(uuid,text,bigint,integer)
  TO service_role;
REVOKE ALL ON FUNCTION purama_ai.chef_transition_task(uuid,text,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_transition_task(uuid,text,bigint,text,text,text)
  TO service_role;
REVOKE ALL ON FUNCTION purama_ai.chef_missing_requirements(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_missing_requirements(uuid)
  TO service_role;

COMMIT;
