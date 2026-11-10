-- Existing ENTRAIDE contact protocol, executed only by the authenticated Edge
-- adapter's service client. p_actor MUST come from auth.getUser(), never the body.
-- Reuses the original private package's limits: 10/day UTC, 7-day cooldown,
-- 14-day pending lifetime. No new contact engine or public privileged RPC.
BEGIN;

CREATE OR REPLACE FUNCTION purama_ai.entraide_contact_command(
  p_actor uuid,
  p_action text,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.transaction_timestamp();
  v_day_start timestamptz;
  v_id uuid;
  v_target uuid;
  v_message text;
  v_response text;
  v_pair_key integer;
  v_lock_key integer;
  v_count integer;
  v_last_response timestamptz;
  v_request purama_ai.entraide_contact_requests%ROWTYPE;
  v_existing purama_ai.entraide_contact_requests%ROWTYPE;
  v_requests jsonb;
  v_blocked_user_ids jsonb;
  v_uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = p_actor) THEN
    RETURN pg_catalog.jsonb_build_object('error', 'invalid_actor', 'status', 403);
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('list', 'send', 'respond', 'block', 'unblock') THEN
    RETURN pg_catalog.jsonb_build_object('error', 'invalid_action', 'status', 400);
  END IF;
  IF pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RETURN pg_catalog.jsonb_build_object('error', 'invalid_payload', 'status', 400);
  END IF;

  IF p_action = 'list' THEN
    IF p_payload <> '{}'::jsonb THEN
      RETURN pg_catalog.jsonb_build_object('error', 'invalid_payload', 'status', 400);
    END IF;
    -- Other commands take at most one pair lock. Lists acquire every needed pair
    -- in LOCK-KEY order (including hash collisions), so two lists cannot invert
    -- their acquisition order. No sender/request lock is taken after a pair lock.
    FOR v_lock_key IN
      SELECT DISTINCT pg_catalog.hashtext(
        LEAST(r.requester_id::text, r.recipient_id::text) || ':' ||
        GREATEST(r.requester_id::text, r.recipient_id::text)
      ) AS lock_key
      FROM purama_ai.entraide_contact_requests AS r
      WHERE p_actor IN (r.requester_id, r.recipient_id)
        AND r.status = 'pending'
        AND r.created_at <= v_now - interval '336 hours'
      ORDER BY lock_key
    LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(780203, v_lock_key);
    END LOOP;
    UPDATE purama_ai.entraide_contact_requests AS r
      SET status = 'expired', responded_at = r.created_at + interval '336 hours'
      WHERE p_actor IN (r.requester_id, r.recipient_id)
        AND r.status = 'pending'
        AND r.created_at <= v_now - interval '336 hours';
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY r.created_at DESC, r.id), '[]'::jsonb)
      INTO v_requests
      FROM purama_ai.entraide_contact_requests AS r
      WHERE p_actor IN (r.requester_id, r.recipient_id);
    SELECT COALESCE(pg_catalog.jsonb_agg(b.blocked_id ORDER BY b.blocked_id), '[]'::jsonb)
      INTO v_blocked_user_ids FROM purama_ai.entraide_blocages AS b WHERE b.blocker_id = p_actor;
    RETURN pg_catalog.jsonb_build_object('requests', v_requests, 'blocked_user_ids', v_blocked_user_ids);
  END IF;

  IF p_action = 'send' THEN
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) AS k(key)
               WHERE k.key NOT IN ('id', 'recipient_id', 'message'))
      OR pg_catalog.jsonb_typeof(p_payload -> 'id') IS DISTINCT FROM 'string'
      OR NOT ((p_payload ->> 'id') ~* v_uuid_pattern)
      OR pg_catalog.jsonb_typeof(p_payload -> 'recipient_id') IS DISTINCT FROM 'string'
      OR NOT ((p_payload ->> 'recipient_id') ~* v_uuid_pattern)
      OR (p_payload ? 'message' AND pg_catalog.jsonb_typeof(p_payload -> 'message') NOT IN ('string', 'null'))
      OR pg_catalog.char_length(p_payload ->> 'message') > 500
    THEN
      RETURN pg_catalog.jsonb_build_object('error', 'invalid_payload', 'status', 400);
    END IF;
    v_id := (p_payload ->> 'id')::uuid;
    v_target := (p_payload ->> 'recipient_id')::uuid;
    v_message := p_payload ->> 'message';
    IF v_target = p_actor THEN
      RETURN pg_catalog.jsonb_build_object('error', 'self_contact', 'status', 400);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = v_target) THEN
      RETURN pg_catalog.jsonb_build_object('error', 'recipient_not_found', 'status', 404);
    END IF;
    -- Lock hierarchy: immutable request id -> sender's daily capacity -> pair.
    -- Hash collisions only serialize extra work; no reversed hierarchy exists.
    PERFORM pg_catalog.pg_advisory_xact_lock(780201, pg_catalog.hashtext(v_id::text));
    PERFORM pg_catalog.pg_advisory_xact_lock(780202, pg_catalog.hashtext(p_actor::text));
  ELSIF p_action = 'respond' THEN
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) AS k(key)
               WHERE k.key NOT IN ('request_id', 'response'))
      OR pg_catalog.jsonb_typeof(p_payload -> 'request_id') IS DISTINCT FROM 'string'
      OR NOT ((p_payload ->> 'request_id') ~* v_uuid_pattern)
      OR pg_catalog.jsonb_typeof(p_payload -> 'response') IS DISTINCT FROM 'string'
      OR (p_payload ->> 'response') NOT IN ('accept', 'decline', 'block')
    THEN
      RETURN pg_catalog.jsonb_build_object('error', 'invalid_payload', 'status', 400);
    END IF;
    v_id := (p_payload ->> 'request_id')::uuid;
    v_response := p_payload ->> 'response';
    SELECT r.* INTO v_request
      FROM purama_ai.entraide_contact_requests AS r
      WHERE r.id = v_id AND r.recipient_id = p_actor;
    IF NOT FOUND THEN
      -- Same response for a missing id and an id belonging to other parties.
      RETURN pg_catalog.jsonb_build_object('error', 'request_not_found', 'status', 404);
    END IF;
    v_target := v_request.requester_id;
  ELSE
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) AS k(key) WHERE k.key <> 'target_id')
      OR pg_catalog.jsonb_typeof(p_payload -> 'target_id') IS DISTINCT FROM 'string'
      OR NOT ((p_payload ->> 'target_id') ~* v_uuid_pattern)
    THEN
      RETURN pg_catalog.jsonb_build_object('error', 'invalid_payload', 'status', 400);
    END IF;
    v_target := (p_payload ->> 'target_id')::uuid;
    IF v_target = p_actor THEN
      RETURN pg_catalog.jsonb_build_object('error', 'self_contact', 'status', 400);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = v_target) THEN
      RETURN pg_catalog.jsonb_build_object('error', 'recipient_not_found', 'status', 404);
    END IF;
  END IF;

  v_pair_key := pg_catalog.hashtext(
    LEAST(p_actor::text, v_target::text) || ':' || GREATEST(p_actor::text, v_target::text)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(780203, v_pair_key);

  IF p_action = 'send' THEN
    SELECT r.* INTO v_existing FROM purama_ai.entraide_contact_requests AS r WHERE r.id = v_id;
    IF FOUND AND (v_existing.requester_id <> p_actor OR v_existing.recipient_id <> v_target
                  OR v_existing.message IS DISTINCT FROM v_message) THEN
      RETURN pg_catalog.jsonb_build_object('error', 'idempotency_conflict', 'status', 409);
    END IF;
  END IF;

  -- Fixed hours preserve the package's 14 * 24-hour duration across DST changes.
  -- Lazy expiry has a deterministic timestamp, including the exact TTL bound.
  -- Business errors below RETURN rather than RAISE: an expiry is not rolled back
  -- merely because a response is now too late or a new request is refused.
  UPDATE purama_ai.entraide_contact_requests AS r
    SET status = 'expired', responded_at = r.created_at + interval '336 hours'
    WHERE ((r.requester_id = p_actor AND r.recipient_id = v_target)
           OR (r.requester_id = v_target AND r.recipient_id = p_actor))
      AND r.status = 'pending'
      AND r.created_at <= v_now - interval '336 hours';

  IF p_action = 'send' THEN
    IF v_existing.id IS NOT NULL THEN
      SELECT r.* INTO v_request FROM purama_ai.entraide_contact_requests AS r WHERE r.id = v_id;
      RETURN pg_catalog.jsonb_build_object('request', pg_catalog.to_jsonb(v_request));
    END IF;
    IF EXISTS (
      SELECT 1 FROM purama_ai.entraide_blocages AS b
      WHERE (b.blocker_id = p_actor AND b.blocked_id = v_target)
         OR (b.blocker_id = v_target AND b.blocked_id = p_actor)
    ) THEN
      RETURN pg_catalog.jsonb_build_object('error', 'contact_unavailable', 'status', 403);
    END IF;
    IF EXISTS (
      SELECT 1 FROM purama_ai.entraide_contact_requests AS r
      WHERE r.requester_id = p_actor AND r.recipient_id = v_target AND r.status = 'pending'
    ) THEN
      RETURN pg_catalog.jsonb_build_object('error', 'already_pending', 'status', 409);
    END IF;
    v_day_start := pg_catalog.date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    SELECT count(*) INTO v_count FROM purama_ai.entraide_contact_requests AS r
      WHERE r.requester_id = p_actor AND r.created_at >= v_day_start
        AND r.created_at < v_day_start + interval '24 hours';
    IF v_count >= 10 THEN
      RETURN pg_catalog.jsonb_build_object('error', 'daily_limit_reached', 'status', 429);
    END IF;
    IF EXISTS (
      SELECT 1 FROM purama_ai.entraide_contact_requests AS r
      WHERE r.requester_id = p_actor AND r.recipient_id = v_target
        AND r.status IN ('declined', 'expired') AND r.responded_at IS NULL
    ) THEN
      RETURN pg_catalog.jsonb_build_object('error', 'contact_history_unavailable', 'status', 409);
    END IF;
    SELECT max(r.responded_at) INTO v_last_response FROM purama_ai.entraide_contact_requests AS r
      WHERE r.requester_id = p_actor AND r.recipient_id = v_target AND r.status IN ('declined', 'expired');
    IF v_last_response IS NOT NULL AND v_now < v_last_response + interval '168 hours' THEN
      RETURN pg_catalog.jsonb_build_object('error', 'cooldown_active', 'status', 429);
    END IF;
    INSERT INTO purama_ai.entraide_contact_requests (id, requester_id, recipient_id, message, status, created_at)
      VALUES (v_id, p_actor, v_target, v_message, 'pending', v_now)
      RETURNING * INTO v_request;
    RETURN pg_catalog.jsonb_build_object('request', pg_catalog.to_jsonb(v_request));
  END IF;

  IF p_action = 'respond' THEN
    SELECT r.* INTO v_request FROM purama_ai.entraide_contact_requests AS r
      WHERE r.id = v_id AND r.recipient_id = p_actor;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('error', 'request_not_found', 'status', 404);
    END IF;
    IF v_request.status = 'expired' THEN
      RETURN pg_catalog.jsonb_build_object('error', 'request_expired', 'status', 409);
    END IF;
    IF v_request.status <> 'pending' THEN
      RETURN pg_catalog.jsonb_build_object('error', 'request_not_pending', 'status', 409);
    END IF;
    IF v_response <> 'block' THEN
      IF EXISTS (
        SELECT 1 FROM purama_ai.entraide_blocages AS b
        WHERE (b.blocker_id = p_actor AND b.blocked_id = v_target)
           OR (b.blocker_id = v_target AND b.blocked_id = p_actor)
      ) THEN
        RETURN pg_catalog.jsonb_build_object('error', 'contact_unavailable', 'status', 403);
      END IF;
      UPDATE purama_ai.entraide_contact_requests AS r
        SET status = CASE v_response WHEN 'accept' THEN 'accepted' ELSE 'declined' END,
            responded_at = v_now
        WHERE r.id = v_id AND r.recipient_id = p_actor AND r.status = 'pending'
        RETURNING * INTO v_request;
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('error', 'request_not_pending', 'status', 409);
      END IF;
      RETURN pg_catalog.jsonb_build_object('request', pg_catalog.to_jsonb(v_request));
    END IF;
  END IF;

  IF p_action = 'unblock' THEN
    DELETE FROM purama_ai.entraide_blocages AS b WHERE b.blocker_id = p_actor AND b.blocked_id = v_target;
    -- Unblocking never restores a previous acceptance or revives a closed request.
    RETURN pg_catalog.jsonb_build_object('ok', true);
  END IF;

  -- Both direct block and a pending request's block response use this transaction.
  -- Do not catch storage errors: a failed insert/update must roll back the whole
  -- command, rather than acknowledge a block that was not persisted.
  INSERT INTO purama_ai.entraide_blocages (blocker_id, blocked_id, created_at)
    VALUES (p_actor, v_target, v_now) ON CONFLICT (blocker_id, blocked_id) DO NOTHING;
  UPDATE purama_ai.entraide_contact_requests AS r
    SET status = 'blocked', responded_at = v_now
    WHERE ((r.requester_id = p_actor AND r.recipient_id = v_target)
           OR (r.requester_id = v_target AND r.recipient_id = p_actor))
      AND r.status IN ('pending', 'accepted');
  IF p_action = 'respond' THEN
    SELECT r.* INTO v_request FROM purama_ai.entraide_contact_requests AS r WHERE r.id = v_id;
    RETURN pg_catalog.jsonb_build_object('request', pg_catalog.to_jsonb(v_request));
  END IF;
  RETURN pg_catalog.jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION purama_ai.entraide_contact_command(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.entraide_contact_command(uuid, text, jsonb) TO service_role;

-- Writes must pass through the pair lock so send/respond cannot race a raw block.
-- Self-only reads retain the existing RLS policy. Service privileges are unchanged.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON purama_ai.entraide_blocages, purama_ai.entraide_contact_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON purama_ai.entraide_blocages, purama_ai.entraide_contact_requests TO authenticated;

COMMIT;
