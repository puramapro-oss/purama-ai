-- Durable, private receipts for one-shot agent briefs. Apply before the worker.
-- This is input preservation, not a second scheduler: karta_runs remains the
-- execution owner and BullMQ remains the delivery queue. No provider is called.
BEGIN;

CREATE TABLE IF NOT EXISTS purama_ai.karta_brief_claims (
  run_id uuid PRIMARY KEY REFERENCES purama_ai.karta_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_type text NOT NULL CHECK (btrim(agent_type) <> ''),
  memory_key text NOT NULL CHECK (btrim(memory_key) <> ''),
  brief_id uuid NOT NULL,
  payload text NOT NULL CHECK (
    btrim(payload, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
  ),
  state text NOT NULL DEFAULT 'claimed' CHECK (state IN (
    'claimed', 'effect_started', 'ready', 'transferred', 'awaiting_approval',
    'completed', 'reconciliation_required'
  )),
  -- Conservative server limit: a live claim, including a later mock decision,
  -- consumes one attempt. Read-only simulation previews consume none.
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 3),
  previous_run_id uuid REFERENCES purama_ai.karta_runs(id) ON DELETE SET NULL,
  transferred_to_run_id uuid REFERENCES purama_ai.karta_runs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  CHECK (previous_run_id IS DISTINCT FROM run_id),
  CHECK (transferred_to_run_id IS DISTINCT FROM run_id),
  CHECK ((state = 'transferred') = (transferred_to_run_id IS NOT NULL)),
  CHECK (state <> 'ready' OR (ready_at IS NOT NULL AND attempt_count < 3))
);

-- A transferred receipt is history; at most one current owner may retain the
-- same brief identity, including when its external effects are uncertain.
CREATE UNIQUE INDEX IF NOT EXISTS karta_brief_one_current_claim
  ON purama_ai.karta_brief_claims(brief_id) WHERE state <> 'transferred';
CREATE INDEX IF NOT EXISTS karta_brief_ready_order
  ON purama_ai.karta_brief_claims(user_id, agent_type, memory_key, ready_at, run_id)
  WHERE state = 'ready';

ALTER TABLE purama_ai.karta_brief_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.karta_brief_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON purama_ai.karta_brief_claims TO service_role;

