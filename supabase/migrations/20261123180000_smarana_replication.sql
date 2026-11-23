-- SMARANA account-private conversation replication. Data only: no generation,
-- tool execution, webhook or approval is triggered by these functions.
BEGIN;
CREATE SCHEMA IF NOT EXISTS purama_ai;

CREATE OR REPLACE FUNCTION purama_ai.smarana_timestamp_valid(p_value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p_value IS NULL OR p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
     OR left(p_value,5) = '0000-' THEN RETURN false; END IF;
  RETURN to_char(p_value::timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = p_value;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.smarana_snapshot_valid(p_value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  item jsonb;
  total_bytes bigint;
  seen_ids text[] := ARRAY[]::text[];
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) <> 'object'
     OR NOT (p_value ?& ARRAY['title','messages'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_value) k WHERE k NOT IN ('title','messages','draft'))
     OR jsonb_typeof(p_value->'title') <> 'string' OR char_length(p_value->>'title') > 256
     OR jsonb_typeof(p_value->'messages') <> 'array' OR jsonb_array_length(p_value->'messages') > 512
     OR (p_value ? 'draft' AND (jsonb_typeof(p_value->'draft') <> 'string' OR octet_length(p_value->>'draft') > 262144))
  THEN RETURN false; END IF;
  total_bytes := octet_length(p_value->>'title') + octet_length(coalesce(p_value->>'draft',''));
  FOR item IN SELECT value FROM jsonb_array_elements(p_value->'messages') LOOP
    IF jsonb_typeof(item) <> 'object' OR NOT (item ?& ARRAY['id','role','content','state','createdAt'])
       OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN ('id','role','content','state','createdAt'))
       OR jsonb_typeof(item->'id') <> 'string'
       OR (item->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (item->>'id') = ANY(seen_ids)
       OR jsonb_typeof(item->'role') <> 'string' OR (item->>'role') NOT IN ('user','assistant')
       OR jsonb_typeof(item->'state') <> 'string' OR (item->>'state') NOT IN ('pending','complete','interrupted')
       OR ((item->>'role') = 'user' AND (item->>'state') <> 'complete')
       OR jsonb_typeof(item->'content') <> 'string' OR octet_length(item->>'content') > 262144
       OR ((item->>'state') = 'complete' AND octet_length(item->>'content') = 0)
       OR jsonb_typeof(item->'createdAt') <> 'string' OR NOT purama_ai.smarana_timestamp_valid(item->>'createdAt')
    THEN RETURN false; END IF;
    seen_ids := array_append(seen_ids,item->>'id');
    total_bytes := total_bytes + octet_length(item->>'content');
    IF total_bytes > 1048576 THEN RETURN false; END IF;
  END LOOP;
  RETURN total_bytes <= 1048576;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

-- A row lock on this owner serializes ALL successful mutations for that owner.
-- Unlike a sequence/bigserial, cursor allocation cannot overtake an uncommitted
-- earlier mutation. Different accounts never share this lock or a cursor.
CREATE TABLE IF NOT EXISTS purama_ai.smarana_owner_cursors (
  owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  cursor bigint NOT NULL DEFAULT 0 CHECK(cursor >= 0)
);
CREATE TABLE IF NOT EXISTS purama_ai.smarana_records (
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL,
  revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  cursor bigint NOT NULL CHECK(cursor > 0),
  tombstone boolean NOT NULL,
  payload jsonb,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(owner_id,resource_id),
  UNIQUE(owner_id,cursor),
  CHECK((tombstone AND payload IS NULL) OR (NOT tombstone AND purama_ai.smarana_snapshot_valid(payload)))
);
-- Fingerprints are computed on normalized JSONB on the server, never trusted
-- from clients. Successful receipts retain no additional copy of the content.
-- Conflict receipts retain the rejected operation's remote snapshot so retries
-- return the same conflict. Deletion is logical; account deletion cascades all.
CREATE TABLE IF NOT EXISTS purama_ai.smarana_mutations (
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mutation_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  request_fingerprint bytea NOT NULL CHECK(octet_length(request_fingerprint) = 32),
  result jsonb NOT NULL CHECK(jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,mutation_id)
);

ALTER TABLE purama_ai.smarana_owner_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.smarana_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.smarana_mutations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS smarana_records_owner_select ON purama_ai.smarana_records;
CREATE POLICY smarana_records_owner_select ON purama_ai.smarana_records FOR SELECT TO authenticated
  USING(owner_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION purama_ai.smarana_record_json(p_row purama_ai.smarana_records)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'schemaVersion',1,'ownerId',p_row.owner_id::text,'resourceId',p_row.resource_id::text,
    'revision',p_row.revision,'cursor',p_row.cursor::text,'tombstone',p_row.tombstone,'payload',p_row.payload,
    'updatedAt',to_char(p_row.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
$$;

CREATE OR REPLACE FUNCTION purama_ai.smarana_apply(p_expected_owner_id uuid,p_mutation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  v_mutation_id uuid;
  v_resource_id uuid;
  base_revision bigint;
  next_cursor bigint;
  is_deleted boolean;
  normalized_payload jsonb;
  canonical_request jsonb;
  fingerprint bytea;
  existing purama_ai.smarana_records%ROWTYPE;
  receipt purama_ai.smarana_mutations%ROWTYPE;
  has_existing boolean;
  current_record jsonb;
  common_result jsonb;
  result jsonb;
  conflict_reason text;
  stamp timestamptz;
BEGIN
  IF v_owner_id IS NULL OR p_expected_owner_id IS DISTINCT FROM v_owner_id THEN
    RAISE EXCEPTION 'SMARANA unavailable';
  END IF;
  IF p_mutation IS NULL OR jsonb_typeof(p_mutation) <> 'object'
     OR NOT (p_mutation ?& ARRAY['schemaVersion','ownerId','resourceId','mutationId','baseRevision','tombstone','payload'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_mutation) k WHERE k NOT IN ('schemaVersion','ownerId','resourceId','mutationId','baseRevision','tombstone','payload'))
     OR p_mutation->'schemaVersion' <> '1'::jsonb
     OR jsonb_typeof(p_mutation->'ownerId') <> 'string' OR p_mutation->>'ownerId' <> v_owner_id::text
     OR jsonb_typeof(p_mutation->'resourceId') <> 'string'
     OR (p_mutation->>'resourceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(p_mutation->'mutationId') <> 'string'
     OR (p_mutation->>'mutationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(p_mutation->'baseRevision') <> 'number'
     OR (p_mutation->>'baseRevision')::numeric < 0 OR (p_mutation->>'baseRevision')::numeric > 9007199254740990
     OR trunc((p_mutation->>'baseRevision')::numeric) <> (p_mutation->>'baseRevision')::numeric
     OR jsonb_typeof(p_mutation->'tombstone') <> 'boolean'
  THEN RAISE EXCEPTION 'SMARANA unavailable'; END IF;
  v_mutation_id := (p_mutation->>'mutationId')::uuid;
  v_resource_id := (p_mutation->>'resourceId')::uuid;
  base_revision := (p_mutation->>'baseRevision')::numeric::bigint;
  is_deleted := (p_mutation->>'tombstone')::boolean;
  IF is_deleted THEN
    IF p_mutation->'payload' <> 'null'::jsonb THEN RAISE EXCEPTION 'SMARANA unavailable'; END IF;
    normalized_payload := NULL;
  ELSE
    IF NOT purama_ai.smarana_snapshot_valid(p_mutation->'payload') THEN RAISE EXCEPTION 'SMARANA unavailable'; END IF;
    normalized_payload := p_mutation->'payload' || jsonb_build_object('draft',coalesce(p_mutation->'payload'->>'draft',''));
  END IF;
  canonical_request := p_mutation || jsonb_build_object('schemaVersion',1,'baseRevision',base_revision,'payload',normalized_payload);
  fingerprint := sha256(convert_to(canonical_request::text,'UTF8'));

  INSERT INTO purama_ai.smarana_owner_cursors(owner_id) VALUES(v_owner_id) ON CONFLICT DO NOTHING;
  SELECT c.cursor INTO next_cursor FROM purama_ai.smarana_owner_cursors c WHERE c.owner_id = v_owner_id FOR UPDATE;
  SELECT r.* INTO existing FROM purama_ai.smarana_records r WHERE r.owner_id = v_owner_id AND r.resource_id = v_resource_id;
  has_existing := FOUND;
  current_record := CASE WHEN has_existing THEN purama_ai.smarana_record_json(existing) ELSE NULL END;
  common_result := jsonb_build_object('ownerId',v_owner_id::text,'resourceId',v_resource_id::text,
    'mutationId',v_mutation_id::text,'baseRevision',base_revision,'replayed',false);

  SELECT m.* INTO receipt FROM purama_ai.smarana_mutations m WHERE m.owner_id = v_owner_id AND m.mutation_id = v_mutation_id;
  IF FOUND THEN
    IF receipt.request_fingerprint = fingerprint THEN RETURN receipt.result || jsonb_build_object('replayed',true); END IF;
    RETURN common_result || jsonb_build_object('status','conflict','reason','mutation_reused','current',current_record);
  END IF;

  IF has_existing AND existing.tombstone THEN conflict_reason := 'deleted';
  ELSIF (has_existing AND existing.revision <> base_revision) OR (NOT has_existing AND base_revision <> 0) THEN conflict_reason := 'revision';
  END IF;
  IF conflict_reason IS NOT NULL THEN
    result := common_result || jsonb_build_object('status','conflict','reason',conflict_reason,'current',current_record);
  ELSE
    IF next_cursor = 9223372036854775807 THEN RAISE EXCEPTION 'SMARANA unavailable'; END IF;
    next_cursor := next_cursor + 1;
    stamp := date_trunc('milliseconds',clock_timestamp());
    INSERT INTO purama_ai.smarana_records(owner_id,resource_id,revision,cursor,tombstone,payload,updated_at)
      VALUES(v_owner_id,v_resource_id,base_revision + 1,next_cursor,is_deleted,normalized_payload,stamp)
      ON CONFLICT ON CONSTRAINT smarana_records_pkey DO UPDATE SET
        revision = EXCLUDED.revision,cursor = EXCLUDED.cursor,tombstone = EXCLUDED.tombstone,
        payload = EXCLUDED.payload,updated_at = EXCLUDED.updated_at;
    UPDATE purama_ai.smarana_owner_cursors c SET cursor = next_cursor WHERE c.owner_id = v_owner_id;
    result := common_result || jsonb_build_object('status','applied','revision',base_revision + 1,
      'cursor',next_cursor::text,'updatedAt',to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  END IF;
  INSERT INTO purama_ai.smarana_mutations(owner_id,mutation_id,resource_id,request_fingerprint,result)
    VALUES(v_owner_id,v_mutation_id,v_resource_id,fingerprint,result);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  -- Neither malformed JSON, foreign identities nor database diagnostics disclose content.
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SMARANA unavailable';
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.smarana_pull(p_expected_owner_id uuid,p_after_cursor text DEFAULT '0',p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_owner_id uuid := auth.uid();
  after_cursor bigint;
  current_cursor bigint;
  last_cursor bigint;
  item purama_ai.smarana_records%ROWTYPE;
  records jsonb := '[]'::jsonb;
  has_more boolean := false;
  count integer := 0;
BEGIN
  IF v_owner_id IS NULL OR p_expected_owner_id IS DISTINCT FROM v_owner_id
     OR p_after_cursor IS NULL OR p_after_cursor !~ '^(0|[1-9][0-9]{0,18})$'
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 20 THEN RAISE EXCEPTION 'SMARANA unavailable'; END IF;
  after_cursor := p_after_cursor::bigint;
  last_cursor := after_cursor;
  -- Keep the page coherent with owner mutations without locking other accounts.
  SELECT c.cursor INTO current_cursor FROM purama_ai.smarana_owner_cursors c WHERE c.owner_id = v_owner_id FOR SHARE;
  IF after_cursor > coalesce(current_cursor,0) THEN RAISE EXCEPTION 'SMARANA unavailable'; END IF;
  IF current_cursor IS NOT NULL THEN
    FOR item IN SELECT r.* FROM purama_ai.smarana_records r
      WHERE r.owner_id = v_owner_id AND r.cursor > after_cursor ORDER BY r.cursor LIMIT p_limit + 1 LOOP
      IF count = p_limit THEN has_more := true; EXIT; END IF;
      records := records || jsonb_build_array(purama_ai.smarana_record_json(item));
      count := count + 1;
      last_cursor := item.cursor;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('ownerId',v_owner_id::text,'records',records,'cursor',last_cursor::text,'hasMore',has_more);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SMARANA unavailable';
END;
$$;

-- All writes go through authenticated RPCs. No anonymous import, service-role
-- shortcut, direct UPSERT/DELETE, or caller-supplied owner authority exists.
REVOKE ALL ON purama_ai.smarana_owner_cursors,purama_ai.smarana_records,purama_ai.smarana_mutations FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA purama_ai TO authenticated;
GRANT SELECT ON purama_ai.smarana_records TO authenticated;
REVOKE ALL ON FUNCTION purama_ai.smarana_timestamp_valid(text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION purama_ai.smarana_snapshot_valid(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION purama_ai.smarana_record_json(purama_ai.smarana_records) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION purama_ai.smarana_apply(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION purama_ai.smarana_pull(uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION purama_ai.smarana_apply(uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.smarana_pull(uuid,text,integer) TO authenticated;
COMMIT;
