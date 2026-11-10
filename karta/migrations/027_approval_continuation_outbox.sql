-- Canonical continuation protocol 1, additive to 006/019/020/026.
-- Stop old producers before rollout. No historical action is backfilled.
-- Publication and receipt are delivery facts, never a business success claim.
BEGIN;

DO $$
BEGIN
  IF pg_catalog.to_regprocedure('purama_ai.karta_finalize_pending_action(uuid,text,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = 'purama_ai.karta_pending_actions'::regclass
         AND attname = 'execution_trigger' AND atttypid = 'jsonb'::regtype AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = 'purama_ai.karta_runs'::regclass
         AND attname = 'execution_fingerprint' AND atttypid = 'text'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'KARTA migration 027: canonical approval prerequisites are missing';
  END IF;
END;
$$;

-- Parse expected checks on this PostgreSQL version. Existing unknown tables
-- must not be silently accepted by CREATE TABLE IF NOT EXISTS.
CREATE TEMP TABLE karta_outbox_expected_027 (
  pending_action_id uuid NOT NULL,
  user_id uuid NOT NULL,
  parent_run_id uuid NOT NULL,
  agent_type text NOT NULL CHECK (length(agent_type) BETWEEN 1 AND 128),
  resolution text NOT NULL CHECK (resolution IN ('executed','rejected')),
  protocol smallint NOT NULL DEFAULT 1 CHECK (protocol = 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','received','blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  execution_key text,
  execution_fingerprint text,
  published_at timestamptz,
  received_at timestamptz,
  received_run_id uuid,
  blocked_code text CHECK (blocked_code IN ('identity_conflict','retained_terminal','invalid_intent')),
  CONSTRAINT karta_approval_outbox_identity CHECK (
    (execution_key IS NULL AND execution_fingerprint IS NULL) OR
    (execution_key IS NOT NULL AND execution_fingerprint IS NOT NULL
      AND execution_key ~ '^queue:v2:karta-v2-dedupe-[0-9a-f]{64}$'
      AND execution_fingerprint ~ '^[0-9a-f]{64}$')),
  CONSTRAINT karta_approval_outbox_lease CHECK (
    (lease_token IS NULL AND lease_until IS NULL) OR
    (status = 'pending' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT karta_approval_outbox_receipt CHECK (
    (status = 'received' AND received_at IS NOT NULL AND received_run_id IS NOT NULL
      AND execution_key IS NOT NULL AND lease_token IS NULL AND blocked_code IS NULL) OR
    (status <> 'received' AND received_at IS NULL AND received_run_id IS NULL)),
  CONSTRAINT karta_approval_outbox_block CHECK (
    (status = 'blocked' AND blocked_code IS NOT NULL AND lease_token IS NULL) OR
    (status <> 'blocked' AND blocked_code IS NULL))
) ON COMMIT DROP;
CREATE TABLE IF NOT EXISTS purama_ai.karta_approval_outbox (
  LIKE pg_temp.karta_outbox_expected_027 INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  PRIMARY KEY (pending_action_id),
  FOREIGN KEY (pending_action_id) REFERENCES purama_ai.karta_pending_actions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_run_id) REFERENCES purama_ai.karta_runs(id) ON DELETE CASCADE
);
DO $$
BEGIN
  IF (SELECT jsonb_agg(jsonb_build_array(attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated) ORDER BY attnum)
      FROM pg_catalog.pg_attribute WHERE attrelid='purama_ai.karta_approval_outbox'::regclass AND attnum>0 AND NOT attisdropped)
    IS DISTINCT FROM
     (SELECT jsonb_agg(jsonb_build_array(attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated) ORDER BY attnum)
      FROM pg_catalog.pg_attribute WHERE attrelid='pg_temp.karta_outbox_expected_027'::regclass AND attnum>0 AND NOT attisdropped)
    OR (SELECT jsonb_agg(pg_catalog.pg_get_expr(conbin,conrelid,false) ORDER BY pg_catalog.pg_get_expr(conbin,conrelid,false))
      FROM pg_catalog.pg_constraint WHERE conrelid='purama_ai.karta_approval_outbox'::regclass AND contype='c')
    IS DISTINCT FROM
     (SELECT jsonb_agg(pg_catalog.pg_get_expr(conbin,conrelid,false) ORDER BY pg_catalog.pg_get_expr(conbin,conrelid,false))
      FROM pg_catalog.pg_constraint WHERE conrelid='pg_temp.karta_outbox_expected_027'::regclass AND contype='c')
    OR (SELECT jsonb_agg(jsonb_build_array(a.attname,pg_catalog.pg_get_expr(d.adbin,d.adrelid,false)) ORDER BY a.attnum)
      FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
      WHERE d.adrelid='purama_ai.karta_approval_outbox'::regclass)
    IS DISTINCT FROM
     (SELECT jsonb_agg(jsonb_build_array(a.attname,pg_catalog.pg_get_expr(d.adbin,d.adrelid,false)) ORDER BY a.attnum)
      FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
      WHERE d.adrelid='pg_temp.karta_outbox_expected_027'::regclass)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='purama_ai.karta_approval_outbox'::regclass AND NOT convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='purama_ai.karta_approval_outbox'::regclass
      AND contype='p' AND conkey=ARRAY[1]::smallint[])
    OR (SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid='purama_ai.karta_approval_outbox'::regclass AND contype='f')<>3
    OR (SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid='purama_ai.karta_approval_outbox'::regclass
      AND contype='f' AND confdeltype='c' AND NOT condeferrable AND (
        (conkey=ARRAY[1]::smallint[] AND confrelid='purama_ai.karta_pending_actions'::regclass AND confkey=ARRAY[1]::smallint[])
        OR (conkey=ARRAY[2]::smallint[] AND confrelid='auth.users'::regclass AND confkey=ARRAY[
          (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid='auth.users'::regclass AND attname='id' AND NOT attisdropped)]::smallint[])
        OR (conkey=ARRAY[3]::smallint[] AND confrelid='purama_ai.karta_runs'::regclass AND confkey=ARRAY[1]::smallint[])))<>3 THEN
    RAISE EXCEPTION 'KARTA migration 027: unknown approval outbox table contract';
  END IF;
END;
$$;
ALTER TABLE purama_ai.karta_approval_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.karta_approval_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON purama_ai.karta_approval_outbox TO service_role;
CREATE INDEX IF NOT EXISTS karta_approval_outbox_due
  ON purama_ai.karta_approval_outbox(next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION purama_ai.karta_capture_approval_continuation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.claimed_at IS NULL OR NEW.resolved_at IS NULL
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.agent_type IS DISTINCT FROM OLD.agent_type OR NEW.tool_name IS DISTINCT FROM OLD.tool_name
     OR NOT EXISTS (SELECT 1 FROM purama_ai.karta_runs r
       WHERE r.id = NEW.run_id AND r.user_id = NEW.user_id AND r.agent_type = NEW.agent_type) THEN
    RAISE EXCEPTION 'Approval continuation binding is unavailable';
  END IF;
  -- The following INSERT rolls back if the unchanged 006 finalizer subsequently
  -- fails to patch the parent. Its idempotent historical return does not fire us.
  INSERT INTO purama_ai.karta_approval_outbox
    (pending_action_id,user_id,parent_run_id,agent_type,resolution)
    VALUES (NEW.id,NEW.user_id,NEW.run_id,NEW.agent_type,NEW.status);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS karta_capture_approval_continuation ON purama_ai.karta_pending_actions;
CREATE TRIGGER karta_capture_approval_continuation
  AFTER UPDATE OF status ON purama_ai.karta_pending_actions
  FOR EACH ROW WHEN (OLD.status = 'executing' AND NEW.status IN ('executed','rejected'))
  EXECUTE FUNCTION purama_ai.karta_capture_approval_continuation();

CREATE OR REPLACE FUNCTION purama_ai.karta_protect_approval_outbox_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.pending_action_id,NEW.user_id,NEW.parent_run_id,NEW.agent_type,NEW.resolution,NEW.protocol,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.pending_action_id,OLD.user_id,OLD.parent_run_id,OLD.agent_type,OLD.resolution,OLD.protocol,OLD.created_at)
     OR (OLD.execution_key IS NOT NULL AND
       ROW(NEW.execution_key,NEW.execution_fingerprint) IS DISTINCT FROM ROW(OLD.execution_key,OLD.execution_fingerprint))
     OR (OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Approval continuation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS karta_protect_approval_outbox_identity ON purama_ai.karta_approval_outbox;
CREATE TRIGGER karta_protect_approval_outbox_identity BEFORE UPDATE ON purama_ai.karta_approval_outbox
  FOR EACH ROW EXECUTE FUNCTION purama_ai.karta_protect_approval_outbox_identity();

-- A relation-backed return type can acquire a relation lock before the
-- function's SET lock_timeout takes effect. Explicit scalar output columns
-- preserve PostgREST's row array without that pre-entry lock.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_class c
    ON c.oid='purama_ai.karta_approval_outbox'::regclass AND p.prorettype=c.reltype
    WHERE p.oid=pg_catalog.to_regprocedure('purama_ai.karta_claim_approval_outbox(integer)')) THEN
    DROP FUNCTION purama_ai.karta_claim_approval_outbox(integer);
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION purama_ai.karta_claim_approval_outbox(p_limit integer DEFAULT 5)
RETURNS TABLE (
  pending_action_id uuid,user_id uuid,parent_run_id uuid,agent_type text,resolution text,protocol smallint,
  status text,created_at timestamptz,next_attempt_at timestamptz,attempts integer,
  lease_token uuid,lease_until timestamptz,execution_key text,execution_fingerprint text,
  published_at timestamptz,received_at timestamptz,received_run_id uuid,blocked_code text
)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5 THEN RAISE EXCEPTION 'Invalid continuation batch'; END IF;
  RETURN QUERY WITH candidates AS (
    SELECT o.pending_action_id FROM purama_ai.karta_approval_outbox o
    JOIN purama_ai.karta_runs r ON r.id=o.parent_run_id AND r.user_id=o.user_id AND r.agent_type=o.agent_type
    WHERE o.status='pending' AND o.next_attempt_at<=clock_timestamp()
      AND (o.lease_until IS NULL OR o.lease_until<=clock_timestamp())
      -- A partial resolution must not consume a continuation before its parent
      -- is closed. Ambiguous terminal journals still fail in the existing engine.
      AND r.finished_at IS NOT NULL AND r.status IN ('success','error','skipped','cancelled','partial')
    ORDER BY o.next_attempt_at,o.created_at,o.pending_action_id
    FOR UPDATE OF o SKIP LOCKED LIMIT p_limit
  ) UPDATE purama_ai.karta_approval_outbox o
    SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds',
      attempts=least(o.attempts::bigint+1,2147483647)::integer
    FROM candidates c WHERE o.pending_action_id=c.pending_action_id RETURNING o.*;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.karta_prepare_approval_outbox(
  p_id uuid,p_lease uuid,p_execution_key text,p_fingerprint text,p_legacy_prefix text
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE o purama_ai.karta_approval_outbox%ROWTYPE;
DECLARE r purama_ai.karta_runs%ROWTYPE;
DECLARE expected_prefix text;
BEGIN
  SELECT * INTO o FROM purama_ai.karta_approval_outbox WHERE pending_action_id=p_id FOR UPDATE;
  IF NOT FOUND OR o.status<>'pending' OR p_lease IS NULL OR o.lease_token IS NULL OR o.lease_token IS DISTINCT FROM p_lease
     OR o.lease_until<=clock_timestamp() THEN RETURN 'stale'; END IF;
  expected_prefix := 'queue:karta-' || encode(sha256(convert_to(
    'approval-resume|' || o.pending_action_id::text || '|' || o.resolution,'UTF8')),'hex') || ':';
  IF p_execution_key IS NULL OR p_execution_key !~ '^queue:v2:karta-v2-dedupe-[0-9a-f]{64}$'
     OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_legacy_prefix IS DISTINCT FROM expected_prefix
     OR (o.execution_key IS NOT NULL AND
       ROW(o.execution_key,o.execution_fingerprint) IS DISTINCT FROM ROW(p_execution_key,p_fingerprint))
     OR EXISTS (SELECT 1 FROM purama_ai.karta_runs old
       WHERE old.user_id=o.user_id AND old.agent_type=o.agent_type AND old.execution_key LIKE expected_prefix || '%') THEN
    UPDATE purama_ai.karta_approval_outbox SET status='blocked',blocked_code='identity_conflict',
      lease_token=NULL,lease_until=NULL WHERE pending_action_id=p_id;
    RETURN 'blocked';
  END IF;
  UPDATE purama_ai.karta_approval_outbox SET execution_key=p_execution_key,execution_fingerprint=p_fingerprint
    WHERE pending_action_id=p_id;
  SELECT * INTO r FROM purama_ai.karta_runs WHERE execution_key=p_execution_key;
  IF FOUND THEN
    IF r.user_id IS DISTINCT FROM o.user_id OR r.agent_type IS DISTINCT FROM o.agent_type
       OR r.execution_fingerprint IS DISTINCT FROM p_fingerprint THEN
      UPDATE purama_ai.karta_approval_outbox SET status='blocked',blocked_code='identity_conflict',
        lease_token=NULL,lease_until=NULL WHERE pending_action_id=p_id;
      RETURN 'blocked';
    END IF;
    -- A running/error/skipped run is still a verified receipt, never success.
    UPDATE purama_ai.karta_approval_outbox SET status='received',received_at=now(),received_run_id=r.id,
      lease_token=NULL,lease_until=NULL WHERE pending_action_id=p_id;
    RETURN 'received';
  END IF;
  RETURN 'ready';
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.karta_finish_approval_outbox(p_id uuid,p_lease uuid,p_result text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE o purama_ai.karta_approval_outbox%ROWTYPE;
BEGIN
  IF p_result IS NULL OR p_result NOT IN ('published','retry','identity_conflict','retained_terminal','invalid_intent') THEN
    RAISE EXCEPTION 'Invalid continuation delivery result';
  END IF;
  SELECT * INTO o FROM purama_ai.karta_approval_outbox WHERE pending_action_id=p_id FOR UPDATE;
  IF NOT FOUND OR o.status<>'pending' OR p_lease IS NULL OR o.lease_token IS NULL OR o.lease_token IS DISTINCT FROM p_lease
     OR o.lease_until<=clock_timestamp() THEN RETURN false; END IF;
  IF p_result='published' AND o.execution_key IS NULL THEN RAISE EXCEPTION 'Unbound continuation'; END IF;
  UPDATE purama_ai.karta_approval_outbox SET
    status=CASE WHEN p_result IN ('published','retry') THEN 'pending' ELSE 'blocked' END,
    blocked_code=CASE WHEN p_result IN ('published','retry') THEN NULL ELSE p_result END,
    published_at=CASE WHEN p_result='published' THEN coalesce(published_at,now()) ELSE published_at END,
    next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,5*power(2,least(attempts,10)))::double precision),
    lease_token=NULL,lease_until=NULL WHERE pending_action_id=p_id;
  RETURN true;
END;
$$;

-- Preserve canonical bodies and signatures. HTTP cancellation alone does not
-- bound a PostgreSQL wait behind another transaction's row/table lock.
ALTER FUNCTION purama_ai.karta_claim_pending_action(uuid,text) SET lock_timeout = '2s';
ALTER FUNCTION purama_ai.karta_finalize_pending_action(uuid,text,text) SET lock_timeout = '2s';

-- 026 owns and attests the original SETOF pending-action contract. Keep it
-- intact, but enter this scalar wrapper before resolving that relation type.
CREATE OR REPLACE FUNCTION purama_ai.karta_claim_pending_action_bounded(p_id uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog SET lock_timeout = '2s' AS $$
DECLARE result jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(action)), '[]'::jsonb) INTO result
    FROM purama_ai.karta_claim_pending_action(p_id,p_decision) action;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.karta_approval_outbox_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('protocol',1,'ready',
    EXISTS (SELECT 1 FROM pg_class WHERE oid='purama_ai.karta_approval_outbox'::regclass AND relkind='r' AND relrowsecurity)
    AND NOT has_table_privilege('anon','purama_ai.karta_approval_outbox','SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('authenticated','purama_ai.karta_approval_outbox','SELECT,INSERT,UPDATE,DELETE')
    AND has_table_privilege('service_role','purama_ai.karta_approval_outbox','SELECT')
    AND has_table_privilege('service_role','purama_ai.karta_approval_outbox','INSERT')
    AND has_table_privilege('service_role','purama_ai.karta_approval_outbox','UPDATE')
    AND has_table_privilege('service_role','purama_ai.karta_approval_outbox','DELETE')
    AND (SELECT count(*)=18 AND bool_and(CASE
      WHEN attname IN ('pending_action_id','user_id','parent_run_id','lease_token','received_run_id') THEN atttypid='uuid'::regtype
      WHEN attname IN ('agent_type','resolution','status','execution_key','execution_fingerprint','blocked_code') THEN atttypid='text'::regtype
      WHEN attname IN ('created_at','next_attempt_at','lease_until','published_at','received_at') THEN atttypid='timestamptz'::regtype
      WHEN attname='protocol' THEN atttypid='smallint'::regtype
      WHEN attname='attempts' THEN atttypid='integer'::regtype ELSE false END)
      FROM pg_attribute WHERE attrelid='purama_ai.karta_approval_outbox'::regclass AND attnum>0 AND NOT attisdropped)
    AND (SELECT count(*)=4 AND bool_and(convalidated) FROM pg_constraint
      WHERE conrelid='purama_ai.karta_approval_outbox'::regclass
        AND conname IN ('karta_approval_outbox_identity','karta_approval_outbox_lease','karta_approval_outbox_receipt','karta_approval_outbox_block'))
    AND (SELECT count(*)=2 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND (
      (tgrelid='purama_ai.karta_pending_actions'::regclass AND tgname='karta_capture_approval_continuation'
        AND tgfoid=to_regprocedure('purama_ai.karta_capture_approval_continuation()') AND tgtype=17
        AND tgqual IS NOT NULL AND tgattr::text=(SELECT attnum::text FROM pg_attribute
          WHERE attrelid='purama_ai.karta_pending_actions'::regclass AND attname='status' AND NOT attisdropped))
      OR (tgrelid='purama_ai.karta_approval_outbox'::regclass AND tgname='karta_protect_approval_outbox_identity'
        AND tgfoid=to_regprocedure('purama_ai.karta_protect_approval_outbox_identity()') AND tgtype=19)))
    AND EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('purama_ai.karta_claim_approval_outbox(integer)')
      AND proretset AND prorettype='record'::regtype)
    AND EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('purama_ai.karta_claim_pending_action_bounded(uuid,text)')
      AND NOT proretset AND prorettype='jsonb'::regtype)
    AND (SELECT count(*)=6 AND bool_and(NOT p.prosecdef AND coalesce(p.proconfig @> ARRAY['lock_timeout=2s']::text[],false)
      AND has_function_privilege('service_role',p.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE'))
      FROM pg_proc p WHERE p.oid IN (
        to_regprocedure('purama_ai.karta_claim_approval_outbox(integer)'),
        to_regprocedure('purama_ai.karta_prepare_approval_outbox(uuid,uuid,text,text,text)'),
        to_regprocedure('purama_ai.karta_finish_approval_outbox(uuid,uuid,text)'),
        to_regprocedure('purama_ai.karta_claim_pending_action(uuid,text)'),
        to_regprocedure('purama_ai.karta_finalize_pending_action(uuid,text,text)'),
        to_regprocedure('purama_ai.karta_claim_pending_action_bounded(uuid,text)'))));
$$;

REVOKE ALL ON FUNCTION purama_ai.karta_capture_approval_continuation() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.karta_protect_approval_outbox_identity() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.karta_claim_approval_outbox(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.karta_prepare_approval_outbox(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.karta_finish_approval_outbox(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.karta_approval_outbox_health() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION purama_ai.karta_claim_pending_action_bounded(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.karta_claim_approval_outbox(integer) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.karta_prepare_approval_outbox(uuid,uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.karta_finish_approval_outbox(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.karta_approval_outbox_health() TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.karta_claim_pending_action_bounded(uuid,text) TO service_role;
COMMENT ON TABLE purama_ai.karta_approval_outbox IS
  'Protocol 1. Minimal durable delivery intent; no private tool parameters/results. received proves a matching run exists, not its success. No historical backfill.';
COMMIT;
