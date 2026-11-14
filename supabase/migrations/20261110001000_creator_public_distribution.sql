-- A public model is a description and a reusable configuration, never its owner's
-- identity, scheduling input or execution history. Ship with the distribution UI.
BEGIN;

-- Also works before the optional KARTA migration is installed; both use the
-- same opt-in column and default. A copied model never starts an executor.
ALTER TABLE purama_ai.creator_agents
  ADD COLUMN IF NOT EXISTS karta_enabled boolean NOT NULL DEFAULT false;

-- Official seeds have no user owner. Earlier browser policies could set this
-- flag directly; repair that legacy state and retain ordinary owner editing.
UPDATE purama_ai.creator_agents SET is_template = false
WHERE is_template IS NULL OR (user_id IS NOT NULL AND is_template = true);
ALTER TABLE purama_ai.creator_agents ALTER COLUMN is_template SET NOT NULL;

-- A user's copy survives removal of a published source or its author's account.
-- Keep the source UUID for provenance/idempotency, never for authorization.
ALTER TABLE purama_ai.creator_agents
  DROP CONSTRAINT IF EXISTS creator_agents_cloned_from_fkey;
COMMENT ON COLUMN purama_ai.creator_agents.cloned_from IS
  'Source UUID retained after source deletion; provenance only, never an access grant.';

-- Preserve owner CRUD. Public reads go through the explicit projection below.
DROP POLICY IF EXISTS "creator_agents select" ON purama_ai.creator_agents;
CREATE POLICY "creator_agents select" ON purama_ai.creator_agents
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

-- A browser may publish its own model, but cannot award official-template status.
DROP POLICY IF EXISTS "creator_agents insert" ON purama_ai.creator_agents;
CREATE POLICY "creator_agents insert" ON purama_ai.creator_agents
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id AND is_template = false);
DROP POLICY IF EXISTS "creator_agents update" ON purama_ai.creator_agents;
CREATE POLICY "creator_agents update" ON purama_ai.creator_agents
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id AND is_template = false);

REVOKE ALL ON TABLE purama_ai.creator_agents FROM PUBLIC, anon;
REVOKE ALL ON TABLE purama_ai.creator_agents FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE purama_ai.creator_agents TO authenticated;
-- RLS does not apply to TRUNCATE. The legacy blanket ALL grant also covered
-- history tables; retain their existing owner policies and remove that bypass.
REVOKE ALL ON TABLE purama_ai.creator_agent_runs, purama_ai.creator_agent_chats
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE purama_ai.creator_agent_runs, purama_ai.creator_agent_chats TO authenticated;

CREATE OR REPLACE FUNCTION purama_ai.public_creator_models(
  p_id uuid DEFAULT NULL,
  p_kind text DEFAULT 'all'
)
RETURNS TABLE (
  id uuid, name text, description text, emoji text, color text, category text,
  is_public boolean, is_template boolean, is_active boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.id,
         left(regexp_replace(a.name, '^[[:space:]]+|[[:space:]]+$', '', 'g'), 160),
         left(btrim(a.description), 1600), left(a.emoji, 16),
         CASE WHEN a.color ~ '^#[[:xdigit:]]{6}$' THEN a.color ELSE '#8B5CF6' END,
         CASE WHEN a.category IN ('productivity', 'marketing', 'sales', 'support', 'content', 'dev', 'finance', 'autre')
           THEN a.category ELSE NULL END,
         (a.is_public IS TRUE), (a.is_template IS TRUE AND a.user_id IS NULL), a.is_active
  FROM purama_ai.creator_agents AS a
  WHERE a.is_active = true
    AND a.name ~ '[^[:space:]]'
    AND (a.is_public = true OR (a.is_template = true AND a.user_id IS NULL))
    AND (p_id IS NULL OR a.id = p_id)
    AND (p_kind = 'all'
      OR (p_kind = 'official' AND a.is_template = true AND a.user_id IS NULL)
      OR (p_kind = 'community' AND a.is_public = true AND NOT (a.is_template = true AND a.user_id IS NULL)))
  ORDER BY (a.is_template = true AND a.user_id IS NULL) DESC, a.name ASC, a.id ASC
  LIMIT 100;
$$;
REVOKE ALL ON FUNCTION purama_ai.public_creator_models(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purama_ai.public_creator_models(uuid, text) TO anon, authenticated;

-- The expected identity binds the click to its account; it never grants rights.
-- Postgres derives the owner from auth.uid() and rejects a changed session.
-- A caller-generated UUID identifies one copy attempt across retries.
DROP FUNCTION IF EXISTS purama_ai.clone_public_creator_model(uuid, uuid);
CREATE OR REPLACE FUNCTION purama_ai.clone_public_creator_model(
  p_source_id uuid,
  p_copy_id uuid,
  p_expected_user_id uuid
)
RETURNS SETOF purama_ai.creator_agents
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_source purama_ai.creator_agents%ROWTYPE;
  v_copy purama_ai.creator_agents%ROWTYPE;
BEGIN
  IF v_user_id IS NULL OR p_expected_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'Authentication changed or required' USING ERRCODE = '42501';
  END IF;
  IF p_source_id IS NULL OR p_copy_id IS NULL OR p_source_id = p_copy_id THEN
    RAISE EXCEPTION 'Invalid copy request' USING ERRCODE = '22023';
  END IF;

  -- A replay can only return the same caller's copy of the same source.
  SELECT a.* INTO v_copy FROM purama_ai.creator_agents AS a WHERE a.id = p_copy_id;
  IF FOUND THEN
    IF v_copy.user_id = v_user_id AND v_copy.cloned_from = p_source_id THEN
      RETURN NEXT v_copy;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Copy request unavailable' USING ERRCODE = '42501';
  END IF;

  -- Lock the publication state until the copy commits. Revocation and copying
  -- cannot race past this check within a transaction.
  SELECT a.* INTO v_source FROM purama_ai.creator_agents AS a
  WHERE a.id = p_source_id AND a.is_active = true
    AND a.name ~ '[^[:space:]]'
    AND (a.is_public = true OR (a.is_template = true AND a.user_id IS NULL))
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Model unavailable' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO purama_ai.creator_agents (
    id, user_id, name, slug, description, emoji, color, category,
    system_prompt, model, temperature, max_tokens, tools_enabled,
    schedule_enabled, schedule_cron, schedule_input, last_scheduled_run,
    karta_enabled, is_active, is_public, is_template, cloned_from
  ) VALUES (
    p_copy_id, v_user_id, v_source.name, 'copy-' || p_copy_id::text,
    v_source.description, v_source.emoji, v_source.color, v_source.category,
    v_source.system_prompt, v_source.model, v_source.temperature,
    v_source.max_tokens, v_source.tools_enabled,
    false, NULL, NULL, NULL, false, true, false, false, v_source.id
  ) ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_copy;

  IF NOT FOUND THEN
    SELECT a.* INTO v_copy FROM purama_ai.creator_agents AS a
    WHERE a.id = p_copy_id AND a.user_id = v_user_id AND a.cloned_from = p_source_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Copy request unavailable' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEXT v_copy;
END;
$$;
REVOKE ALL ON FUNCTION purama_ai.clone_public_creator_model(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION purama_ai.clone_public_creator_model(uuid, uuid, uuid) TO authenticated;

COMMIT;
