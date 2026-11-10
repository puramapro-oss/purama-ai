-- Require a confirmed parent journal before an approval can authorize an effect.
-- Legacy or ambiguous approvals fail closed and require reconciliation. This
-- migration does not rewrite their payloads or alter the existing finalizer.
BEGIN;

CREATE OR REPLACE FUNCTION purama_ai.karta_claim_pending_action(p_id uuid, p_decision text)
RETURNS SETOF purama_ai.karta_pending_actions
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  observed purama_ai.karta_pending_actions%ROWTYPE;
  pending purama_ai.karta_pending_actions%ROWTYPE;
  parent purama_ai.karta_runs%ROWTYPE;
  matching_count bigint;
  matching_entry jsonb;
BEGIN
  IF p_decision NOT IN ('approve', 'reject') OR p_decision IS NULL THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;
  SELECT * INTO observed FROM purama_ai.karta_pending_actions WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Preserve the parent -> action lock order shared with finalization. The
  -- first unlocked read only locates the parent; it never authorizes work.
  SELECT * INTO parent FROM purama_ai.karta_runs
    WHERE id = observed.run_id AND user_id = observed.user_id AND agent_type = observed.agent_type
    FOR UPDATE;
  IF NOT FOUND OR parent.status = 'running' OR parent.duration_ms IS NULL OR parent.duration_ms < 0 THEN
    RAISE EXCEPTION 'Cycle not ready';
  END IF;
  SELECT * INTO pending FROM purama_ai.karta_pending_actions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF pending.run_id IS DISTINCT FROM observed.run_id OR
      pending.user_id IS DISTINCT FROM observed.user_id OR
      pending.agent_type IS DISTINCT FROM observed.agent_type OR
      pending.tool_name IS DISTINCT FROM observed.tool_name THEN
    RAISE EXCEPTION 'Action binding changed';
  END IF;
  IF pending.status <> 'pending' THEN RETURN; END IF;

  -- Finalization already requires this link. Check it before executing, not
  -- after a provider may have accepted the action. An incomplete old trace
  -- must be reconciled rather than inferred from the pending row alone.
  IF jsonb_typeof(parent.tools_used) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Action journal unavailable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(parent.tools_used) AS items(entry)
      WHERE jsonb_typeof(entry) IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'Action journal unavailable';
  END IF;
  SELECT count(*) INTO matching_count
    FROM jsonb_array_elements(parent.tools_used) AS items(entry)
    WHERE entry->>'pendingActionId' = p_id::text;
  IF matching_count <> 1 THEN RAISE EXCEPTION 'Action journal unavailable'; END IF;
  SELECT entry INTO matching_entry
    FROM jsonb_array_elements(parent.tools_used) AS items(entry)
    WHERE entry->>'pendingActionId' = p_id::text;
  IF jsonb_typeof(matching_entry->'tool') IS DISTINCT FROM 'string' OR
      matching_entry->>'tool' IS DISTINCT FROM pending.tool_name OR
      matching_entry->'success' IS DISTINCT FROM 'false'::jsonb OR
      matching_entry->>'outcome' IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Action journal unavailable';
  END IF;

  -- Reject still needs a valid journal link, but stopping an agent must not
  -- prevent the user from rejecting an otherwise valid pending action.
  IF p_decision = 'approve' THEN
    -- Enabling the agent later cannot turn a simulated/mock journal into
    -- authorization for an external effect.
    IF parent.mode IS DISTINCT FROM 'live' OR parent.claude_mock IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'Cycle cannot execute';
    END IF;
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

REVOKE ALL ON FUNCTION purama_ai.karta_claim_pending_action(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.karta_claim_pending_action(uuid,text) TO service_role;
COMMIT;
