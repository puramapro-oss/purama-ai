-- Additive canonical protocol upgrade. Runs after 021000 on fresh installs,
-- after its source-checked #17 bridge, OR alone when #23 was already applied.
-- Historical 021000 is never replayed on an existing #23 installation.
DO $upgrade$
DECLARE
  v_digest text;
  v_registry regclass := pg_catalog.to_regclass('purama_ai.entraide_mission_requests');
  v_legacy boolean;
  v_columns text[];
BEGIN
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
    INTO v_digest FROM pg_catalog.pg_proc p
    WHERE p.oid = pg_catalog.to_regprocedure('purama_ai.entraide_mission_command(uuid,text,jsonb)')
      AND NOT p.prosecdef AND p.prorettype = 'jsonb'::regtype AND p.proconfig = ARRAY['search_path=""'];
  IF v_digest IS NULL OR v_digest NOT IN (
    '4699b943a2bbffe7da7310832f15c479d96149ec72f80642efcc6745fffb0edc',
    'c12fc09b1831b3bd5c6c40c25fad8d90d0b844f5d0ab22d280c950ba823df08a'
  ) OR pg_catalog.to_regprocedure('purama_ai.entraide_mission_mutate(uuid,text,uuid,jsonb,bigint)') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'entraide_missions_reconciliation_required';
  END IF;
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'purama_ai.missions_collectives'::regclass
      AND attname = 'version' AND NOT attisdropped) INTO v_legacy;

  IF v_registry IS NOT NULL THEN
    LOCK TABLE purama_ai.entraide_mission_requests IN ACCESS EXCLUSIVE MODE;
    SELECT pg_catalog.array_agg(attname::text ORDER BY attnum) INTO v_columns
      FROM pg_catalog.pg_attribute WHERE attrelid = v_registry
        AND attnum > 0 AND NOT attisdropped;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = v_registry AND contype = 'p' AND conkey = ARRAY[1,2]::smallint[]) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'entraide_missions_reconciliation_required';
    END IF;
  END IF;

  IF v_legacy THEN
    IF v_registry IS NULL
      OR pg_catalog.obj_description(v_registry, 'pg_class') IS DISTINCT FROM
        'entraide:pr17-retired:0660d23c28e48ac0522725546848b0c842202708'
      OR v_digest <> '4699b943a2bbffe7da7310832f15c479d96149ec72f80642efcc6745fffb0edc'
      OR v_columns IS DISTINCT FROM ARRAY['actor_id','request_id','action','mission_id','payload','expected_version','response','created_at'] THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'entraide_missions_reconciliation_required';
    END IF;
    LOCK TABLE purama_ai.missions_collectives,
      purama_ai.missions_collectives_participants IN ACCESS EXCLUSIVE MODE;
    -- No new-protocol write may be interleaved before the counter conversion.
    IF EXISTS (SELECT 1 FROM purama_ai.missions_collectives WHERE revision <> 0 OR version < 1)
       OR EXISTS (SELECT 1 FROM purama_ai.entraide_mission_requests
         WHERE response IS NULL OR expected_version < 1
           OR pg_catalog.jsonb_typeof(payload) IS DISTINCT FROM 'object'
           OR pg_catalog.jsonb_typeof(response->'mission') IS DISTINCT FROM 'object'
           OR COALESCE(response#>>'{mission,id}', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           OR action NOT IN ('create','join','leave','start','complete','cancel')) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'entraide_missions_reconciliation_required';
    END IF;
    UPDATE purama_ai.missions_collectives SET revision = version - 1;
    ALTER TABLE purama_ai.missions_collectives DROP COLUMN version;
    ALTER TABLE purama_ai.entraide_mission_requests RENAME COLUMN expected_version TO expected_revision;
    UPDATE purama_ai.entraide_mission_requests
      SET expected_revision = expected_revision - 1,
          payload = CASE WHEN action = 'create' THEN pg_catalog.jsonb_build_object(
            'id', request_id, 'title', pg_catalog.btrim(payload->>'title'),
            'description', payload->>'description', 'min_participants', payload->'min_participants',
            'max_participants', payload->'max_participants', 'visibility', 'private'
          ) ELSE payload END;
  ELSIF v_registry IS NOT NULL THEN
    -- Reapplying this known upgrade is safe. An unrelated pre-existing registry
    -- or altered authority is never silently adopted, even if its name matches.
    IF pg_catalog.obj_description(v_registry, 'pg_class') IS DISTINCT FROM
         'entraide:mission-requests:v2:20261110022000'
       OR v_columns IS DISTINCT FROM ARRAY['actor_id','request_id','action','mission_id','payload','expected_revision','response','created_at'] THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'entraide_missions_reconciliation_required';
    END IF;
  ELSIF v_digest <> '4699b943a2bbffe7da7310832f15c479d96149ec72f80642efcc6745fffb0edc' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'entraide_missions_reconciliation_required';
  END IF;
END;
$upgrade$;

-- Same actor/request identity as #17. Its explicit transition preserves old
-- receipts; fresh installations create the same canonical registry here.
CREATE TABLE IF NOT EXISTS purama_ai.entraide_mission_requests (
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  action text NOT NULL,
  mission_id uuid,
  payload jsonb NOT NULL,
  expected_revision bigint,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, request_id)
);
COMMENT ON TABLE purama_ai.entraide_mission_requests IS 'entraide:mission-requests:v2:20261110022000';
ALTER TABLE purama_ai.entraide_mission_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.entraide_mission_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON purama_ai.entraide_mission_requests TO service_role;

CREATE OR REPLACE FUNCTION purama_ai.entraide_mission_command(
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
  v_request_id uuid;
  v_request purama_ai.entraide_mission_requests%ROWTYPE;
  v_request_payload jsonb;
  v_request_mission uuid;
BEGIN
  -- The edge handler must obtain this actor from verified authentication, never
  -- from a client payload. The SQL function itself is not executable by clients.
  IF p_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0403', MESSAGE = 'authentication_required';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('list', 'get', 'create', 'join', 'leave', 'start', 'complete', 'cancel', 'publish', 'unpublish') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_action';
  END IF;
  IF pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_payload';
  END IF;

  v_allowed := CASE p_action
    WHEN 'list' THEN ARRAY[]::text[]
    WHEN 'get' THEN ARRAY['mission_id']::text[]
    WHEN 'create' THEN ARRAY['id', 'title', 'description', 'min_participants', 'max_participants', 'visibility', 'request_id']::text[]
    ELSE ARRAY['mission_id', 'expected_revision', 'request_id']::text[]
  END;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) AS supplied(key)
             WHERE supplied.key <> ALL(v_allowed)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'unsupported_field';
  END IF;

  IF p_payload ? 'expected_revision' THEN
    IF pg_catalog.jsonb_typeof(p_payload->'expected_revision') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_revision';
    END IF;
    v_numeric := (p_payload->>'expected_revision')::numeric;
    IF v_numeric <> pg_catalog.trunc(v_numeric) OR v_numeric < 0 OR v_numeric > 9223372036854775807 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_revision';
    END IF;
    v_expected := v_numeric::bigint;
  END IF;
  IF p_payload ? 'request_id' THEN
    IF pg_catalog.jsonb_typeof(p_payload->'request_id') IS DISTINCT FROM 'string'
       OR (p_payload->>'request_id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_request_id';
    END IF;
    v_request_id := (p_payload->>'request_id')::uuid;
    v_request_mission := (p_payload->>'mission_id')::uuid;
    v_request_payload := p_payload - 'request_id' - 'mission_id' - 'expected_revision';
    IF p_action = 'create' THEN
      -- Normalize the accepted defaults exactly as the legacy bridge does.
      v_request_payload := v_request_payload || pg_catalog.jsonb_build_object(
        'title', pg_catalog.btrim(p_payload->>'title'),
        'description', COALESCE(p_payload->>'description', ''),
        'max_participants', p_payload->'max_participants',
        'visibility', COALESCE(p_payload->>'visibility', 'private'));
    END IF;
    INSERT INTO purama_ai.entraide_mission_requests
      (actor_id, request_id, action, mission_id, payload, expected_revision)
    VALUES (p_actor, v_request_id, p_action, v_request_mission, v_request_payload, v_expected)
    ON CONFLICT (actor_id, request_id) DO NOTHING;
    SELECT * INTO STRICT v_request FROM purama_ai.entraide_mission_requests
      WHERE actor_id = p_actor AND request_id = v_request_id FOR UPDATE;
    IF v_request.action IS DISTINCT FROM p_action
       OR v_request.mission_id IS DISTINCT FROM v_request_mission
       OR v_request.payload IS DISTINCT FROM v_request_payload
       OR v_request.expected_revision IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'request_id_conflict';
    END IF;
    IF v_request.response IS NOT NULL THEN
      -- A receipt proves the effect already committed, not a permanent right to
      -- historical private content. Re-read current state through the same ACL.
      -- This also avoids undoing a newer client snapshot with an old response.
      v_result := purama_ai.entraide_mission_command(p_actor, 'get',
        pg_catalog.jsonb_build_object('mission_id', v_request.response#>>'{mission,id}'));
      IF v_result ? 'error' THEN RETURN v_result; END IF;
      RETURN v_result || pg_catalog.jsonb_build_object('replayed', true);
    END IF;
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
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_payload';
    END IF;
    v_id := (p_payload->>'id')::uuid;
    v_title := pg_catalog.btrim(p_payload->>'title');
    IF pg_catalog.length(v_title) < 1 OR pg_catalog.length(v_title) > 200 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_title';
    END IF;
    IF p_payload ? 'description' AND pg_catalog.jsonb_typeof(p_payload->'description') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_description';
    END IF;
    v_description := COALESCE(p_payload->>'description', '');
    IF pg_catalog.length(v_description) > 10000 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_description';
    END IF;
    IF p_payload ? 'visibility' AND pg_catalog.jsonb_typeof(p_payload->'visibility') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_visibility';
    END IF;
    v_visibility := COALESCE(p_payload->>'visibility', 'private');
    IF v_visibility NOT IN ('private', 'public') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_visibility';
    END IF;
    v_numeric := (p_payload->>'min_participants')::numeric;
    IF v_numeric <> pg_catalog.trunc(v_numeric) OR v_numeric < 2 OR v_numeric > 2147483647 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'min_participants_below_collective_threshold';
    END IF;
    v_min := v_numeric::integer;
    v_max := NULL;
    IF p_payload ? 'max_participants' AND p_payload->'max_participants' <> 'null'::jsonb THEN
      IF pg_catalog.jsonb_typeof(p_payload->'max_participants') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_max_participants';
      END IF;
      v_numeric := (p_payload->>'max_participants')::numeric;
      IF v_numeric <> pg_catalog.trunc(v_numeric) OR v_numeric < v_min OR v_numeric > 2147483647 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'max_participants_below_min';
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
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'create_conflict';
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
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'invalid_mission_id';
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
        RAISE EXCEPTION USING ERRCODE = 'P0404', MESSAGE = 'mission_not_found';
      END IF;
      RETURN pg_catalog.jsonb_build_object('mission', v_result);
    END IF;

    -- All writers lock the same parent row before reading membership, capacity,
    -- status or revision. No whole-list delete/reinsert is used on participants.
    SELECT * INTO v_mission FROM purama_ai.missions_collectives WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0404', MESSAGE = 'mission_not_found';
    END IF;
    SELECT EXISTS (SELECT 1 FROM purama_ai.missions_collectives_participants
                   WHERE mission_id = v_id AND user_id = p_actor) INTO v_member;
    IF v_mission.visibility = 'private' AND v_mission.organizer_id <> p_actor AND NOT v_member THEN
      RAISE EXCEPTION USING ERRCODE = 'P0404', MESSAGE = 'mission_not_found';
    END IF;

    IF p_action IN ('start', 'complete', 'cancel', 'publish', 'unpublish') THEN
      IF v_mission.organizer_id <> p_actor THEN
        RAISE EXCEPTION USING ERRCODE = 'P0403', MESSAGE = 'organizer_only';
      END IF;
      IF v_expected IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'expected_revision_required';
      END IF;
    END IF;

    IF p_action = 'join' AND v_mission.visibility <> 'public' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0403', MESSAGE = 'private_join_not_available';
    END IF;
    IF p_action = 'leave' AND v_mission.status NOT IN ('terminee', 'annulee') AND v_mission.organizer_id = p_actor THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'organizer_must_cancel';
    END IF;
    IF p_action IN ('publish', 'unpublish') AND v_mission.status NOT IN ('ouverte', 'prete') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'mission_not_recruiting';
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
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'revision_conflict';
      END IF;
      IF v_mission.revision = 9223372036854775807 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'revision_exhausted';
      END IF;

      IF p_action = 'join' THEN
        IF v_mission.status NOT IN ('ouverte', 'prete') THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'mission_not_recruiting';
        END IF;
        SELECT pg_catalog.count(*) INTO v_count FROM purama_ai.missions_collectives_participants WHERE mission_id = v_id;
        IF v_mission.max_participants IS NOT NULL AND v_count >= v_mission.max_participants THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'mission_full';
        END IF;
        INSERT INTO purama_ai.missions_collectives_participants (mission_id, user_id) VALUES (v_id, p_actor);
        v_count := v_count + 1;
        IF v_mission.status = 'ouverte' AND v_count >= v_mission.min_participants THEN
          v_mission.status := 'prete';
        END IF;
      ELSIF p_action = 'leave' THEN
        IF v_mission.status IN ('terminee', 'annulee') THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'mission_closed';
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
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'not_ready';
        END IF;
        SELECT pg_catalog.count(*) INTO v_count FROM purama_ai.missions_collectives_participants WHERE mission_id = v_id;
        IF v_count < v_mission.min_participants THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'not_ready';
        END IF;
        v_mission.status := 'en_cours';
      ELSIF p_action = 'complete' THEN
        IF v_mission.status <> 'en_cours' THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'not_in_progress';
        END IF;
        -- This records the organizer's declaration, not independent verification
        -- of a real-world outcome, acceptance by others, or any payment.
        v_mission.status := 'terminee';
      ELSIF p_action = 'cancel' THEN
        IF v_mission.status IN ('terminee', 'annulee') THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'already_closed';
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
  v_result := pg_catalog.jsonb_build_object('mission', v_result);
  IF v_request_id IS NOT NULL THEN
    UPDATE purama_ai.entraide_mission_requests SET response = v_result
      WHERE actor_id = p_actor AND request_id = v_request_id;
    RETURN v_result || pg_catalog.jsonb_build_object('replayed', false);
  END IF;
  RETURN v_result;
EXCEPTION
  -- An exception rolls back all statements of this command's block, including
  -- parent/participant creation. No raw SQL detail or private identifier escapes.
  WHEN SQLSTATE 'P0400' OR SQLSTATE 'P0403' OR SQLSTATE 'P0404' OR SQLSTATE 'P0409' THEN
    RETURN pg_catalog.jsonb_build_object('error', SQLERRM, 'status', pg_catalog.right(SQLSTATE, 3)::integer);
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
