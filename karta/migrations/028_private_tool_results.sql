-- Private product results for the two bounded research/simulation tools.
-- Deploy after the creator-agent tables and KARTA migrations 001--027.
-- This is not a trace, SMARANA entry or model-generated answer. No TTL is claimed.
BEGIN;

CREATE OR REPLACE FUNCTION purama_ai.karta_private_tool_result_valid(p_tool_name text, p_payload jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  d jsonb;
  s jsonb;
  item jsonb;
  allowed text[];
  all_answered boolean;
  some_answered boolean;
BEGIN
  IF p_tool_name NOT IN ('knowledge_search','quantum_simulate') OR p_tool_name IS NULL
     OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR octet_length(p_payload::text) > 65536 THEN RETURN false; END IF;
  allowed := ARRAY['schema_version','tool_name','status','summary','sources','details'];
  IF NOT (p_payload ?& allowed) OR p_payload - allowed <> '{}'::jsonb
     OR p_payload->'schema_version' IS DISTINCT FROM '1'::jsonb
     OR p_payload->>'tool_name' IS DISTINCT FROM p_tool_name
     OR p_payload->>'status' NOT IN ('complete','empty','partial','failed')
     OR jsonb_typeof(p_payload->'status') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_payload->'summary') IS DISTINCT FROM 'string'
     OR char_length(p_payload->>'summary') NOT BETWEEN 1 AND 4000
     OR jsonb_typeof(p_payload->'sources') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_payload->'details') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF jsonb_array_length(p_payload->'sources') > 10 THEN RETURN false; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(p_payload->'sources') LOOP
    allowed := ARRAY['source','native_id','label','url','retrieved_at'];
    IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR NOT (s ?& allowed)
       OR s - allowed <> '{}'::jsonb THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(s) WHERE jsonb_typeof(value) <> 'string')
       OR char_length(s->>'native_id') NOT BETWEEN 1 AND 512
       OR char_length(btrim(s->>'label')) = 0 OR char_length(s->>'label') > 256
       -- A 512-character Unicode DOI expands during percent encoding.
       OR char_length(s->>'url') > 8192
       OR (s->>'retrieved_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' THEN RETURN false; END IF;
    IF s->>'source' = 'crossref' THEN
      IF (s->>'native_id') !~* '^10\.[0-9]{4,9}/[^[:space:][:cntrl:]]+$'
         OR (s->>'url') !~ '^https://doi\.org/10\.[0-9]{4,9}/[^[:space:]?#]+$' THEN RETURN false; END IF;
    ELSIF s->>'source' = 'wikidata' THEN
      IF (s->>'native_id') !~ '^Q[1-9][0-9]{0,19}$'
         OR s->>'url' IS DISTINCT FROM 'https://www.wikidata.org/wiki/' || (s->>'native_id') THEN RETURN false; END IF;
    ELSE RETURN false;
    END IF;
  END LOOP;
  d := p_payload->'details';
  IF p_tool_name = 'knowledge_search' THEN
    allowed := ARRAY['retrieval_id','scope','content_kind','verification_status','source_text_trust',
      'page_read_by_karta','full_text_retrieved','requested_language','selected_sources','source_outcomes','records','metadata_truncated'];
    IF NOT (d ?& allowed) OR d - allowed <> '{}'::jsonb
       OR jsonb_typeof(d->'retrieval_id') IS DISTINCT FROM 'string'
       OR (d->>'retrieval_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR d->>'scope' IS DISTINCT FROM 'selected_public_sources'
       OR d->>'content_kind' IS DISTINCT FROM 'metadata_only'
       OR d->>'verification_status' IS DISTINCT FROM 'unverified'
       OR d->>'source_text_trust' IS DISTINCT FROM 'untrusted_data'
       OR d->'page_read_by_karta' IS DISTINCT FROM 'false'::jsonb
       OR d->'full_text_retrieved' IS DISTINCT FROM 'false'::jsonb
       OR d->>'requested_language' NOT IN ('fr','en')
       OR jsonb_typeof(d->'requested_language') IS DISTINCT FROM 'string'
       OR jsonb_typeof(d->'metadata_truncated') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(d->'selected_sources') IS DISTINCT FROM 'array'
       OR jsonb_typeof(d->'source_outcomes') IS DISTINCT FROM 'array'
       OR jsonb_typeof(d->'records') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(d->'selected_sources') NOT BETWEEN 1 AND 2
       OR jsonb_array_length(d->'source_outcomes') <> jsonb_array_length(d->'selected_sources')
       OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(d->'selected_sources')) <> jsonb_array_length(d->'selected_sources')
       OR (SELECT count(DISTINCT value->'source') FROM jsonb_array_elements(d->'source_outcomes')) <> jsonb_array_length(d->'source_outcomes')
       OR jsonb_array_length(d->'records') <> jsonb_array_length(p_payload->'sources')
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(d->'selected_sources') AS selected(value)
         WHERE value NOT IN ('"crossref"'::jsonb,'"wikidata"'::jsonb)) THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(d->'source_outcomes') LOOP
      allowed := ARRAY['source','status','result_count','duplicate_results_removed','retrieved_at','retry_after_ms'];
      IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item - allowed <> '{}'::jsonb
         OR NOT (item ?& ARRAY['source','status','result_count','duplicate_results_removed','retrieved_at'])
         OR item->>'source' NOT IN ('crossref','wikidata') OR jsonb_typeof(item->'source') IS DISTINCT FROM 'string'
         OR item->>'status' NOT IN ('ok','empty','busy','rate_limited','unavailable','invalid_response','timeout')
         OR jsonb_typeof(item->'status') IS DISTINCT FROM 'string'
         OR jsonb_typeof(item->'result_count') IS DISTINCT FROM 'number'
         OR (item->>'result_count') !~ '^[0-5]$'
         OR jsonb_typeof(item->'duplicate_results_removed') IS DISTINCT FROM 'number'
         OR (item->>'duplicate_results_removed') !~ '^[0-5]$'
         OR (item->'retrieved_at' <> 'null'::jsonb AND (jsonb_typeof(item->'retrieved_at') <> 'string'
           OR (item->>'retrieved_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'))
         OR (item ? 'retry_after_ms' AND (jsonb_typeof(item->'retry_after_ms') <> 'number'
           OR (item->>'retry_after_ms') !~ '^[0-9]{1,16}$')) THEN RETURN false; END IF;
      IF NOT (d->'selected_sources' @> jsonb_build_array(item->'source'))
         OR (item->>'result_count')::integer <> (SELECT count(*) FROM jsonb_array_elements(p_payload->'sources') AS result(value) WHERE value->'source' = item->'source')
         OR ((item->>'status' = 'ok') IS DISTINCT FROM ((item->>'result_count')::integer > 0))
         OR ((item->>'status' IN ('ok','empty')) IS DISTINCT FROM (item->'retrieved_at' <> 'null'::jsonb))
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'sources') AS result(value)
           WHERE value->'source' = item->'source' AND value->'retrieved_at' IS DISTINCT FROM item->'retrieved_at') THEN RETURN false; END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'sources') AS source(value)
        WHERE NOT (d->'selected_sources' @> jsonb_build_array(value->'source')))
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(d->'records') WITH ORDINALITY AS record(value,position)
         WHERE (value->>'source_index')::integer <> position - 1
           OR value->'metadata_license' IS DISTINCT FROM CASE WHEN p_payload->'sources'->((position-1)::integer)->>'source' = 'wikidata'
             THEN '"CC0-1.0"'::jsonb ELSE 'null'::jsonb END) THEN RETURN false; END IF;
    SELECT bool_and(value->>'status' IN ('ok','empty')), bool_or(value->>'status' IN ('ok','empty'))
      INTO all_answered,some_answered FROM jsonb_array_elements(d->'source_outcomes');
    IF (p_payload->>'status' = 'complete' AND (NOT all_answered OR jsonb_array_length(p_payload->'sources') = 0))
       OR (p_payload->>'status' = 'empty' AND (NOT all_answered OR jsonb_array_length(p_payload->'sources') <> 0))
       OR (p_payload->>'status' = 'partial' AND (all_answered OR NOT some_answered))
       OR (p_payload->>'status' = 'failed' AND (some_answered OR jsonb_array_length(p_payload->'sources') <> 0)) THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(d->'records') LOOP
      allowed := ARRAY['source_index','excerpt','language','provider_published_date','metadata_license','content_license','provider_ranks'];
      IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT (item ?& allowed) OR item - allowed <> '{}'::jsonb
         OR jsonb_typeof(item->'source_index') IS DISTINCT FROM 'number' OR (item->>'source_index') !~ '^[0-9]$'
         OR jsonb_typeof(item->'excerpt') IS DISTINCT FROM 'string' OR char_length(item->>'excerpt') > 512
         OR (item->'language' <> 'null'::jsonb AND (jsonb_typeof(item->'language') <> 'string' OR char_length(item->>'language') > 32))
         OR (item->'provider_published_date' <> 'null'::jsonb AND (jsonb_typeof(item->'provider_published_date') <> 'string'
           OR (item->>'provider_published_date') !~ '^\d{4}(-\d{2}){0,2}$'))
         OR item->'metadata_license' NOT IN ('null'::jsonb,'"CC0-1.0"'::jsonb)
         OR item->'content_license' IS DISTINCT FROM 'null'::jsonb
         OR jsonb_typeof(item->'provider_ranks') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      IF jsonb_array_length(item->'provider_ranks') NOT BETWEEN 1 AND 5
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(item->'provider_ranks') AS rank(value)
           WHERE jsonb_typeof(value) <> 'number' OR value::text !~ '^[1-5]$') THEN RETURN false; END IF;
    END LOOP;
  ELSE
    allowed := ARRAY['execution_kind','backend_kind','physical_quantum_hardware','quantum_advantage_demonstrated','external_api_calls',
      'qubits','gate_count','shots','seed','probabilities','counts','state_norm_squared','input_sha256','provenance'];
    IF NOT (d ?& allowed) OR d - allowed <> '{}'::jsonb
       OR p_payload->>'status' IS DISTINCT FROM 'complete' OR p_payload->'sources' <> '[]'::jsonb
       OR d->>'execution_kind' IS DISTINCT FROM 'local_simulator' OR d->>'backend_kind' IS DISTINCT FROM 'classical_statevector'
       OR d->'physical_quantum_hardware' IS DISTINCT FROM 'false'::jsonb
       OR d->'quantum_advantage_demonstrated' IS DISTINCT FROM 'false'::jsonb
       OR d->'external_api_calls' IS DISTINCT FROM '0'::jsonb
       OR (d->>'qubits') !~ '^(10|[1-9])$' OR jsonb_typeof(d->'qubits') IS DISTINCT FROM 'number'
       OR jsonb_typeof(d->'probabilities') IS DISTINCT FROM 'array'
       OR jsonb_typeof(d->'counts') IS DISTINCT FROM 'object'
       OR jsonb_typeof(d->'state_norm_squared') IS DISTINCT FROM 'number'
       OR abs((d->>'state_norm_squared')::numeric - 1) > 0.00000001
       OR jsonb_typeof(d->'input_sha256') IS DISTINCT FROM 'string' OR (d->>'input_sha256') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(d->'provenance') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF jsonb_typeof(d->'gate_count') IS DISTINCT FROM 'number' OR (d->>'gate_count') !~ '^[0-9]{1,3}$' OR (d->>'gate_count')::integer > 128
       OR jsonb_typeof(d->'shots') IS DISTINCT FROM 'number' OR (d->>'shots') !~ '^[0-9]{1,4}$' OR (d->>'shots')::integer > 8192
       OR jsonb_typeof(d->'seed') IS DISTINCT FROM 'number' OR (d->>'seed') !~ '^[0-9]{1,10}$' OR (d->>'seed')::bigint > 4294967295
       OR jsonb_array_length(d->'probabilities') <> 2 ^ ((d->>'qubits')::integer)
       OR (SELECT count(*) FROM jsonb_each(d->'counts')) > 1024 THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(d->'probabilities') LOOP
      IF jsonb_typeof(item) <> 'number' OR item::text::numeric NOT BETWEEN 0 AND 1 THEN RETURN false; END IF;
    END LOOP;
    IF abs((SELECT sum(value::text::numeric) FROM jsonb_array_elements(d->'probabilities')) - 1) > 0.00000001
       OR EXISTS (SELECT 1 FROM jsonb_each(d->'counts') AS counts(key,value)
         WHERE length(key) <> (d->>'qubits')::integer OR key !~ '^[01]+$'
           OR jsonb_typeof(value) <> 'number' OR value::text !~ '^[1-9][0-9]{0,3}$')
       OR coalesce((SELECT sum(value::text::integer) FROM jsonb_each(d->'counts')),0) <> (d->>'shots')::integer THEN RETURN false; END IF;
    IF d->'provenance' IS DISTINCT FROM '{"implementation":"purama-karta-statevector","implementation_version":"1","arithmetic":"float64_complex","initial_state":"all_zero","bit_order":"q0_least_significant","measurement":"final_computational_basis","sampling":"mulberry32_noncryptographic","input_hash_format":"sha256_canonical_validated_json_v1","limits":{"max_qubits":10,"max_gates":128,"max_shots":8192,"max_abs_angle_radians":1000000}}'::jsonb THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE TABLE IF NOT EXISTS purama_ai.karta_tool_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  creator_agent_id uuid NOT NULL REFERENCES purama_ai.creator_agents(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES purama_ai.karta_runs(id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (char_length(operation_id) BETWEEN 36 AND 41),
  tool_name text NOT NULL CHECK (tool_name IN ('knowledge_search','quantum_simulate')),
  payload jsonb NOT NULL CHECK (purama_ai.karta_private_tool_result_valid(tool_name,payload)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,operation_id)
);
CREATE INDEX IF NOT EXISTS karta_tool_results_owner_agent_created_idx
  ON purama_ai.karta_tool_results(user_id,creator_agent_id,created_at DESC);
ALTER TABLE purama_ai.karta_tool_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS karta_tool_results_owner_select ON purama_ai.karta_tool_results;
CREATE POLICY karta_tool_results_owner_select ON purama_ai.karta_tool_results FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM purama_ai.creator_agents a JOIN purama_ai.karta_runs r
      ON r.id = karta_tool_results.run_id AND r.agent_type = 'custom:' || a.id::text
    WHERE a.id = karta_tool_results.creator_agent_id AND a.user_id = auth.uid() AND r.user_id = auth.uid()
  ));
