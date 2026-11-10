-- Collective missions use the existing ENTRAIDE tables and state machine.
-- Applying this migration classifies ALL pre-existing missions as private:
-- adding the column with this default is intentional, not a public-data backfill.
-- Coordinate the API rollout with this read-permission change. This file was
-- authored/tested in an isolated database; no production migration was executed.

-- Pending-install bridge only. The additive 022000 migration carries the new
-- protocol for already-applied #23 databases. A recognized #17 definer is retired
-- here so this original schema migration can proceed; unknown sources fail closed.
DO $transition$
DECLARE
  v_legacy oid := pg_catalog.to_regprocedure('purama_ai.entraide_mission_mutate(uuid,text,uuid,jsonb,bigint)');
BEGIN
  IF v_legacy IS NULL THEN
    IF pg_catalog.to_regclass('purama_ai.entraide_mission_requests') IS NOT NULL
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid = 'purama_ai.missions_collectives'::regclass
                    AND attname = 'version' AND NOT attisdropped) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'entraide_missions_reconciliation_required';
    END IF;
    RETURN;
  END IF;

  -- Exact source from #17, plus its authority and storage shape. A locally
  -- altered/unknown RPC must be reviewed, not automatically removed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = v_legacy AND p.prosecdef
      AND p.prorettype = 'jsonb'::regtype AND p.proconfig = ARRAY['search_path=""']
      AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') =
        'f196ea13a6460a7985eddbfd6c604d458388a86b96d934751e6dee0c17906b40'
  ) OR pg_catalog.to_regclass('purama_ai.entraide_mission_requests') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'purama_ai.missions_collectives'::regclass
        AND attname = 'version' AND atttypid = 'bigint'::regtype AND attnotnull AND NOT attisdropped)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'purama_ai.missions_collectives'::regclass
        AND attname IN ('revision', 'visibility', 'initial_visibility') AND NOT attisdropped) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'entraide_missions_reconciliation_required';
  END IF;

  LOCK TABLE purama_ai.entraide_mission_requests,
    purama_ai.missions_collectives,
    purama_ai.missions_collectives_participants IN ACCESS EXCLUSIVE MODE;
  IF (SELECT pg_catalog.array_agg(attname::text ORDER BY attnum)
      FROM pg_catalog.pg_attribute
      WHERE attrelid = 'purama_ai.entraide_mission_requests'::regclass
        AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM
       ARRAY['actor_id','request_id','action','mission_id','payload','expected_version','response','created_at']
     OR EXISTS (SELECT 1 FROM purama_ai.entraide_mission_requests
       WHERE response IS NULL OR pg_catalog.jsonb_typeof(response->'mission') IS DISTINCT FROM 'object'
         OR COALESCE(response#>>'{mission,id}', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         OR action NOT IN ('create','join','leave','start','complete','cancel')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'entraide_missions_reconciliation_required';
  END IF;

  -- The old definer cannot remain callable: its reads/replays bypass privacy.
  -- Historical request identities, responses, timestamps and members survive.
  DROP FUNCTION purama_ai.entraide_mission_mutate(uuid,text,uuid,jsonb,bigint);
  COMMENT ON TABLE purama_ai.entraide_mission_requests IS
    'entraide:pr17-retired:0660d23c28e48ac0522725546848b0c842202708';
END;
$transition$;

ALTER TABLE purama_ai.missions_collectives
  ADD COLUMN revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN visibility text NOT NULL DEFAULT 'private',
  -- Creation input remains stable when publish/unpublish changes visibility.
  -- This internal value is never updated by the command or exposed in its DTO.
  ADD COLUMN initial_visibility text NOT NULL DEFAULT 'private',
  ADD CONSTRAINT missions_collectives_revision_nonnegative CHECK (revision >= 0),
  ADD CONSTRAINT missions_collectives_visibility_valid CHECK (visibility IN ('private', 'public')),
  ADD CONSTRAINT missions_collectives_initial_visibility_valid CHECK (initial_visibility IN ('private', 'public'));

-- The historical SELECT policies allow every row. Browser reads must therefore
-- use the authenticated application API, which passes its verified actor to the
-- service-only command below. No browser-provided organizer/participant list is
-- ever authoritative, and the existing participant table is never rewritten.
REVOKE SELECT ON purama_ai.missions_collectives,
                 purama_ai.missions_collectives_participants
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION purama_ai.entraide_mission_command(
  p_actor uuid,
  p_action text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $command$
DECLARE
  v_mission purama_ai.missions_collectives%ROWTYPE;
  v_id uuid;
  v_title text;
  v_description text;
  v_visibility text;
  v_min integer;
  v_max integer;
  v_numeric numeric;
  v_expected bigint;
  v_count bigint;
  v_member boolean;
  v_inserted boolean;
  v_allowed text[];
  v_result jsonb;
BEGIN
  -- The edge handler must obtain this actor from verified authentication, never
  -- from a client payload. The SQL function itself is not executable by clients.
  IF p_actor IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('error', 'authentication_required', 'status', 403);
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('list', 'get', 'create', 'join', 'leave', 'start', 'complete', 'cancel', 'publish', 'unpublish') THEN
    RETURN pg_catalog.jsonb_build_object('error', 'invalid_action', 'status', 400);
  END IF;
  IF pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RETURN pg_catalog.jsonb_build_object('error', 'invalid_payload', 'status', 400);
  END IF;

  v_allowed := CASE p_action
    WHEN 'list' THEN ARRAY[]::text[]
    WHEN 'get' THEN ARRAY['mission_id']::text[]
    WHEN 'create' THEN ARRAY['id', 'title', 'description', 'min_participants', 'max_participants', 'visibility']::text[]
    ELSE ARRAY['mission_id', 'expected_revision']::text[]
  END;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) AS supplied(key)
             WHERE supplied.key <> ALL(v_allowed)) THEN
    RETURN pg_catalog.jsonb_build_object('error', 'unsupported_field', 'status', 400);
  END IF;

  IF p_action = 'list' THEN
    SELECT COALESCE(pg_catalog.jsonb_agg(document ORDER BY created_at DESC, id), '[]'::jsonb)
      INTO v_result
      FROM (
        SELECT m.id, m.created_at,
               (pg_catalog.to_jsonb(m) - 'initial_visibility') || pg_catalog.jsonb_build_object(
                 'missions_collectives_participants',
                 COALESCE((
                   SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                     'user_id', member.user_id, 'joined_at', member.joined_at
                   ) ORDER BY member.joined_at, member.user_id)
                   FROM purama_ai.missions_collectives_participants AS member
                   WHERE member.mission_id = m.id
                 ), '[]'::jsonb)
               ) AS document
        FROM purama_ai.missions_collectives AS m
        WHERE m.visibility = 'public' OR m.organizer_id = p_actor
           OR EXISTS (SELECT 1 FROM purama_ai.missions_collectives_participants AS mine
                      WHERE mine.mission_id = m.id AND mine.user_id = p_actor)
      ) AS visible;
    RETURN pg_catalog.jsonb_build_object('missions', v_result);
  END IF;

  IF p_action = 'create' THEN
    IF pg_catalog.jsonb_typeof(p_payload->'id') IS DISTINCT FROM 'string'
       OR (p_payload->>'id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR pg_catalog.jsonb_typeof(p_payload->'title') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(p_payload->'min_participants') IS DISTINCT FROM 'number' THEN
      RETURN pg_catalog.jsonb_build_object('error', 'invalid_payload', 'status', 400);
    END IF;
    v_id := (p_payload->>'id')::uuid;
    v_title := pg_catalog.btrim(p_payload->>'title');
    IF pg_catalog.length(v_title) < 1 OR pg_catalog.length(v_title) > 200 THEN
      RETURN pg_catalog.jsonb_build_object('error', 'invalid_title', 'status', 400);
    END IF;
    IF p_payload ? 'description' AND pg_catalog.jsonb_typeof(p_payload->'description') IS DISTINCT FROM 'string' THEN
      RETURN pg_catalog.jsonb_build_object('error', 'invalid_description', 'status', 400);
    END IF;
    v_description := COALESCE(p_payload->>'description', '');
    IF pg_catalog.length(v_description) > 10000 THEN
      RETURN pg_catalog.jsonb_build_object('error', 'invalid_description', 'status', 400);
    END IF;
    IF p_payload ? 'visibility' AND pg_catalog.jsonb_typeof(p_payload->'visibility') IS DISTINCT FROM 'string' THEN
      RETURN pg_catalog.jsonb_build_object('error', 'invalid_visibility', 'status', 400);
    END IF;
    v_visibility := COALESCE(p_payload->>'visibility', 'private');
    IF v_visibility NOT IN ('private', 'public') THEN
      RETURN pg_catalog.jsonb_build_object('error', 'invalid_visibility', 'status', 400);
    END IF;
    v_numeric := (p_payload->>'min_participants')::numeric;
    IF v_numeric <> pg_catalog.trunc(v_numeric) OR v_numeric < 2 OR v_numeric > 2147483647 THEN
      RETURN pg_catalog.jsonb_build_object('error', 'min_participants_below_collective_threshold', 'status', 400);
    END IF;
    v_min := v_numeric::integer;
    v_max := NULL;
    IF p_payload ? 'max_participants' AND p_payload->'max_participants' <> 'null'::jsonb THEN
      IF pg_catalog.jsonb_typeof(p_payload->'max_participants') IS DISTINCT FROM 'number' THEN
        RETURN pg_catalog.jsonb_build_object('error', 'invalid_max_participants', 'status', 400);
      END IF;
      v_numeric := (p_payload->>'max_participants')::numeric;
      IF v_numeric <> pg_catalog.trunc(v_numeric) OR v_numeric < v_min OR v_numeric > 2147483647 THEN
        RETURN pg_catalog.jsonb_build_object('error', 'max_participants_below_min', 'status', 400);
      END IF;
      v_max := v_numeric::integer;
    END IF;

    -- A stable client command ID cannot create a second mission after a timeout.
    -- Unique-key contention is resolved by PostgreSQL before inspecting the row.
    INSERT INTO purama_ai.missions_collectives
      (id, organizer_id, title, description, min_participants, max_participants, status, visibility, initial_visibility)
    VALUES (v_id, p_actor, v_title, v_description, v_min, v_max, 'ouverte', v_visibility, v_visibility)
    ON CONFLICT (id) DO NOTHING
    RETURNING * INTO v_mission;
    v_inserted := FOUND;
    IF NOT v_inserted THEN
      SELECT * INTO v_mission FROM purama_ai.missions_collectives WHERE id = v_id FOR UPDATE;
      IF NOT FOUND OR v_mission.organizer_id <> p_actor
         OR v_mission.title <> v_title OR v_mission.description <> v_description
         OR v_mission.min_participants <> v_min OR v_mission.max_participants IS DISTINCT FROM v_max
         OR v_mission.initial_visibility <> v_visibility THEN
        RETURN pg_catalog.jsonb_build_object('error', 'create_conflict', 'status', 409);
      END IF;
    ELSE
      -- This insert and the parent insert are one transaction. A failed FK or
      -- other exception rolls both back; no mission without its organizer leaks.
      INSERT INTO purama_ai.missions_collectives_participants (mission_id, user_id)
      VALUES (v_id, p_actor);
    END IF;
  ELSE
    IF pg_catalog.jsonb_typeof(p_payload->'mission_id') IS DISTINCT FROM 'string'
       OR (p_payload->>'mission_id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RETURN pg_catalog.jsonb_build_object('error', 'invalid_mission_id', 'status', 400);
    END IF;
    v_id := (p_payload->>'mission_id')::uuid;

    IF p_action = 'get' THEN
      -- Permission and contents use one snapshot. Missing and inaccessible private
      -- missions deliberately have the same result.
      SELECT (pg_catalog.to_jsonb(m) - 'initial_visibility') || pg_catalog.jsonb_build_object(
               'missions_collectives_participants',
               COALESCE((
                 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                   'user_id', member.user_id, 'joined_at', member.joined_at
                 ) ORDER BY member.joined_at, member.user_id)
                 FROM purama_ai.missions_collectives_participants AS member
                 WHERE member.mission_id = m.id
               ), '[]'::jsonb)
             )
        INTO v_result
        FROM purama_ai.missions_collectives AS m
        WHERE m.id = v_id AND (m.visibility = 'public' OR m.organizer_id = p_actor
          OR EXISTS (SELECT 1 FROM purama_ai.missions_collectives_participants AS mine
                     WHERE mine.mission_id = m.id AND mine.user_id = p_actor));
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('error', 'mission_not_found', 'status', 404);
      END IF;
      RETURN pg_catalog.jsonb_build_object('mission', v_result);
    END IF;

    IF p_payload ? 'expected_revision' THEN
      IF pg_catalog.jsonb_typeof(p_payload->'expected_revision') IS DISTINCT FROM 'number' THEN
        RETURN pg_catalog.jsonb_build_object('error', 'invalid_revision', 'status', 400);
      END IF;
      v_numeric := (p_payload->>'expected_revision')::numeric;
      IF v_numeric <> pg_catalog.trunc(v_numeric) OR v_numeric < 0 OR v_numeric > 9223372036854775807 THEN
        RETURN pg_catalog.jsonb_build_object('error', 'invalid_revision', 'status', 400);
      END IF;
      v_expected := v_numeric::bigint;
    END IF;

    -- All writers lock the same parent row before reading membership, capacity,
    -- status or revision. No whole-list delete/reinsert is used on participants.
    SELECT * INTO v_mission FROM purama_ai.missions_collectives WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('error', 'mission_not_found', 'status', 404);
    END IF;
    SELECT EXISTS (SELECT 1 FROM purama_ai.missions_collectives_participants
                   WHERE mission_id = v_id AND user_id = p_actor) INTO v_member;
    IF v_mission.visibility = 'private' AND v_mission.organizer_id <> p_actor AND NOT v_member THEN
      RETURN pg_catalog.jsonb_build_object('error', 'mission_not_found', 'status', 404);
    END IF;

    IF p_action IN ('start', 'complete', 'cancel', 'publish', 'unpublish') THEN
      IF v_mission.organizer_id <> p_actor THEN
        RETURN pg_catalog.jsonb_build_object('error', 'organizer_only', 'status', 403);
      END IF;
      IF v_expected IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('error', 'expected_revision_required', 'status', 400);
      END IF;
    END IF;

    IF p_action = 'join' AND v_mission.visibility <> 'public' THEN
      RETURN pg_catalog.jsonb_build_object('error', 'private_join_not_available', 'status', 403);
    END IF;
    IF p_action = 'leave' AND v_mission.status NOT IN ('terminee', 'annulee') AND v_mission.organizer_id = p_actor THEN
      RETURN pg_catalog.jsonb_build_object('error', 'organizer_must_cancel', 'status', 409);
    END IF;
    IF p_action IN ('publish', 'unpublish') AND v_mission.status NOT IN ('ouverte', 'prete') THEN
      RETURN pg_catalog.jsonb_build_object('error', 'mission_not_recruiting', 'status', 409);
    END IF;

    -- Idempotent membership retries return the current visible state without
    -- consuming a place or incrementing revision, even with an old optional
    -- revision. A former private participant loses read access after leaving:
    -- a subsequent retry receives the same generic 404 as other non-members.
    IF (p_action = 'join' AND v_member) OR (p_action = 'leave' AND NOT v_member)
       OR (p_action = 'publish' AND v_mission.visibility = 'public')
       OR (p_action = 'unpublish' AND v_mission.visibility = 'private') THEN
      NULL;
    ELSE
      IF v_expected IS NOT NULL AND v_expected <> v_mission.revision THEN
        RETURN pg_catalog.jsonb_build_object('error', 'revision_conflict', 'status', 409);
      END IF;
      IF v_mission.revision = 9223372036854775807 THEN
        RETURN pg_catalog.jsonb_build_object('error', 'revision_exhausted', 'status', 409);
      END IF;

      IF p_action = 'join' THEN
        IF v_mission.status NOT IN ('ouverte', 'prete') THEN
          RETURN pg_catalog.jsonb_build_object('error', 'mission_not_recruiting', 'status', 409);
        END IF;
        SELECT pg_catalog.count(*) INTO v_count FROM purama_ai.missions_collectives_participants WHERE mission_id = v_id;
        IF v_mission.max_participants IS NOT NULL AND v_count >= v_mission.max_participants THEN
          RETURN pg_catalog.jsonb_build_object('error', 'mission_full', 'status', 409);
        END IF;
        INSERT INTO purama_ai.missions_collectives_participants (mission_id, user_id) VALUES (v_id, p_actor);
        v_count := v_count + 1;
        IF v_mission.status = 'ouverte' AND v_count >= v_mission.min_participants THEN
          v_mission.status := 'prete';
        END IF;
      ELSIF p_action = 'leave' THEN
        IF v_mission.status IN ('terminee', 'annulee') THEN
          RETURN pg_catalog.jsonb_build_object('error', 'mission_closed', 'status', 409);
        END IF;
        DELETE FROM purama_ai.missions_collectives_participants WHERE mission_id = v_id AND user_id = p_actor;
        SELECT pg_catalog.count(*) INTO v_count FROM purama_ai.missions_collectives_participants WHERE mission_id = v_id;
        IF v_mission.status = 'prete' AND v_count < v_mission.min_participants THEN
          v_mission.status := 'ouverte';
        ELSIF v_mission.status = 'ouverte' AND v_count >= v_mission.min_participants THEN
          v_mission.status := 'prete';
        END IF;
        -- An en_cours mission stays en_cours after a departure, matching the
        -- canonical pure library. Only the organizer can explicitly cancel it.
      ELSIF p_action = 'start' THEN
        IF v_mission.status <> 'prete' THEN
          RETURN pg_catalog.jsonb_build_object('error', 'not_ready', 'status', 409);
        END IF;
        SELECT pg_catalog.count(*) INTO v_count FROM purama_ai.missions_collectives_participants WHERE mission_id = v_id;
        IF v_count < v_mission.min_participants THEN
          RETURN pg_catalog.jsonb_build_object('error', 'not_ready', 'status', 409);
        END IF;
        v_mission.status := 'en_cours';
      ELSIF p_action = 'complete' THEN
        IF v_mission.status <> 'en_cours' THEN
          RETURN pg_catalog.jsonb_build_object('error', 'not_in_progress', 'status', 409);
        END IF;
        -- This records the organizer's declaration, not independent verification
        -- of a real-world outcome, acceptance by others, or any payment.
        v_mission.status := 'terminee';
      ELSIF p_action = 'cancel' THEN
        IF v_mission.status IN ('terminee', 'annulee') THEN
          RETURN pg_catalog.jsonb_build_object('error', 'already_closed', 'status', 409);
        END IF;
        v_mission.status := 'annulee';
      ELSIF p_action = 'publish' THEN
        v_mission.visibility := 'public';
      ELSIF p_action = 'unpublish' THEN
        v_mission.visibility := 'private';
      END IF;

      UPDATE purama_ai.missions_collectives
        SET status = v_mission.status, visibility = v_mission.visibility,
            revision = revision + 1, updated_at = pg_catalog.clock_timestamp()
        WHERE id = v_id
        RETURNING * INTO v_mission;
    END IF;
  END IF;

  SELECT (pg_catalog.to_jsonb(m) - 'initial_visibility') || pg_catalog.jsonb_build_object(
           'missions_collectives_participants',
           COALESCE((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'user_id', member.user_id, 'joined_at', member.joined_at
             ) ORDER BY member.joined_at, member.user_id)
             FROM purama_ai.missions_collectives_participants AS member
             WHERE member.mission_id = m.id
           ), '[]'::jsonb)
         ) INTO v_result
    FROM purama_ai.missions_collectives AS m WHERE m.id = v_id;
  RETURN pg_catalog.jsonb_build_object('mission', v_result);
EXCEPTION
  -- An exception rolls back all statements of this command's block, including
  -- parent/participant creation. No raw SQL detail or private identifier escapes.
  WHEN foreign_key_violation THEN
    RETURN pg_catalog.jsonb_build_object('error', 'actor_not_found', 'status', 403);
  WHEN unique_violation THEN
    RETURN pg_catalog.jsonb_build_object('error', 'conflict', 'status', 409);
  WHEN invalid_text_representation OR numeric_value_out_of_range OR check_violation THEN
    RETURN pg_catalog.jsonb_build_object('error', 'invalid_payload', 'status', 400);
END;
$command$;

REVOKE ALL ON FUNCTION purama_ai.entraide_mission_command(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA purama_ai TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.entraide_mission_command(uuid, text, jsonb) TO service_role;

COMMENT ON FUNCTION purama_ai.entraide_mission_command(uuid, text, jsonb) IS
  'Service-only, SECURITY INVOKER collective-mission commands. p_actor must come from verified authentication. terminee is an organizer declaration, not verified delivery or payment.';
