-- Reconciles PR21 attempt-bound reservations with PR27 admission and quarantine.
-- Applied AFTER 021/022/023; existing migration numbers and ingestion are unchanged.
-- Reservation/settlement source: b826af125ce296d3808d3b71b93fd084e63dbdb7.
-- Drain workers before this migration; deploy the claim-bound runtime with it.
-- CHEF admission envelopes belong to an exact worker attempt, not to a process lifetime.
-- Unknown usage is NULL. A reservation survives a crash, lease loss and task retry.
-- Estimates govern admission; they are not a guarantee of the provider's final invoice.
BEGIN;

DO $$
BEGIN
  IF to_regclass('purama_ai.chef_process_quarantines') IS NULL THEN
    RAISE EXCEPTION 'CHEF migration 024 requires process quarantine migration 023';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS purama_ai.chef_budget_reservations (
  task_id uuid NOT NULL REFERENCES purama_ai.chef_tasks(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  mission_id uuid NOT NULL REFERENCES purama_ai.chef_missions(id) ON DELETE CASCADE,
  worker_id text NOT NULL CHECK (length(btrim(worker_id)) > 0),
  provider text NOT NULL CHECK (provider IN ('codex','claude','glm')),
  reserved_tokens bigint CHECK (reserved_tokens >= 0),
  reserved_cost_micros bigint CHECK (reserved_cost_micros >= 0),
  require_tokens boolean NOT NULL,
  require_cost boolean NOT NULL,
  actual_input_tokens bigint CHECK (actual_input_tokens >= 0),
  actual_output_tokens bigint CHECK (actual_output_tokens >= 0),
  actual_cached_input_tokens bigint CHECK (actual_cached_input_tokens >= 0),
  actual_cost_micros bigint CHECK (actual_cost_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, attempt, fencing_token),
  UNIQUE (task_id, fencing_token),
  CHECK ((actual_input_tokens IS NULL) = (actual_output_tokens IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_chef_budget_open_mission
  ON purama_ai.chef_budget_reservations(mission_id)
  WHERE actual_input_tokens IS NULL OR actual_cost_micros IS NULL;

ALTER TABLE purama_ai.chef_budget_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.chef_budget_reservations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON purama_ai.chef_budget_reservations TO service_role;
GRANT UPDATE (actual_input_tokens, actual_output_tokens, actual_cached_input_tokens, actual_cost_micros, updated_at)
  ON purama_ai.chef_budget_reservations TO service_role;

ALTER TABLE purama_ai.chef_usage_events
  ADD COLUMN IF NOT EXISTS attempt integer CHECK (attempt > 0),
  ADD COLUMN IF NOT EXISTS fencing_token bigint CHECK (fencing_token > 0),
  ALTER COLUMN input_tokens DROP NOT NULL,
  ALTER COLUMN input_tokens DROP DEFAULT,
  ALTER COLUMN output_tokens DROP NOT NULL,
  ALTER COLUMN output_tokens DROP DEFAULT,
  ALTER COLUMN cached_input_tokens DROP NOT NULL,
  ALTER COLUMN cached_input_tokens DROP DEFAULT,
  ALTER COLUMN cost_micros DROP NOT NULL,
  ALTER COLUMN cost_micros DROP DEFAULT;

-- An old zero may hide a missing cost. If the same claim already has a positive
-- receipt too, importing it as unknown would lose the already charged subtotal
-- and a later final receipt could charge it twice. Reject this historical
-- ambiguity transactionally instead of inventing a balance or rewriting events.
-- New claim-bound receipts are excluded so valid partial settlement is replayable.
DO $$
DECLARE
  ambiguous_task uuid;
BEGIN
  SELECT t.id INTO ambiguous_task
  FROM purama_ai.chef_tasks t
  JOIN purama_ai.chef_usage_events u
    ON u.task_id = t.id AND u.mission_id = t.mission_id
    AND u.worker_id = t.lease_owner
    AND u.event_key LIKE 'chef-usage|' || t.id || '|' || t.attempt || '|' || t.fencing_token || '|%'
    AND u.attempt IS NULL AND u.fencing_token IS NULL
  WHERE t.state IN ('claimed','running','verifying')
    AND t.attempt > 0 AND t.fencing_token > 0 AND t.lease_owner IS NOT NULL
  GROUP BY t.id
  HAVING count(*) > 1
    AND bool_or(u.cost_micros > 0)
    AND bool_or(u.cost_micros IS NULL OR u.cost_micros = 0)
  ORDER BY t.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'CHEF migration 024: multiple historical receipts mix known and unknown cost for task %', ambiguous_task
      USING HINT = 'Review the legacy claim and its already charged cost before retrying migration 024.';
  END IF;
END;
$$;

-- Preserve already active claims. Only receipts carrying the old, exact
-- task/attempt/fence key are recognized as already charged; absent receipts stay unknown.
INSERT INTO purama_ai.chef_budget_reservations (
  task_id, attempt, fencing_token, mission_id, worker_id, provider,
  reserved_tokens, reserved_cost_micros, require_tokens, require_cost,
  actual_input_tokens, actual_output_tokens, actual_cached_input_tokens, actual_cost_micros
)
SELECT t.id, t.attempt, t.fencing_token, t.mission_id, t.lease_owner,
       COALESCE(t.assigned_provider, w.provider),
       t.estimated_tokens, t.estimated_cost_micros,
       m.token_budget IS NOT NULL, m.cost_budget_micros IS NOT NULL,
       old_usage.input_tokens, old_usage.output_tokens, old_usage.cached_input_tokens, old_usage.cost_micros
FROM purama_ai.chef_tasks t
JOIN purama_ai.chef_missions m ON m.id = t.mission_id
LEFT JOIN purama_ai.chef_workers w ON w.worker_id = t.lease_owner
LEFT JOIN LATERAL (
  SELECT sum(u.input_tokens)::bigint AS input_tokens,
         sum(u.output_tokens)::bigint AS output_tokens,
         NULLIF(sum(u.cached_input_tokens), 0)::bigint AS cached_input_tokens,
         -- The old supervisor fabricated zero when the cost was omitted.
         -- Without provenance a historical zero cannot settle a cost envelope.
         CASE WHEN count(*) = 0 OR bool_or(u.cost_micros IS NULL OR u.cost_micros = 0)
           THEN NULL ELSE sum(u.cost_micros)::bigint END AS cost_micros
  FROM purama_ai.chef_usage_events u
  WHERE u.task_id = t.id AND u.mission_id = t.mission_id
    AND u.worker_id = t.lease_owner
    AND u.event_key LIKE 'chef-usage|' || t.id || '|' || t.attempt || '|' || t.fencing_token || '|%'
) old_usage ON true
WHERE t.state IN ('claimed','running','verifying')
  AND t.attempt > 0 AND t.fencing_token > 0 AND t.lease_owner IS NOT NULL
ON CONFLICT (task_id, attempt, fencing_token) DO NOTHING;

-- Do not guess the missing ledger of a previous/finished attempt. Active
-- claims above can be imported from their exact current identity. Older capped
-- history without a reservation needs an operator to reconcile its already
-- charged totals first; this guard rolls the migration back, without rewriting
-- usage or treating unobserved consumption as free capacity.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM purama_ai.chef_missions m
    WHERE (m.token_budget IS NOT NULL OR m.cost_budget_micros IS NOT NULL)
      AND (
        EXISTS (
          SELECT 1 FROM purama_ai.chef_tasks t
          WHERE t.mission_id = m.id AND t.attempt > 0
            AND NOT EXISTS (
              SELECT 1 FROM purama_ai.chef_budget_reservations r
              WHERE r.task_id = t.id AND r.fencing_token = t.fencing_token
                AND (t.state NOT IN ('claimed','running','verifying') OR r.attempt = t.attempt)
            )
        )
        OR EXISTS (
          SELECT 1 FROM purama_ai.chef_events e
          WHERE e.mission_id = m.id AND e.kind = 'task_claimed'
            AND NOT EXISTS (
              SELECT 1 FROM purama_ai.chef_budget_reservations r
              WHERE r.task_id = e.task_id AND r.worker_id = e.worker_id
                AND r.attempt::text = e.payload->>'attempt'
                AND r.fencing_token::text = e.payload->>'fencing_token'
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'CHEF migration 024: historical capped claims require explicit budget reconciliation'
      USING HINT = 'Review historical claim identities and already charged totals; do not reset counters or synthesize zero usage.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.chef_guard_budget_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(NEW.task_id, NEW.attempt, NEW.fencing_token, NEW.mission_id, NEW.worker_id,
         NEW.provider, NEW.reserved_tokens, NEW.reserved_cost_micros,
         NEW.require_tokens, NEW.require_cost, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.task_id, OLD.attempt, OLD.fencing_token, OLD.mission_id, OLD.worker_id,
         OLD.provider, OLD.reserved_tokens, OLD.reserved_cost_micros,
         OLD.require_tokens, OLD.require_cost, OLD.created_at) THEN
    RAISE EXCEPTION 'Budget reservation identity and envelope are immutable';
  END IF;
  IF (OLD.actual_input_tokens IS NOT NULL AND NEW.actual_input_tokens IS DISTINCT FROM OLD.actual_input_tokens)
     OR (OLD.actual_output_tokens IS NOT NULL AND NEW.actual_output_tokens IS DISTINCT FROM OLD.actual_output_tokens)
     OR (OLD.actual_cached_input_tokens IS NOT NULL AND NEW.actual_cached_input_tokens IS DISTINCT FROM OLD.actual_cached_input_tokens)
     OR (OLD.actual_cost_micros IS NOT NULL AND NEW.actual_cost_micros IS DISTINCT FROM OLD.actual_cost_micros) THEN
    RAISE EXCEPTION 'Settled usage cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chef_budget_reservation_immutable ON purama_ai.chef_budget_reservations;
CREATE TRIGGER trg_chef_budget_reservation_immutable
BEFORE UPDATE ON purama_ai.chef_budget_reservations
FOR EACH ROW EXECUTE FUNCTION purama_ai.chef_guard_budget_reservation();

-- The evidence checks in migration 017 still apply. This separate guard also
-- protects a direct state update from declaring capped, unaccounted work complete.
CREATE OR REPLACE FUNCTION purama_ai.chef_guard_budget_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  reservation purama_ai.chef_budget_reservations%ROWTYPE;
  token_limited boolean;
  cost_limited boolean;
BEGIN
  IF NEW.state <> 'verified_done' THEN RETURN NEW; END IF;
  SELECT token_budget IS NOT NULL, cost_budget_micros IS NOT NULL
    INTO token_limited, cost_limited
  FROM purama_ai.chef_missions WHERE id = NEW.mission_id;
  SELECT * INTO reservation FROM purama_ai.chef_budget_reservations
  WHERE task_id = NEW.id AND attempt = NEW.attempt AND fencing_token = NEW.fencing_token;
  IF NOT FOUND THEN
    IF token_limited OR cost_limited THEN
      RAISE EXCEPTION 'Capped task requires claim-bound usage reconciliation';
    END IF;
    RETURN NEW;
  END IF;
  IF ((token_limited OR reservation.require_tokens) AND reservation.actual_input_tokens IS NULL)
     OR ((cost_limited OR reservation.require_cost) AND reservation.actual_cost_micros IS NULL) THEN
    RAISE EXCEPTION 'Capped task usage is unknown; reservation must be reconciled';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chef_budget_completion ON purama_ai.chef_tasks;
CREATE TRIGGER trg_chef_budget_completion
BEFORE UPDATE OF state ON purama_ai.chef_tasks
FOR EACH ROW EXECUTE FUNCTION purama_ai.chef_guard_budget_completion();

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
  selected_task purama_ai.chef_tasks%ROWTYPE;
  mission purama_ai.chef_missions%ROWTYPE;
  worker purama_ai.chef_workers%ROWTYPE;
  active_count integer;
  reserved_token_total numeric;
  reserved_cost_total numeric;
  budget_blocked boolean;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('codex','claude','glm') THEN RAISE EXCEPTION 'Invalid provider'; END IF;
  IF p_session_id IS NULL OR length(p_session_id) < 8 OR length(p_session_id) > 256 THEN
    RAISE EXCEPTION 'Invalid worker session';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'Invalid lease'; END IF;

  SELECT * INTO worker FROM purama_ai.chef_workers WHERE worker_id = p_worker_id FOR UPDATE;
  IF NOT FOUND OR worker.provider <> p_provider OR worker.session_id <> p_session_id
     OR worker.state <> 'idle' OR worker.current_task_id IS NOT NULL
     OR worker.heartbeat_at < clock_timestamp() - interval '2 minutes' THEN RETURN; END IF;

  PERFORM purama_ai.chef_refresh_ready_tasks(p_mission_id);
  -- Serializes every reservation and settlement in this mission. SKIP LOCKED
  -- below avoids waiting on a task whose receipt/transition already owns its row.
  SELECT * INTO mission FROM purama_ai.chef_missions
  WHERE id = p_mission_id AND state IN ('active','human_required','external_required') FOR UPDATE;
  IF NOT FOUND OR worker.repo IS DISTINCT FROM mission.repo THEN RETURN; END IF;

  -- Preserve PR27's conservative treatment of legacy/directly-created active
  -- tasks. No missing reservation or historical generation is free capacity.
  IF (mission.token_budget IS NOT NULL OR mission.cost_budget_micros IS NOT NULL)
     AND (
       EXISTS (
         SELECT 1 FROM purama_ai.chef_tasks t
         WHERE t.mission_id = p_mission_id
           AND (t.state IN ('claimed','running','verifying') OR t.attempt > 0)
           AND NOT EXISTS (
             SELECT 1 FROM purama_ai.chef_budget_reservations r
             WHERE r.task_id = t.id AND r.fencing_token = t.fencing_token
                AND (t.state NOT IN ('claimed','running','verifying') OR r.attempt = t.attempt)
           )
       )
       OR EXISTS (
         SELECT 1 FROM purama_ai.chef_events e
         WHERE e.mission_id = p_mission_id AND e.kind = 'task_claimed'
           AND NOT EXISTS (
             SELECT 1 FROM purama_ai.chef_budget_reservations r
             WHERE r.task_id = e.task_id AND r.worker_id = e.worker_id
               AND r.attempt::text = e.payload->>'attempt'
               AND r.fencing_token::text = e.payload->>'fencing_token'
           )
       )
     ) THEN RETURN; END IF;

  -- A failed/expired attempt is not proof of zero provider usage. Its held
  -- reservation cannot silently disappear when housekeeping makes the task ready.
  IF EXISTS (
    SELECT 1
    FROM purama_ai.chef_budget_reservations r
    JOIN purama_ai.chef_tasks t ON t.id = r.task_id
    WHERE r.mission_id = p_mission_id
      AND (
        ((mission.token_budget IS NOT NULL OR r.require_tokens) AND r.actual_input_tokens IS NULL)
        OR ((mission.cost_budget_micros IS NOT NULL OR r.require_cost) AND r.actual_cost_micros IS NULL)
      )
      AND (
        t.attempt <> r.attempt OR t.fencing_token <> r.fencing_token
        OR t.lease_owner IS DISTINCT FROM r.worker_id
        OR t.state NOT IN ('claimed','running','verifying')
        OR t.lease_expires_at IS NULL OR t.lease_expires_at <= clock_timestamp()
        OR (mission.token_budget IS NOT NULL AND r.actual_input_tokens IS NULL AND r.reserved_tokens IS NULL)
        OR (mission.cost_budget_micros IS NOT NULL AND r.actual_cost_micros IS NULL AND r.reserved_cost_micros IS NULL)
      )
  ) THEN RETURN; END IF;

  SELECT count(*) INTO active_count FROM purama_ai.chef_tasks
  WHERE mission_id = p_mission_id AND state IN ('claimed','running','verifying');
  IF active_count >= mission.max_parallel THEN RETURN; END IF;
  SELECT COALESCE(sum(reserved_tokens) FILTER (WHERE actual_input_tokens IS NULL), 0),
         COALESCE(sum(reserved_cost_micros) FILTER (WHERE actual_cost_micros IS NULL), 0)
    INTO reserved_token_total, reserved_cost_total
  FROM purama_ai.chef_budget_reservations WHERE mission_id = p_mission_id;

  SELECT t.* INTO selected_task
  FROM purama_ai.chef_tasks t
  WHERE t.mission_id = p_mission_id AND t.state = 'ready' AND t.attempt < t.max_attempts
    AND (t.provider = 'auto' OR t.provider = p_provider)
    AND (t.worktree IS NULL OR t.worktree = worker.worktree)
    AND (mission.token_budget IS NULL OR (
      t.estimated_tokens IS NOT NULL
      AND mission.tokens_used::numeric + reserved_token_total + t.estimated_tokens <= mission.token_budget
    ))
    AND (mission.cost_budget_micros IS NULL OR (
      t.estimated_cost_micros IS NOT NULL
      AND mission.cost_used_micros::numeric + reserved_cost_total + t.estimated_cost_micros <= mission.cost_budget_micros
    ))
    AND (t.worktree IS NULL OR NOT EXISTS (
      SELECT 1 FROM purama_ai.chef_tasks busy WHERE busy.id <> t.id AND busy.worktree = t.worktree
        AND busy.state IN ('claimed','running','verifying')
    ))
    AND (t.scope_key IS NULL OR NOT EXISTS (
      SELECT 1 FROM purama_ai.chef_tasks busy WHERE busy.id <> t.id AND busy.scope_key = t.scope_key
        AND busy.state IN ('claimed','running','verifying')
    ))
  ORDER BY t.priority DESC, t.created_at, t.id
  FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN
    -- Preserve PR27's budget-blocked diagnostic, without treating outstanding
    -- claim receipts as exhausted budget or pausing work for another provider.
    IF active_count > 0 THEN RETURN; END IF;
    SELECT EXISTS (
      SELECT 1 FROM purama_ai.chef_tasks t
      WHERE t.mission_id = p_mission_id AND t.state = 'ready' AND t.attempt < t.max_attempts
        AND (t.provider = 'auto' OR t.provider = p_provider)
        AND (t.worktree IS NULL OR t.worktree = worker.worktree)
        AND (
          (mission.token_budget IS NOT NULL AND (t.estimated_tokens IS NULL
            OR mission.tokens_used::numeric + t.estimated_tokens > mission.token_budget))
          OR (mission.cost_budget_micros IS NOT NULL AND (t.estimated_cost_micros IS NULL
            OR mission.cost_used_micros::numeric + t.estimated_cost_micros > mission.cost_budget_micros))
        )
    ) AND NOT EXISTS (
      SELECT 1 FROM purama_ai.chef_tasks t
      WHERE t.mission_id = p_mission_id AND t.state = 'ready' AND t.attempt < t.max_attempts
        AND (mission.token_budget IS NULL OR (t.estimated_tokens IS NOT NULL
          AND mission.tokens_used::numeric + t.estimated_tokens <= mission.token_budget))
        AND (mission.cost_budget_micros IS NULL OR (t.estimated_cost_micros IS NOT NULL
          AND mission.cost_used_micros::numeric + t.estimated_cost_micros <= mission.cost_budget_micros))
    ) INTO budget_blocked;
    IF budget_blocked THEN
      UPDATE purama_ai.chef_missions SET state = 'paused', updated_at = now()
      WHERE id = p_mission_id AND state = 'active';
      IF FOUND THEN
        INSERT INTO purama_ai.chef_events(mission_id, worker_id, kind, payload)
        VALUES (p_mission_id, p_worker_id, 'budget_blocked',
          jsonb_build_object('reason', 'estimate_missing_or_budget_exhausted',
            'tokens_used', mission.tokens_used, 'cost_used_micros', mission.cost_used_micros));
      END IF;
    END IF;
    RETURN;
  END IF;

  BEGIN
    UPDATE purama_ai.chef_tasks
    SET state = 'claimed', assigned_provider = p_provider, lease_owner = p_worker_id,
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
        fencing_token = fencing_token + 1, attempt = attempt + 1,
        started_at = COALESCE(started_at, now()), updated_at = now(), last_error = NULL
    WHERE id = selected_task.id RETURNING * INTO selected_task;
    INSERT INTO purama_ai.chef_budget_reservations (
      task_id, attempt, fencing_token, mission_id, worker_id, provider,
      reserved_tokens, reserved_cost_micros, require_tokens, require_cost
    ) VALUES (
      selected_task.id, selected_task.attempt, selected_task.fencing_token,
      p_mission_id, p_worker_id, p_provider,
      selected_task.estimated_tokens, selected_task.estimated_cost_micros,
      mission.token_budget IS NOT NULL, mission.cost_budget_micros IS NOT NULL
    );
  EXCEPTION WHEN unique_violation THEN RETURN;
  END;

  UPDATE purama_ai.chef_workers
  SET state = 'claimed', current_task_id = selected_task.id, heartbeat_at = now(), updated_at = now()
  WHERE worker_id = p_worker_id AND session_id = p_session_id;
  INSERT INTO purama_ai.chef_events(mission_id, task_id, worker_id, kind, payload)
  VALUES (p_mission_id, selected_task.id, p_worker_id, 'task_claimed', jsonb_build_object(
    'provider', p_provider, 'fencing_token', selected_task.fencing_token,
    'attempt', selected_task.attempt, 'session_id', p_session_id,
    'reserved_tokens', selected_task.estimated_tokens,
    'reserved_cost_micros', selected_task.estimated_cost_micros
  ));
  RETURN NEXT selected_task;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.chef_record_claim_usage(
  p_event_key text,
  p_mission_id uuid,
  p_task_id uuid,
  p_worker_id text,
  p_provider text,
  p_model text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cached_input_tokens bigint,
  p_cost_micros bigint,
  p_attempt integer,
  p_fencing_token bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  reservation purama_ai.chef_budget_reservations%ROWTYPE;
  mission purama_ai.chef_missions%ROWTYPE;
  previous purama_ai.chef_usage_events%ROWTYPE;
  task_mission uuid;
  inserted_id bigint;
  delta_tokens bigint := 0;
  delta_cost bigint := 0;
  pending_tokens numeric;
  pending_cost numeric;
BEGIN
  IF p_event_key IS NULL OR length(p_event_key) < 8 OR length(p_event_key) > 256 THEN RAISE EXCEPTION 'Invalid usage event key'; END IF;
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) = 0
     OR p_attempt IS NULL OR p_attempt < 1 OR p_fencing_token IS NULL OR p_fencing_token < 1 THEN
    RAISE EXCEPTION 'Usage requires an exact claim';
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('codex','claude','glm') THEN RAISE EXCEPTION 'Invalid provider'; END IF;
  IF p_model IS NOT NULL AND length(p_model) > 200 THEN RAISE EXCEPTION 'Invalid usage model'; END IF;
  IF (p_input_tokens IS NULL) <> (p_output_tokens IS NULL) THEN RAISE EXCEPTION 'Both token totals must be known together'; END IF;
  IF p_input_tokens < 0 OR p_output_tokens < 0 OR p_cached_input_tokens < 0 OR p_cost_micros < 0 THEN RAISE EXCEPTION 'Negative usage'; END IF;
  IF p_input_tokens::numeric + p_output_tokens > 9007199254740991
     OR p_cached_input_tokens > 9007199254740991 OR p_cost_micros > 9007199254740991 THEN RAISE EXCEPTION 'Usage exceeds safe integer range'; END IF;

  -- Same task-first ordering as transitions; a late receipt needs no live lease.
  SELECT mission_id INTO task_mission FROM purama_ai.chef_tasks WHERE id = p_task_id FOR UPDATE;
  IF task_mission IS DISTINCT FROM p_mission_id OR task_mission IS NULL THEN RAISE EXCEPTION 'Task is not part of mission'; END IF;
  SELECT * INTO mission FROM purama_ai.chef_missions WHERE id = p_mission_id FOR UPDATE;
  SELECT * INTO reservation FROM purama_ai.chef_budget_reservations
  WHERE task_id = p_task_id AND attempt = p_attempt AND fencing_token = p_fencing_token FOR UPDATE;
  IF NOT FOUND OR reservation.mission_id <> p_mission_id
     OR reservation.worker_id <> p_worker_id OR reservation.provider <> p_provider THEN
    RAISE EXCEPTION 'Usage claim does not match its reservation';
  END IF;

  IF (p_input_tokens IS NOT NULL AND reservation.actual_input_tokens IS NOT NULL
       AND ROW(p_input_tokens, p_output_tokens) IS DISTINCT FROM ROW(reservation.actual_input_tokens, reservation.actual_output_tokens))
     OR (p_cached_input_tokens IS NOT NULL AND reservation.actual_cached_input_tokens IS NOT NULL
       AND p_cached_input_tokens <> reservation.actual_cached_input_tokens)
     OR (p_cost_micros IS NOT NULL AND reservation.actual_cost_micros IS NOT NULL
       AND p_cost_micros <> reservation.actual_cost_micros) THEN
    RAISE EXCEPTION 'Conflicting final usage for this claim';
  END IF;

  INSERT INTO purama_ai.chef_usage_events (
    event_key, mission_id, task_id, worker_id, provider, model,
    input_tokens, output_tokens, cached_input_tokens, cost_micros, attempt, fencing_token
  ) VALUES (
    p_event_key, p_mission_id, p_task_id, p_worker_id, p_provider, p_model,
    p_input_tokens, p_output_tokens, p_cached_input_tokens, p_cost_micros, p_attempt, p_fencing_token
  ) ON CONFLICT (event_key) DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN
    SELECT * INTO previous FROM purama_ai.chef_usage_events WHERE event_key = p_event_key;
    IF ROW(previous.mission_id, previous.task_id, previous.worker_id, previous.provider, previous.model,
           previous.input_tokens, previous.output_tokens, previous.cached_input_tokens, previous.cost_micros,
           previous.attempt, previous.fencing_token)
       IS DISTINCT FROM
       ROW(p_mission_id, p_task_id, p_worker_id, p_provider, p_model,
           p_input_tokens, p_output_tokens, p_cached_input_tokens, p_cost_micros, p_attempt, p_fencing_token) THEN
      RAISE EXCEPTION 'Usage event key reused with different receipt';
    END IF;
  END IF;

  -- Each dimension is a final total for the attempt. Later reports may fill an
  -- unknown dimension, but may neither amend a settled total nor charge it twice.
  IF reservation.actual_input_tokens IS NULL AND p_input_tokens IS NOT NULL THEN
    delta_tokens := p_input_tokens + p_output_tokens;
  END IF;
  IF reservation.actual_cost_micros IS NULL AND p_cost_micros IS NOT NULL THEN delta_cost := p_cost_micros; END IF;
  UPDATE purama_ai.chef_budget_reservations
  SET actual_input_tokens = COALESCE(actual_input_tokens, p_input_tokens),
      actual_output_tokens = COALESCE(actual_output_tokens, p_output_tokens),
      actual_cached_input_tokens = COALESCE(actual_cached_input_tokens, p_cached_input_tokens),
      actual_cost_micros = COALESCE(actual_cost_micros, p_cost_micros), updated_at = now()
  WHERE task_id = p_task_id AND attempt = p_attempt AND fencing_token = p_fencing_token
  RETURNING * INTO reservation;
  IF delta_tokens <> 0 OR delta_cost <> 0 THEN
    UPDATE purama_ai.chef_tasks SET tokens_used = tokens_used + delta_tokens,
      cost_used_micros = cost_used_micros + delta_cost, updated_at = now() WHERE id = p_task_id;
    UPDATE purama_ai.chef_missions SET tokens_used = tokens_used + delta_tokens,
      cost_used_micros = cost_used_micros + delta_cost, updated_at = now()
    WHERE id = p_mission_id RETURNING * INTO mission;
  END IF;

  SELECT COALESCE(sum(reserved_tokens) FILTER (WHERE actual_input_tokens IS NULL), 0),
         COALESCE(sum(reserved_cost_micros) FILTER (WHERE actual_cost_micros IS NULL), 0)
    INTO pending_tokens, pending_cost
  FROM purama_ai.chef_budget_reservations WHERE mission_id = p_mission_id;
  IF (mission.token_budget IS NOT NULL AND mission.tokens_used::numeric + pending_tokens > mission.token_budget)
     OR (mission.cost_budget_micros IS NOT NULL AND mission.cost_used_micros::numeric + pending_cost > mission.cost_budget_micros) THEN
    UPDATE purama_ai.chef_missions SET state = 'paused', updated_at = now()
    WHERE id = p_mission_id AND state IN ('active','human_required','external_required');
    IF FOUND THEN
      INSERT INTO purama_ai.chef_events(mission_id, task_id, worker_id, kind, payload)
      VALUES (p_mission_id, p_task_id, p_worker_id, 'budget_exhausted', jsonb_build_object('event_key', p_event_key));
    END IF;
  END IF;

  RETURN (NOT (reservation.require_tokens OR mission.token_budget IS NOT NULL) OR reservation.actual_input_tokens IS NOT NULL)
     AND (NOT (reservation.require_cost OR mission.cost_budget_micros IS NOT NULL) OR reservation.actual_cost_micros IS NOT NULL);
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
  -- Kept only for historical, unlimited, unreserved work. New claims must use
  -- the worker/attempt/fence-bound RPC, including on unlimited missions.
  IF p_input_tokens IS NULL OR p_output_tokens IS NULL OR p_cached_input_tokens IS NULL OR p_cost_micros IS NULL THEN
    RAISE EXCEPTION 'Legacy usage requires known totals';
  END IF;
  PERFORM 1 FROM purama_ai.chef_missions WHERE id = p_mission_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM purama_ai.chef_missions WHERE id = p_mission_id
             AND (token_budget IS NOT NULL OR cost_budget_micros IS NOT NULL))
     OR EXISTS (SELECT 1 FROM purama_ai.chef_budget_reservations WHERE mission_id = p_mission_id) THEN
    RAISE EXCEPTION 'Claim-bound usage reconciliation required';
  END IF;
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

REVOKE ALL ON FUNCTION purama_ai.chef_guard_budget_reservation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_guard_budget_reservation() TO service_role;
REVOKE ALL ON FUNCTION purama_ai.chef_guard_budget_completion() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_guard_budget_completion() TO service_role;
REVOKE ALL ON FUNCTION purama_ai.chef_claim_next_task(uuid,text,text,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_claim_next_task(uuid,text,text,text,integer) TO service_role;
REVOKE ALL ON FUNCTION purama_ai.chef_record_claim_usage(text,uuid,uuid,text,text,text,bigint,bigint,bigint,bigint,integer,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_record_claim_usage(text,uuid,uuid,text,text,text,bigint,bigint,bigint,bigint,integer,bigint)
  TO service_role;
REVOKE ALL ON FUNCTION purama_ai.chef_record_usage(text,uuid,uuid,text,text,text,bigint,bigint,bigint,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_record_usage(text,uuid,uuid,text,text,text,bigint,bigint,bigint,bigint)
  TO service_role;

COMMIT;
