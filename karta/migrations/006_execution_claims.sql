-- Apply before the corrected KARTA engine. No provider action is executed here.
BEGIN;
ALTER TABLE purama_ai.karta_runs ADD COLUMN IF NOT EXISTS execution_key text;
CREATE UNIQUE INDEX IF NOT EXISTS karta_runs_execution_key_unique
  ON purama_ai.karta_runs(execution_key) WHERE execution_key IS NOT NULL;
ALTER TABLE purama_ai.karta_pending_actions ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE OR REPLACE FUNCTION purama_ai.karta_claim_pending_action(p_id uuid, p_decision text)
RETURNS SETOF purama_ai.karta_pending_actions
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE pending purama_ai.karta_pending_actions%ROWTYPE;
DECLARE parent_status text;
BEGIN
  IF p_decision NOT IN ('approve', 'reject') OR p_decision IS NULL THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  SELECT * INTO pending FROM purama_ai.karta_pending_actions WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;
  -- All resolution functions use the same parent -> action lock ordering.
  SELECT status INTO parent_status FROM purama_ai.karta_runs
    WHERE id = pending.run_id AND user_id = pending.user_id FOR UPDATE;
  IF NOT FOUND OR parent_status = 'running' THEN RAISE EXCEPTION 'Cycle not ready'; END IF;
  IF p_decision = 'approve' THEN
    IF NOT EXISTS (SELECT 1 FROM purama_ai.karta_global_state WHERE id = 'global' AND NOT kill_switch) THEN
      RAISE EXCEPTION 'Global stop active';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM purama_ai.karta_agent_state WHERE user_id = pending.user_id
      AND agent_type = pending.agent_type AND is_enabled AND NOT kill_switch AND NOT simulation_mode) THEN
      RAISE EXCEPTION 'Agent cannot execute';
    END IF;
  END IF;
  RETURN QUERY UPDATE purama_ai.karta_pending_actions SET status = 'executing', claimed_at = now()
    WHERE id = p_id AND status = 'pending' RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.karta_finalize_pending_action(p_id uuid, p_status text, p_summary text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE pending purama_ai.karta_pending_actions%ROWTYPE;
DECLARE parent purama_ai.karta_runs%ROWTYPE;
DECLARE patched jsonb;
DECLARE waiting_count integer;
DECLARE executing_count integer;
DECLARE done_count integer;
DECLARE failed_count integer;
DECLARE skipped_count integer;
DECLARE next_status text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('executed','failed','rejected','cancelled') THEN RAISE EXCEPTION 'Invalid result'; END IF;
  SELECT * INTO pending FROM purama_ai.karta_pending_actions WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown action'; END IF;
  SELECT * INTO parent FROM purama_ai.karta_runs WHERE id = pending.run_id AND user_id = pending.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown parent'; END IF;
  SELECT * INTO pending FROM purama_ai.karta_pending_actions WHERE id = p_id FOR UPDATE;
  IF pending.status <> 'executing' THEN
    IF pending.status = p_status AND pending.resolved_at IS NOT NULL THEN RETURN; END IF;
    RAISE EXCEPTION 'Action not claimed';
  END IF;
  UPDATE purama_ai.karta_pending_actions SET status = p_status, result_summary = left(p_summary, 500), resolved_at = now() WHERE id = p_id;
  SELECT COALESCE(jsonb_agg(CASE WHEN entry->>'pendingActionId' = p_id::text THEN
    entry || jsonb_build_object('success', p_status = 'executed', 'outcome',
      CASE WHEN p_status = 'cancelled' THEN 'skipped' ELSE p_status END, 'resultSummary', left(p_summary,500))
    ELSE entry END ORDER BY ordinal), '[]'::jsonb)
    INTO patched FROM jsonb_array_elements(parent.tools_used) WITH ORDINALITY AS t(entry, ordinal);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(patched) e WHERE e->>'pendingActionId' = p_id::text) THEN
    RAISE EXCEPTION 'Action missing from parent journal';
  END IF;
  SELECT count(*) FILTER (WHERE status = 'pending'), count(*) FILTER (WHERE status = 'executing')
    INTO waiting_count, executing_count FROM purama_ai.karta_pending_actions WHERE run_id = parent.id;
  SELECT count(*) FILTER (WHERE e->>'outcome' = 'executed' OR (e->>'outcome' IS NULL AND e->>'success' = 'true' AND NOT (e ? 'pendingActionId'))),
    count(*) FILTER (WHERE e->>'outcome' = 'failed' OR (e->>'outcome' IS NULL AND e->>'success' = 'false' AND NOT (e ? 'pendingActionId'))),
    count(*) FILTER (WHERE e->>'outcome' IN ('skipped','rejected'))
    INTO done_count, failed_count, skipped_count FROM jsonb_array_elements(patched) e;
  next_status := CASE WHEN waiting_count > 0 THEN 'awaiting_approval' WHEN executing_count > 0 THEN 'running'
    WHEN failed_count > 0 THEN 'error' WHEN skipped_count > 0 AND done_count > 0 THEN 'partial'
    WHEN skipped_count > 0 THEN 'skipped' ELSE 'success' END;
  UPDATE purama_ai.karta_runs SET tools_used = patched, status = next_status,
    result_summary = done_count || '/' || jsonb_array_length(patched) || ' action(s) exécutée(s)',
    finished_at = CASE WHEN waiting_count + executing_count > 0 THEN NULL ELSE now() END WHERE id = parent.id;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.karta_claim_pending_action(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purama_ai.karta_finalize_pending_action(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.karta_claim_pending_action(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.karta_finalize_pending_action(uuid,text,text) TO service_role;
COMMIT;
