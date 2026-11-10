-- A submitted brief has one durable identity before Redis is contacted.
-- Reuse the existing pending slot and private claims; BullMQ remains the queue.
-- Stop old workers before rollout: all claimers must share these transaction locks.
BEGIN;

ALTER TABLE purama_ai.karta_runs ADD COLUMN IF NOT EXISTS brief_id uuid;
CREATE INDEX IF NOT EXISTS karta_runs_brief_lookup
  ON purama_ai.karta_runs(user_id, agent_type, brief_id, started_at DESC)
  WHERE brief_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS karta_brief_current_owner_lookup
  ON purama_ai.karta_brief_claims(user_id, agent_type, memory_key)
  WHERE state <> 'transferred';
CREATE INDEX IF NOT EXISTS karta_brief_history_lookup
  ON purama_ai.karta_brief_claims(brief_id, created_at);
UPDATE purama_ai.karta_runs r SET brief_id = c.brief_id
  FROM purama_ai.karta_brief_claims c
  WHERE r.id = c.run_id AND r.user_id = c.user_id AND r.agent_type = c.agent_type
    AND r.brief_id IS NULL;

-- Existing owner policies still allow private reads and normal memory writes.
-- Restrictive policies also prevent renaming an ordinary key into/out of this slot.
DROP POLICY IF EXISTS karta_brief_server_insert ON purama_ai.karta_agent_memory;
CREATE POLICY karta_brief_server_insert ON purama_ai.karta_agent_memory
  AS RESTRICTIVE FOR INSERT TO anon, authenticated
  WITH CHECK (memory_key <> 'pending_brief');
DROP POLICY IF EXISTS karta_brief_server_update ON purama_ai.karta_agent_memory;
CREATE POLICY karta_brief_server_update ON purama_ai.karta_agent_memory
  AS RESTRICTIVE FOR UPDATE TO anon, authenticated
  USING (memory_key <> 'pending_brief') WITH CHECK (memory_key <> 'pending_brief');
DROP POLICY IF EXISTS karta_brief_server_delete ON purama_ai.karta_agent_memory;
CREATE POLICY karta_brief_server_delete ON purama_ai.karta_agent_memory
  AS RESTRICTIVE FOR DELETE TO anon, authenticated
  USING (memory_key <> 'pending_brief');

-- Shared lock order for admission/acquisition: parent run (if any), owned slot,
-- global brief UUID, then receipt/memory rows. A claim can atomically move an
-- identity between tables without a retry mistaking that move for a new request.
CREATE OR REPLACE FUNCTION purama_ai.karta_lock_brief_slot(p_user_id uuid, p_agent_type text, p_key text)
RETURNS void LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT pg_advisory_xact_lock(hashtextextended(
    'karta.brief.slot:' || jsonb_build_array(p_user_id, p_agent_type, p_key)::text, 0));
$$;
CREATE OR REPLACE FUNCTION purama_ai.karta_lock_brief_identity(p_brief_id uuid)
RETURNS void LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('karta.brief.identity:' || p_brief_id::text, 0));
$$;

