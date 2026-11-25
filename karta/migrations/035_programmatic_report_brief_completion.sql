-- A completed hosted conclusion may have no external read. Settle its existing
-- brief only when the private product report is durably stored for this exact
-- owner/run/agent, with native multi-response usage and no invented tool trace.
-- Apply after 033 and 034, before enabling programmatic reads. Historical brief
-- rules, SECURITY INVOKER, trigger identity and existing function grants persist.
BEGIN;

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
  v_programmatic_report boolean := false;
  v_empty_read_report boolean := false;
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
  -- A product report is a durable effect, without inventing a tool action.
  -- The existing store derives ownership from this run and permits only
  -- immutable server-origin records. Its RLS/grants remain unchanged.
  SELECT count(*) > 0,
    coalesce(bool_or(r.payload->'details'->'read_tools' = '[]'::jsonb), false)
    INTO v_programmatic_report, v_empty_read_report
    FROM purama_ai.karta_tool_results r
    WHERE r.run_id = NEW.id AND r.user_id = NEW.user_id
      AND NEW.agent_type = 'custom:' || r.creator_agent_id::text
      AND r.tool_name = 'programmatic_report'
      AND r.payload->>'status' = 'complete';
  IF v_programmatic_report THEN
    -- A stored result must never be automatically replayed if its arm or final
    -- acknowledgement is inconsistent. Keep reconciliation_required instead.
    v_recorded_effect := true;
    IF NEW.tools_used = '[]'::jsonb AND v_empty_read_report
       AND NEW.model_usage->'version' = '2'::jsonb
       AND NEW.model_usage->>'routeKind' = 'anthropic' THEN
      v_all_executed := true;
    END IF;
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

COMMIT;