DROP POLICY IF EXISTS karta_tool_results_owner_delete ON purama_ai.karta_tool_results;
CREATE POLICY karta_tool_results_owner_delete ON purama_ai.karta_tool_results FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM purama_ai.creator_agents a JOIN purama_ai.karta_runs r
      ON r.id = karta_tool_results.run_id AND r.agent_type = 'custom:' || a.id::text
    WHERE a.id = karta_tool_results.creator_agent_id AND a.user_id = auth.uid() AND r.user_id = auth.uid()
      AND CASE WHEN karta_tool_results.operation_id LIKE r.id::text || ':%'
        THEN r.duration_ms IS NOT NULL AND r.status <> 'running'
        ELSE NOT EXISTS (SELECT 1 FROM purama_ai.karta_pending_actions p
          WHERE p.id::text = karta_tool_results.operation_id AND p.status = 'executing') END
  ));

CREATE OR REPLACE FUNCTION purama_ai.karta_store_tool_result(
  p_user_id uuid, p_agent_type text, p_run_id uuid, p_operation_id text, p_tool_name text, p_payload jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  parent purama_ai.karta_runs%ROWTYPE;
  agent purama_ai.creator_agents%ROWTYPE;
  pending purama_ai.karta_pending_actions%ROWTYPE;
  existing purama_ai.karta_tool_results%ROWTYPE;
  result_id uuid;
  is_direct boolean;
BEGIN
  IF p_user_id IS NULL OR p_agent_type IS NULL OR p_operation_id IS NULL
     OR NOT purama_ai.karta_private_tool_result_valid(p_tool_name,p_payload) THEN
    RAISE EXCEPTION 'Private result unavailable';
  END IF;
  -- Lock order matches pending-action claims: parent, pending, then owned agent.
  SELECT * INTO parent FROM purama_ai.karta_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR parent.user_id IS DISTINCT FROM p_user_id OR parent.agent_type IS DISTINCT FROM p_agent_type
     OR parent.mode <> 'live' OR parent.claude_mock
     OR parent.agent_type !~ '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Private result unavailable';
  END IF;
  is_direct := p_operation_id ~ ('^' || p_run_id::text || ':(0|[1-9][0-9]{0,3})$');
  IF NOT is_direct THEN
    IF p_operation_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Private result unavailable'; END IF;
    SELECT * INTO pending FROM purama_ai.karta_pending_actions WHERE id = p_operation_id::uuid FOR UPDATE;
    IF NOT FOUND OR pending.run_id IS DISTINCT FROM parent.id OR pending.user_id IS DISTINCT FROM parent.user_id
       OR pending.agent_type IS DISTINCT FROM parent.agent_type OR pending.tool_name IS DISTINCT FROM p_tool_name THEN
      RAISE EXCEPTION 'Private result unavailable';
    END IF;
  END IF;
  SELECT * INTO agent FROM purama_ai.creator_agents WHERE id = substring(parent.agent_type FROM 8)::uuid FOR SHARE;
  IF NOT FOUND OR agent.user_id IS DISTINCT FROM parent.user_id THEN RAISE EXCEPTION 'Private result unavailable'; END IF;
  SELECT * INTO existing FROM purama_ai.karta_tool_results WHERE run_id = parent.id AND operation_id = p_operation_id FOR UPDATE;
  IF FOUND THEN
    IF existing.user_id IS DISTINCT FROM parent.user_id OR existing.creator_agent_id IS DISTINCT FROM agent.id
       OR existing.tool_name IS DISTINCT FROM p_tool_name OR existing.payload IS DISTINCT FROM p_payload THEN
      RAISE EXCEPTION 'Private result unavailable';
    END IF;
    RETURN existing.id;
  END IF;
  -- A terminal operation may reconcile an existing result, never create a new
  -- one. This also prevents recreation after an owner has deleted it.
  IF (is_direct AND (parent.status <> 'running' OR parent.duration_ms IS NOT NULL))
     OR (NOT is_direct AND pending.status <> 'executing')
     OR agent.is_active IS NOT TRUE OR agent.karta_enabled IS NOT TRUE
     OR NOT coalesce(p_tool_name = ANY(agent.tools_enabled),false) THEN RAISE EXCEPTION 'Private result unavailable'; END IF;
  INSERT INTO purama_ai.karta_tool_results(user_id,creator_agent_id,run_id,operation_id,tool_name,payload)
    VALUES(parent.user_id,agent.id,parent.id,p_operation_id,p_tool_name,p_payload) RETURNING id INTO result_id;
  RETURN result_id;
EXCEPTION WHEN OTHERS THEN
  -- Do not expose constraint values, query text or private payload in RPC errors.
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Private result unavailable';
END;
$$;

REVOKE ALL ON purama_ai.karta_tool_results FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,DELETE ON purama_ai.karta_tool_results TO authenticated;
GRANT SELECT ON purama_ai.karta_tool_results TO service_role;
REVOKE ALL ON FUNCTION purama_ai.karta_private_tool_result_valid(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION purama_ai.karta_store_tool_result(uuid,text,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION purama_ai.karta_store_tool_result(uuid,text,uuid,text,text,jsonb) TO service_role;

COMMENT ON TABLE purama_ai.karta_tool_results IS 'Owner-scoped server-origin product results; metadata-only logs and SMARANA remain separate. Owner may delete after operation completion. No automatic retention purge.';
COMMENT ON FUNCTION purama_ai.karta_store_tool_result(uuid,text,uuid,text,text,jsonb) IS 'Service-only immutable insert or identical JSONB reconciliation. Owner and custom agent are derived from the run and verified against caller assertions.';
COMMIT;