CREATE OR REPLACE FUNCTION purama_ai.karta_claim_pending_brief(
  p_user_id uuid, p_agent_type text, p_run_id uuid, p_key text DEFAULT 'pending_brief'
)
RETURNS TABLE(brief_id uuid, brief text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_claim purama_ai.karta_brief_claims%ROWTYPE;
  v_memory purama_ai.karta_agent_memory%ROWTYPE;
  v_space constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF p_user_id IS NULL OR p_run_id IS NULL OR p_agent_type IS NULL OR
      btrim(p_agent_type) = '' OR p_key IS NULL OR btrim(p_key) = '' THEN
    RAISE EXCEPTION 'Brief claim unavailable';
  END IF;
  -- Every mutating operation locks its parent run before its receipt. A close
  -- and an arm cannot pass each other and authorize a terminal run to act.
  PERFORM 1 FROM purama_ai.karta_runs r
    WHERE r.id = p_run_id AND r.user_id = p_user_id AND r.agent_type = p_agent_type
      AND r.status = 'running' AND r.duration_ms IS NULL AND r.mode = 'live'
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Brief claim unavailable'; END IF;

  SELECT * INTO v_claim FROM purama_ai.karta_brief_claims c
    WHERE c.run_id = p_run_id FOR UPDATE;
  IF FOUND THEN
    IF v_claim.user_id <> p_user_id OR v_claim.agent_type <> p_agent_type OR
        v_claim.memory_key <> p_key OR v_claim.state <> 'claimed' THEN
      RAISE EXCEPTION 'Brief claim unavailable';
    END IF;
    -- The first response may have been lost after COMMIT. Return the same
    -- immutable input, never extract the next submission for the same run.
    RETURN QUERY SELECT v_claim.brief_id, v_claim.payload;
    RETURN;
  END IF;

  SELECT * INTO v_claim FROM purama_ai.karta_brief_claims c
    WHERE c.user_id = p_user_id AND c.agent_type = p_agent_type
      AND c.memory_key = p_key AND c.state = 'ready'
    ORDER BY c.ready_at, c.run_id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    UPDATE purama_ai.karta_brief_claims
      SET state = 'transferred', transferred_to_run_id = p_run_id, updated_at = now()
      WHERE run_id = v_claim.run_id;
    INSERT INTO purama_ai.karta_brief_claims
      (run_id, user_id, agent_type, memory_key, brief_id, payload, previous_run_id, attempt_count)
      VALUES (p_run_id, p_user_id, p_agent_type, p_key, v_claim.brief_id, v_claim.payload, v_claim.run_id, v_claim.attempt_count + 1);
    RETURN QUERY SELECT v_claim.brief_id, v_claim.payload;
    RETURN;
  END IF;

  SELECT * INTO v_memory FROM purama_ai.karta_agent_memory m
    WHERE m.user_id = p_user_id AND m.agent_type = p_agent_type AND m.memory_key = p_key
      AND jsonb_typeof(m.memory_value) = 'string'
      AND btrim(m.memory_value #>> '{}', v_space) <> ''
    ORDER BY m.updated_at, m.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO purama_ai.karta_brief_claims
    (run_id, user_id, agent_type, memory_key, brief_id, payload)
    VALUES (p_run_id, p_user_id, p_agent_type, p_key, v_memory.id, v_memory.memory_value #>> '{}');
  DELETE FROM purama_ai.karta_agent_memory WHERE id = v_memory.id;
  RETURN QUERY SELECT v_memory.id, v_memory.memory_value #>> '{}';
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.karta_peek_pending_brief(
  p_user_id uuid, p_agent_type text, p_run_id uuid, p_key text DEFAULT 'pending_brief'
)
RETURNS TABLE(brief_id uuid, brief text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_claim purama_ai.karta_brief_claims%ROWTYPE;
  v_space constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF p_user_id IS NULL OR p_run_id IS NULL OR p_agent_type IS NULL OR
      btrim(p_agent_type) = '' OR p_key IS NULL OR btrim(p_key) = '' THEN
    RAISE EXCEPTION 'Brief preview unavailable';
  END IF;
  PERFORM 1 FROM purama_ai.karta_runs r
    WHERE r.id = p_run_id AND r.user_id = p_user_id AND r.agent_type = p_agent_type
      AND r.status = 'running' AND r.duration_ms IS NULL AND r.mode = 'simulation';
  IF NOT FOUND THEN RAISE EXCEPTION 'Brief preview unavailable'; END IF;

  SELECT * INTO v_claim FROM purama_ai.karta_brief_claims c
    WHERE c.user_id = p_user_id AND c.agent_type = p_agent_type
      AND c.memory_key = p_key AND c.state = 'ready'
    ORDER BY c.ready_at, c.run_id LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_claim.brief_id, v_claim.payload;
    RETURN;
  END IF;
  -- No row lock, claim, deletion or snapshot is created by a simulation.
  RETURN QUERY SELECT m.id, m.memory_value #>> '{}'
    FROM purama_ai.karta_agent_memory m
    WHERE m.user_id = p_user_id AND m.agent_type = p_agent_type AND m.memory_key = p_key
      AND jsonb_typeof(m.memory_value) = 'string'
      AND btrim(m.memory_value #>> '{}', v_space) <> ''
    ORDER BY m.updated_at, m.id LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.karta_arm_pending_brief(
  p_user_id uuid, p_agent_type text, p_run_id uuid
)
RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_claim purama_ai.karta_brief_claims%ROWTYPE;
BEGIN
  PERFORM 1 FROM purama_ai.karta_runs r
    WHERE r.id = p_run_id AND r.user_id = p_user_id AND r.agent_type = p_agent_type
      AND r.status = 'running' AND r.duration_ms IS NULL AND r.mode = 'live'
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Brief action unavailable'; END IF;
  SELECT * INTO v_claim FROM purama_ai.karta_brief_claims c
    WHERE c.run_id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_claim.user_id <> p_user_id OR v_claim.agent_type <> p_agent_type OR
      v_claim.state NOT IN ('claimed', 'effect_started') THEN
    RAISE EXCEPTION 'Brief action unavailable';
  END IF;
  IF v_claim.state = 'claimed' THEN
    UPDATE purama_ai.karta_brief_claims SET state = 'effect_started', updated_at = now()
      WHERE run_id = p_run_id;
  END IF;
  -- Idempotent confirmation only: the caller has not dispatched an effect yet.
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.karta_settle_brief_after_run()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_claim purama_ai.karta_brief_claims%ROWTYPE;
  v_valid_trace boolean := false;
  v_recorded_effect boolean := false;
  v_pending_trace boolean := false;
  v_all_executed boolean := false;
  v_has_approval boolean;
  v_open_approval boolean;
  v_unexecuted_approval boolean;
  v_next_state text := 'reconciliation_required';
BEGIN
  SELECT * INTO v_claim FROM purama_ai.karta_brief_claims c
    WHERE c.run_id = NEW.id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.user_id <> v_claim.user_id OR NEW.agent_type <> v_claim.agent_type THEN
    RAISE EXCEPTION 'Brief parent mismatch';
  END IF;
  -- Initial finalization sets duration_ms. Approval resolution can temporarily
  -- return an already closed run to running; that is not a new claim or close.
  IF NEW.duration_ms IS NULL OR NEW.status = 'running' THEN RETURN NEW; END IF;
  IF v_claim.state NOT IN ('claimed', 'effect_started', 'awaiting_approval') THEN RETURN NEW; END IF;

  IF jsonb_typeof(NEW.tools_used) = 'array' THEN
    SELECT
      COALESCE(bool_and(COALESCE(jsonb_typeof(e) = 'object'
        AND e->>'outcome' IN ('executed', 'failed', 'pending', 'simulated', 'skipped', 'rejected')
        AND e->'success' IN ('true'::jsonb, 'false'::jsonb)
        AND ((e->>'outcome' = 'executed') = (e->'success' = 'true'::jsonb)), false)), true),
      COALESCE(bool_or(COALESCE(e->>'outcome' = 'executed' OR e->'success' = 'true'::jsonb, false)), false),
      COALESCE(bool_or(COALESCE(e->>'outcome' = 'pending' OR e ? 'pendingActionId', false)), false),
      jsonb_array_length(NEW.tools_used) > 0 AND
        COALESCE(bool_and(COALESCE(e->>'outcome' = 'executed' AND e->'success' = 'true'::jsonb, false)), false)
      INTO v_valid_trace, v_recorded_effect, v_pending_trace, v_all_executed
      FROM jsonb_array_elements(NEW.tools_used) e;
  END IF;
  SELECT EXISTS(SELECT 1 FROM purama_ai.karta_pending_actions p WHERE p.run_id = NEW.id),
    EXISTS(SELECT 1 FROM purama_ai.karta_pending_actions p WHERE p.run_id = NEW.id AND p.status IN ('pending', 'executing')),
    EXISTS(SELECT 1 FROM purama_ai.karta_pending_actions p WHERE p.run_id = NEW.id AND p.status <> 'executed')
    INTO v_has_approval, v_open_approval, v_unexecuted_approval;

  IF v_claim.state = 'claimed' THEN
    IF v_valid_trace AND NOT v_recorded_effect AND NOT v_pending_trace AND NOT v_has_approval
        AND v_claim.attempt_count < 3
        AND NEW.status IN ('success', 'error', 'skipped', 'cancelled', 'simulated')
        AND NEW.mode IN ('live', 'simulation') AND NEW.duration_ms >= 0 AND NEW.finished_at IS NOT NULL THEN
      -- No arm was confirmed, so no effect was allowed. The input survives a
      -- model failure, a mock decision, a no-op or a stop before dispatch.
      v_next_state := 'ready';
    END IF;
  ELSIF v_valid_trace AND NEW.mode = 'live' AND NOT NEW.claude_mock AND NEW.duration_ms >= 0 THEN
    IF NEW.status = 'awaiting_approval' AND v_pending_trace AND v_open_approval THEN
      v_next_state := 'awaiting_approval';
    ELSIF NEW.status = 'success' AND v_all_executed AND NOT v_unexecuted_approval
        AND NEW.finished_at IS NOT NULL THEN
      v_next_state := 'completed';
    END IF;
  END IF;

  UPDATE purama_ai.karta_brief_claims SET state = v_next_state, updated_at = now(),
    ready_at = CASE WHEN v_next_state = 'ready' THEN clock_timestamp() ELSE ready_at END
    WHERE run_id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS karta_settle_brief_after_run ON purama_ai.karta_runs;
CREATE TRIGGER karta_settle_brief_after_run
  AFTER UPDATE OF status, duration_ms, mode, claude_mock, tools_used, user_id, agent_type
  ON purama_ai.karta_runs FOR EACH ROW
  EXECUTE FUNCTION purama_ai.karta_settle_brief_after_run();

REVOKE ALL ON FUNCTION purama_ai.karta_claim_pending_brief(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.karta_peek_pending_brief(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.karta_arm_pending_brief(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.karta_settle_brief_after_run() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.karta_claim_pending_brief(uuid,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.karta_peek_pending_brief(uuid,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.karta_arm_pending_brief(uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.karta_settle_brief_after_run() TO service_role;
COMMIT;