-- The fifth parameter is required in this overload. The compatible four-argument
-- wrapper below alone owns its default argument; PostgREST can resolve both.
CREATE OR REPLACE FUNCTION purama_ai.karta_claim_pending_brief(
  p_user_id uuid, p_agent_type text, p_run_id uuid, p_key text, p_expected_brief_id uuid
)
RETURNS TABLE(brief_id uuid, brief text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_claim purama_ai.karta_brief_claims%ROWTYPE;
  v_memory purama_ai.karta_agent_memory%ROWTYPE;
  v_bound uuid;
  v_expected uuid;
  v_candidate uuid;
  v_space constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF p_user_id IS NULL OR p_run_id IS NULL OR p_agent_type IS NULL OR
      btrim(p_agent_type) = '' OR p_key IS NULL OR btrim(p_key) = '' THEN
    RAISE EXCEPTION 'Brief claim unavailable';
  END IF;
  SELECT r.brief_id INTO v_bound FROM purama_ai.karta_runs r
    WHERE r.id = p_run_id AND r.user_id = p_user_id AND r.agent_type = p_agent_type
      AND r.status = 'running' AND r.duration_ms IS NULL AND r.mode = 'live'
    FOR UPDATE;
  IF NOT FOUND OR (v_bound IS NOT NULL AND p_expected_brief_id IS NOT NULL AND v_bound <> p_expected_brief_id) THEN
    RAISE EXCEPTION 'Brief claim unavailable';
  END IF;
  v_expected := COALESCE(p_expected_brief_id, v_bound);
  PERFORM purama_ai.karta_lock_brief_slot(p_user_id, p_agent_type, p_key);
  IF v_expected IS NOT NULL THEN PERFORM purama_ai.karta_lock_brief_identity(v_expected); END IF;

  SELECT * INTO v_claim FROM purama_ai.karta_brief_claims c WHERE c.run_id = p_run_id;
  IF FOUND THEN
    IF v_expected IS NULL THEN PERFORM purama_ai.karta_lock_brief_identity(v_claim.brief_id); END IF;
    SELECT * INTO v_claim FROM purama_ai.karta_brief_claims c WHERE c.run_id = p_run_id FOR UPDATE;
    IF v_claim.user_id <> p_user_id OR v_claim.agent_type <> p_agent_type OR
        v_claim.memory_key <> p_key OR v_claim.state <> 'claimed' OR
        (v_expected IS NOT NULL AND v_claim.brief_id <> v_expected) THEN
      RAISE EXCEPTION 'Brief claim unavailable';
    END IF;
    UPDATE purama_ai.karta_runs SET brief_id = v_claim.brief_id WHERE id = p_run_id;
    RETURN QUERY SELECT v_claim.brief_id, v_claim.payload;
    RETURN;
  END IF;

  -- Locate an identity while holding its owned slot, then lock the identity
  -- before locking its row. Exact delivery never falls back to another brief.
  SELECT c.brief_id INTO v_candidate FROM purama_ai.karta_brief_claims c
    WHERE c.user_id = p_user_id AND c.agent_type = p_agent_type
      AND c.memory_key = p_key AND c.state = 'ready'
      AND (v_expected IS NULL OR c.brief_id = v_expected)
    ORDER BY c.ready_at, c.run_id LIMIT 1;
  IF NOT FOUND THEN
    SELECT m.id INTO v_candidate FROM purama_ai.karta_agent_memory m
      WHERE m.user_id = p_user_id AND m.agent_type = p_agent_type AND m.memory_key = p_key
        AND (v_expected IS NULL OR m.id = v_expected)
        AND jsonb_typeof(m.memory_value) = 'string'
        AND btrim(m.memory_value #>> '{}', v_space) <> ''
      ORDER BY m.updated_at, m.id LIMIT 1;
  END IF;
  IF v_candidate IS NULL THEN RETURN; END IF;
  IF v_expected IS NULL THEN PERFORM purama_ai.karta_lock_brief_identity(v_candidate); END IF;

  SELECT * INTO v_claim FROM purama_ai.karta_brief_claims c
    WHERE c.user_id = p_user_id AND c.agent_type = p_agent_type AND c.memory_key = p_key
      AND c.brief_id = v_candidate AND c.state = 'ready'
    ORDER BY c.ready_at, c.run_id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    UPDATE purama_ai.karta_brief_claims
      SET state = 'transferred', transferred_to_run_id = p_run_id, updated_at = now()
      WHERE run_id = v_claim.run_id;
    INSERT INTO purama_ai.karta_brief_claims
      (run_id, user_id, agent_type, memory_key, brief_id, payload, previous_run_id, attempt_count, created_at)
      VALUES (p_run_id, p_user_id, p_agent_type, p_key, v_claim.brief_id, v_claim.payload, v_claim.run_id, v_claim.attempt_count + 1, v_claim.created_at);
    UPDATE purama_ai.karta_runs SET brief_id = v_claim.brief_id WHERE id = p_run_id;
    RETURN QUERY SELECT v_claim.brief_id, v_claim.payload;
    RETURN;
  END IF;

  SELECT * INTO v_memory FROM purama_ai.karta_agent_memory m
    WHERE m.id = v_candidate AND m.user_id = p_user_id AND m.agent_type = p_agent_type AND m.memory_key = p_key
      AND jsonb_typeof(m.memory_value) = 'string'
      AND btrim(m.memory_value #>> '{}', v_space) <> ''
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO purama_ai.karta_brief_claims
    (run_id, user_id, agent_type, memory_key, brief_id, payload, created_at)
    VALUES (p_run_id, p_user_id, p_agent_type, p_key, v_memory.id, v_memory.memory_value #>> '{}', v_memory.updated_at);
  DELETE FROM purama_ai.karta_agent_memory WHERE id = v_memory.id;
  UPDATE purama_ai.karta_runs SET brief_id = v_memory.id WHERE id = p_run_id;
  RETURN QUERY SELECT v_memory.id, v_memory.memory_value #>> '{}';
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.karta_claim_pending_brief(
  p_user_id uuid, p_agent_type text, p_run_id uuid, p_key text DEFAULT 'pending_brief'
)
RETURNS TABLE(brief_id uuid, brief text)
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT * FROM purama_ai.karta_claim_pending_brief(p_user_id, p_agent_type, p_run_id, p_key, NULL::uuid);
$$;

CREATE OR REPLACE FUNCTION purama_ai.karta_peek_pending_brief(
  p_user_id uuid, p_agent_type text, p_run_id uuid, p_key text, p_expected_brief_id uuid
)
RETURNS TABLE(brief_id uuid, brief text)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_bound uuid;
  v_expected uuid;
  v_brief_id uuid;
  v_brief text;
  v_space constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF p_user_id IS NULL OR p_run_id IS NULL OR p_agent_type IS NULL OR
      btrim(p_agent_type) = '' OR p_key IS NULL OR btrim(p_key) = '' THEN
    RAISE EXCEPTION 'Brief preview unavailable';
  END IF;
  SELECT r.brief_id INTO v_bound FROM purama_ai.karta_runs r
    WHERE r.id = p_run_id AND r.user_id = p_user_id AND r.agent_type = p_agent_type
      AND r.status = 'running' AND r.duration_ms IS NULL AND r.mode = 'simulation'
    FOR UPDATE;
  IF NOT FOUND OR (v_bound IS NOT NULL AND p_expected_brief_id IS NOT NULL AND v_bound <> p_expected_brief_id) THEN
    RAISE EXCEPTION 'Brief preview unavailable';
  END IF;
  v_expected := COALESCE(p_expected_brief_id, v_bound);
  SELECT c.brief_id, c.payload INTO v_brief_id, v_brief FROM purama_ai.karta_brief_claims c
    WHERE c.user_id = p_user_id AND c.agent_type = p_agent_type AND c.memory_key = p_key
      AND c.state = 'ready' AND (v_expected IS NULL OR c.brief_id = v_expected)
    ORDER BY c.ready_at, c.run_id LIMIT 1;
  IF NOT FOUND THEN
    SELECT m.id, m.memory_value #>> '{}' INTO v_brief_id, v_brief FROM purama_ai.karta_agent_memory m
      WHERE m.user_id = p_user_id AND m.agent_type = p_agent_type AND m.memory_key = p_key
        AND (v_expected IS NULL OR m.id = v_expected)
        AND jsonb_typeof(m.memory_value) = 'string'
        AND btrim(m.memory_value #>> '{}', v_space) <> ''
      ORDER BY m.updated_at, m.id LIMIT 1;
  END IF;
  IF v_brief_id IS NULL THEN RETURN; END IF;
  -- Only run metadata changes. Simulation never reserves, copies or deletes input.
  UPDATE purama_ai.karta_runs SET brief_id = v_brief_id WHERE id = p_run_id;
  RETURN QUERY SELECT v_brief_id, v_brief;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.karta_peek_pending_brief(
  p_user_id uuid, p_agent_type text, p_run_id uuid, p_key text DEFAULT 'pending_brief'
)
RETURNS TABLE(brief_id uuid, brief text)
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT * FROM purama_ai.karta_peek_pending_brief(p_user_id, p_agent_type, p_run_id, p_key, NULL::uuid);
$$;

-- Common metadata projection. Payloads and raw request keys never leave it.
CREATE OR REPLACE FUNCTION purama_ai.karta_brief_status_rows(
  p_user_id uuid, p_agent_type text, p_submission_id uuid
)
RETURNS TABLE(
  submission_id uuid, agent_type text, state text, created_at timestamptz, updated_at timestamptz,
  attempt_count integer, run_id uuid, run_status text, run_mode text, run_mock boolean
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  WITH inputs AS (
    SELECT m.id AS submission_id, m.agent_type, 'pending'::text AS state,
      m.updated_at AS created_at, m.updated_at, 0 AS attempt_count, NULL::uuid AS claim_run_id
    FROM purama_ai.karta_agent_memory m
    WHERE m.user_id = p_user_id AND m.agent_type = p_agent_type AND m.memory_key = 'pending_brief'
      AND (p_submission_id IS NULL OR m.id = p_submission_id)
      AND NOT EXISTS (SELECT 1 FROM purama_ai.karta_brief_claims c WHERE c.brief_id = m.id AND c.state <> 'transferred')
    UNION ALL
    SELECT c.brief_id, c.agent_type, c.state,
      (SELECT min(h.created_at) FROM purama_ai.karta_brief_claims h WHERE h.brief_id = c.brief_id
        AND h.user_id = p_user_id AND h.agent_type = p_agent_type AND h.memory_key = 'pending_brief'),
      c.updated_at, c.attempt_count, c.run_id
    FROM purama_ai.karta_brief_claims c
    WHERE c.user_id = p_user_id AND c.agent_type = p_agent_type AND c.memory_key = 'pending_brief'
      AND c.state <> 'transferred' AND (p_submission_id IS NULL OR c.brief_id = p_submission_id)
  )
  SELECT i.submission_id, i.agent_type, i.state, i.created_at,
    greatest(i.updated_at, coalesce(r.finished_at, r.started_at, i.updated_at)) AS updated_at,
    i.attempt_count, r.id, r.status, r.mode, r.claude_mock
  FROM inputs i
  LEFT JOIN LATERAL (
    SELECT k.id, k.status, k.mode, k.claude_mock, k.started_at, k.finished_at
    FROM purama_ai.karta_runs k
    WHERE k.user_id = p_user_id AND k.agent_type = p_agent_type
      AND (k.brief_id = i.submission_id OR k.id = i.claim_run_id)
    -- An active/terminal receipt is owned by its claim run, even when an older
    -- started run acquired it after a newer simulation had previewed it.
    ORDER BY CASE WHEN i.state NOT IN ('pending', 'ready') AND k.id = i.claim_run_id THEN 0 ELSE 1 END,
      k.started_at DESC, k.id DESC LIMIT 1
  ) r ON true
  -- The single pending slot must remain reachable even if older receipts have
  -- newer activity. Otherwise a hidden pending input would block all new ones.
  ORDER BY CASE WHEN i.state = 'pending' THEN 0 ELSE 1 END,
    updated_at DESC, i.submission_id LIMIT 20;
$$;

CREATE OR REPLACE FUNCTION purama_ai.karta_get_brief_status(p_user_id uuid, p_agent_type text, p_submission_id uuid)
RETURNS TABLE(
  submission_id uuid, agent_type text, state text, created_at timestamptz, updated_at timestamptz,
  attempt_count integer, run_id uuid, run_status text, run_mode text, run_mock boolean
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT * FROM purama_ai.karta_brief_status_rows(p_user_id, p_agent_type, p_submission_id)
    WHERE p_submission_id IS NOT NULL;
$$;
CREATE OR REPLACE FUNCTION purama_ai.karta_list_briefs(p_user_id uuid, p_agent_type text)
RETURNS TABLE(
  submission_id uuid, agent_type text, state text, created_at timestamptz, updated_at timestamptz,
  attempt_count integer, run_id uuid, run_status text, run_mode text, run_mock boolean
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT * FROM purama_ai.karta_brief_status_rows(p_user_id, p_agent_type, NULL::uuid);
$$;

CREATE OR REPLACE FUNCTION purama_ai.karta_submit_brief(
  p_user_id uuid, p_agent_type text, p_submission_id uuid, p_brief text
)
RETURNS TABLE(
  submission_id uuid, agent_type text, state text, created_at timestamptz, updated_at timestamptz,
  attempt_count integer, run_id uuid, run_status text, run_mode text, run_mock boolean
)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_memory purama_ai.karta_agent_memory%ROWTYPE;
  v_has_memory boolean;
  v_has_receipt boolean;
  v_space constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF p_user_id IS NULL OR p_submission_id IS NULL OR p_agent_type IS NULL OR
      p_agent_type NOT IN ('campagnes-par-courriel', 'pro-de-la-sensibilisation-au-froid',
        'newsletter-genie', 'maitre-des-publicites', 'planificateur-d-appels', 'reservation-intelligente') OR
      p_brief IS NULL OR char_length(p_brief) > 8000 OR btrim(p_brief, v_space) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'PBR01', MESSAGE = 'Brief submission invalid';
  END IF;
  PERFORM purama_ai.karta_lock_brief_slot(p_user_id, p_agent_type, 'pending_brief');
  PERFORM purama_ai.karta_lock_brief_identity(p_submission_id);
  SELECT * INTO v_memory FROM purama_ai.karta_agent_memory m WHERE m.id = p_submission_id;
  v_has_memory := FOUND;
  SELECT EXISTS(SELECT 1 FROM purama_ai.karta_brief_claims c WHERE c.brief_id = p_submission_id) INTO v_has_receipt;
  IF v_has_receipt THEN
    IF EXISTS(SELECT 1 FROM purama_ai.karta_brief_claims c WHERE c.brief_id = p_submission_id
        AND (c.user_id <> p_user_id OR c.agent_type <> p_agent_type OR c.memory_key <> 'pending_brief' OR c.payload IS DISTINCT FROM p_brief))
        OR (v_has_memory AND v_memory.memory_key = 'pending_brief') THEN
      RAISE EXCEPTION USING ERRCODE = 'PBR02', MESSAGE = 'Brief submission identity conflict';
    END IF;
    -- A claimed input's old memory UUID is free. An ordinary, client-writable
    -- memory row reusing it cannot invalidate the authoritative private receipt.
    RETURN QUERY SELECT * FROM purama_ai.karta_get_brief_status(p_user_id, p_agent_type, p_submission_id);
    RETURN;
  END IF;
  IF v_has_memory AND (v_memory.user_id <> p_user_id OR v_memory.agent_type <> p_agent_type OR
      v_memory.memory_key <> 'pending_brief' OR jsonb_typeof(v_memory.memory_value) <> 'string' OR
      (v_memory.memory_value #>> '{}') IS DISTINCT FROM p_brief) THEN
    RAISE EXCEPTION USING ERRCODE = 'PBR02', MESSAGE = 'Brief submission identity conflict';
  END IF;
  IF NOT v_has_memory THEN
    IF EXISTS(SELECT 1 FROM purama_ai.karta_agent_memory m
        WHERE m.user_id = p_user_id AND m.agent_type = p_agent_type AND m.memory_key = 'pending_brief') THEN
      RAISE EXCEPTION USING ERRCODE = 'PBR03', MESSAGE = 'Brief submission slot occupied';
    END IF;
    INSERT INTO purama_ai.karta_agent_memory(id, user_id, agent_type, memory_key, memory_value)
      VALUES(p_submission_id, p_user_id, p_agent_type, 'pending_brief', to_jsonb(p_brief))
      ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'PBR02', MESSAGE = 'Brief submission identity conflict';
    END IF;
  END IF;
  RETURN QUERY SELECT * FROM purama_ai.karta_get_brief_status(p_user_id, p_agent_type, p_submission_id);
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.karta_lock_brief_slot(uuid,text,text),
  purama_ai.karta_lock_brief_identity(uuid),
  purama_ai.karta_claim_pending_brief(uuid,text,uuid,text,uuid),
  purama_ai.karta_claim_pending_brief(uuid,text,uuid,text),
  purama_ai.karta_peek_pending_brief(uuid,text,uuid,text,uuid),
  purama_ai.karta_peek_pending_brief(uuid,text,uuid,text),
  purama_ai.karta_brief_status_rows(uuid,text,uuid),
  purama_ai.karta_get_brief_status(uuid,text,uuid),
  purama_ai.karta_list_briefs(uuid,text),
  purama_ai.karta_submit_brief(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.karta_lock_brief_slot(uuid,text,text),
  purama_ai.karta_lock_brief_identity(uuid),
  purama_ai.karta_claim_pending_brief(uuid,text,uuid,text,uuid),
  purama_ai.karta_claim_pending_brief(uuid,text,uuid,text),
  purama_ai.karta_peek_pending_brief(uuid,text,uuid,text,uuid),
  purama_ai.karta_peek_pending_brief(uuid,text,uuid,text),
  purama_ai.karta_brief_status_rows(uuid,text,uuid),
  purama_ai.karta_get_brief_status(uuid,text,uuid),
  purama_ai.karta_list_briefs(uuid,text),
  purama_ai.karta_submit_brief(uuid,text,uuid,text) TO service_role;

-- Refresh named-argument overloads after the migration commits.
NOTIFY pgrst, 'reload schema';
COMMIT;
