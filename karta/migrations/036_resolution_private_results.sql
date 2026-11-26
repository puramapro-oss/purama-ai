-- Add bounded, unverified resolution qualifications to the existing private results.
-- Apply after 034. Historical migrations, storage, RLS and store RPC are unchanged.
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
  snapshot jsonb;
  expected_rejected jsonb;
  resolution_as_of timestamptz;
  source_observed timestamptz;
  section_index integer;
  section_items integer;
  compact_padding integer;
  resolution_whitespace constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  resolution_instant_pattern constant text := '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?(Z|[+-](0[0-9]|1[0-3]):[0-5][0-9]|[+-]14:00)$';
BEGIN
  IF p_tool_name NOT IN ('knowledge_search','quantum_simulate','programmatic_report','qualify_resolution') OR p_tool_name IS NULL
     OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR octet_length(p_payload::text) > 65536 THEN RETURN false; END IF;
  allowed := ARRAY['schema_version','tool_name','status','summary','sources','details'];
  IF NOT (p_payload ?& allowed) OR p_payload - allowed <> '{}'::jsonb
     OR p_payload->'schema_version' IS DISTINCT FROM '1'::jsonb
     OR p_payload->>'tool_name' IS DISTINCT FROM p_tool_name
     OR p_payload->>'status' NOT IN ('complete','empty','partial','failed')
     OR jsonb_typeof(p_payload->'status') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_payload->'summary') IS DISTINCT FROM 'string'
     OR char_length(p_payload->>'summary') NOT BETWEEN 1 AND (CASE WHEN p_tool_name = 'programmatic_report' THEN 60000 ELSE 4000 END)
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
  IF p_tool_name = 'programmatic_report' THEN
    -- The text is model-generated, not provider evidence. Preserve every byte of
    -- the report; accepting a clipped or externally attributed report is forbidden.
    IF p_payload->>'status' IS DISTINCT FROM 'complete' OR p_payload->'sources' <> '[]'::jsonb
       OR d - 'read_tools' IS DISTINCT FROM '{"content_kind":"model_generated_report","verification_status":"unverified","source_text_trust":"untrusted_data","execution_mode":"programmatic_reads","report_truncated":false}'::jsonb
       OR jsonb_typeof(d->'read_tools') IS DISTINCT FROM 'array'
       -- PostgreSQL counts Unicode scalars; replace astral scalars with two
       -- ASCII units to enforce the same UTF-16 bound as the runtime and UI.
       OR char_length(regexp_replace(p_payload->>'summary', U&'[\+010000-\+10FFFF]', 'xx', 'g')) > 60000
       OR char_length(btrim(p_payload->>'summary', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) = 0 THEN RETURN false; END IF;
    IF jsonb_array_length(d->'read_tools') > 2
       OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(d->'read_tools')) <> jsonb_array_length(d->'read_tools')
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(d->'read_tools') AS read_tool(value)
         WHERE value NOT IN ('"knowledge_search"'::jsonb,'"web_search"'::jsonb)) THEN RETURN false; END IF;
    -- All remaining keys/values are now fixed ASCII tokens without spaces.
    -- Count their compact JSON plus the untouched JSON string and its key/comma.
    -- This matches the 61,440-byte application envelope; the common 65,536-byte
    -- JSONB guard above leaves room for PostgreSQL's formatting separators.
    IF octet_length(replace((p_payload - 'summary')::text,' ',''))
       + octet_length((p_payload->'summary')::text) + 11 > 61440 THEN RETURN false; END IF;
  ELSIF p_tool_name = 'qualify_resolution' THEN
    -- This contract delivers a complete qualification of a supplied snapshot,
    -- never a verified fact, permission, current case revision or completed goal.
    IF p_payload->>'status' IS DISTINCT FROM 'complete' OR p_payload->'sources' <> '[]'::jsonb
       OR d - ARRAY['snapshot','sections','supplied_references','rejected_source_ids'] IS DISTINCT FROM
         '{"content_kind":"resolution_qualification","verification_status":"unverified","source_text_trust":"untrusted_data","provenance":"caller_supplied_snapshot","qualification_only":true,"external_facts_verified":false,"permissions_granted":false,"external_actions_performed":0,"report_truncated":false}'::jsonb
       OR char_length(regexp_replace(p_payload->>'summary', U&'[\+010000-\+10FFFF]', 'xx', 'g')) > 4000
       OR char_length(btrim(p_payload->>'summary', resolution_whitespace)) = 0
       OR jsonb_typeof(d->'snapshot') IS DISTINCT FROM 'object'
       OR jsonb_typeof(d->'sections') IS DISTINCT FROM 'array'
       OR jsonb_typeof(d->'supplied_references') IS DISTINCT FROM 'array'
       OR jsonb_typeof(d->'rejected_source_ids') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    snapshot := d->'snapshot';
    allowed := ARRAY['caseId','snapshotRevision','asOf'];
    IF NOT (snapshot ?& allowed) OR snapshot - allowed <> '{}'::jsonb
       OR jsonb_typeof(snapshot->'caseId') IS DISTINCT FROM 'string'
       OR char_length(regexp_replace(snapshot->>'caseId', U&'[\+010000-\+10FFFF]', 'xx', 'g')) NOT BETWEEN 1 AND 160
       OR jsonb_typeof(snapshot->'snapshotRevision') IS DISTINCT FROM 'number'
       OR (snapshot->>'snapshotRevision') !~ '^[1-9][0-9]{0,6}$'
       OR (snapshot->>'snapshotRevision')::integer > 1000000
       OR jsonb_typeof(snapshot->'asOf') IS DISTINCT FROM 'string'
       OR (snapshot->>'asOf') !~ resolution_instant_pattern THEN RETURN false; END IF;
    -- PostgreSQL rejects invalid calendar dates; the pattern rejects rollover
    -- hours, leap seconds, missing offsets, and offsets beyond +/-14:00.
    resolution_as_of := (snapshot->>'asOf')::timestamptz;
    IF jsonb_array_length(d->'sections') <> 6
       OR jsonb_array_length(d->'supplied_references') > 128
       OR jsonb_array_length(d->'rejected_source_ids') > 128 THEN RETURN false; END IF;
    -- Fixed objects: envelope6, details13, snapshot3, six section5; plus the
    -- six-section array. Count JSONB formatting spaces, never spaces in text.
    compact_padding := 100;
    section_index := 0;
    section_items := 0;
    FOR item IN SELECT value FROM jsonb_array_elements(d->'sections') LOOP
      section_index := section_index + 1;
      allowed := ARRAY['id','title','availability','summary','items'];
      IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT (item ?& allowed) OR item - allowed <> '{}'::jsonb
         OR item->>'id' IS DISTINCT FROM (ARRAY['dependencies','transitions','effort','corrections','occurrence','handoffs'])[section_index]
         OR item->>'title' IS DISTINCT FROM (ARRAY['Prérequis','Transitions','Effort choisi','Conséquences d’une correction','Récurrence et reprises','Passation'])[section_index]
         OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string'
         OR jsonb_typeof(item->'availability') IS DISTINCT FROM 'string'
         OR item->>'availability' NOT IN ('provided','not_provided')
         OR jsonb_typeof(item->'summary') IS DISTINCT FROM 'string'
         OR char_length(regexp_replace(item->>'summary', U&'[\+010000-\+10FFFF]', 'xx', 'g')) NOT BETWEEN 1 AND 1000
         OR char_length(btrim(item->>'summary', resolution_whitespace)) = 0
         OR jsonb_typeof(item->'items') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      section_items := section_items + jsonb_array_length(item->'items');
      compact_padding := compact_padding + greatest(jsonb_array_length(item->'items') - 1, 0);
      IF section_items > 2048 OR (item->>'availability' = 'not_provided' AND
          (item->'items' <> '[]'::jsonb OR item->>'summary' IS DISTINCT FROM 'Aucune information fournie pour cette rubrique.'))
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(item->'items') AS detail(value)
           WHERE jsonb_typeof(value) <> 'string'
             OR char_length(regexp_replace(value #>> '{}', U&'[\+010000-\+10FFFF]', 'xx', 'g')) NOT BETWEEN 1 AND 8192
             OR char_length(btrim(value #>> '{}', resolution_whitespace)) = 0) THEN RETURN false; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value->'id') FROM jsonb_array_elements(d->'supplied_references'))
         <> jsonb_array_length(d->'supplied_references') THEN RETURN false; END IF;
    expected_rejected := '[]'::jsonb;
    FOR s IN SELECT value FROM jsonb_array_elements(d->'supplied_references') LOOP
      allowed := ARRAY['id','caseId','snapshotRevision','subjectId','kind','reference','observedAt'];
      IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR NOT (s ?& allowed) OR s - allowed <> '{}'::jsonb
         OR EXISTS (SELECT 1 FROM jsonb_each(s - 'snapshotRevision') WHERE jsonb_typeof(value) <> 'string')
         OR char_length(regexp_replace(s->>'id', U&'[\+010000-\+10FFFF]', 'xx', 'g')) NOT BETWEEN 1 AND 160
         OR char_length(regexp_replace(s->>'caseId', U&'[\+010000-\+10FFFF]', 'xx', 'g')) NOT BETWEEN 1 AND 160
         OR char_length(regexp_replace(s->>'subjectId', U&'[\+010000-\+10FFFF]', 'xx', 'g')) NOT BETWEEN 1 AND 160
         OR jsonb_typeof(s->'snapshotRevision') IS DISTINCT FROM 'number'
         OR (s->>'snapshotRevision') !~ '^[1-9][0-9]{0,6}$' OR (s->>'snapshotRevision')::integer > 1000000
         OR s->>'kind' NOT IN ('requirement','satisfaction','alternative','acceptance','activation','correction','transmission','responsibility','performance','authorization')
         OR char_length(regexp_replace(s->>'reference', U&'[\+010000-\+10FFFF]', 'xx', 'g')) NOT BETWEEN 1 AND 500
         OR char_length(regexp_replace(s->>'observedAt', U&'[\+010000-\+10FFFF]', 'xx', 'g')) NOT BETWEEN 20 AND 35 THEN RETURN false; END IF;
      -- Invalid observation dates remain visible as rejected supplied data.
      source_observed := NULL;
      IF (s->>'observedAt') ~ resolution_instant_pattern THEN
        BEGIN source_observed := (s->>'observedAt')::timestamptz;
        EXCEPTION WHEN OTHERS THEN source_observed := NULL;
        END;
      END IF;
      IF s->>'caseId' IS DISTINCT FROM snapshot->>'caseId'
         OR s->'snapshotRevision' IS DISTINCT FROM snapshot->'snapshotRevision'
         OR source_observed IS NULL OR source_observed > resolution_as_of
         OR char_length(btrim(s->>'reference', resolution_whitespace)) = 0 THEN
        expected_rejected := expected_rejected || jsonb_build_array(s->'id');
      END IF;
    END LOOP;
    IF d->'rejected_source_ids' IS DISTINCT FROM expected_rejected THEN RETURN false; END IF;
    compact_padding := compact_padding
      + greatest(jsonb_array_length(d->'supplied_references') - 1, 0) + 13 * jsonb_array_length(d->'supplied_references')
      + greatest(jsonb_array_length(d->'rejected_source_ids') - 1, 0);
    IF octet_length(p_payload::text) - compact_padding > 61440 THEN RETURN false; END IF;
  ELSIF p_tool_name = 'knowledge_search' THEN
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

-- Reapplication changes only the same validator and existing tool constraint.
ALTER TABLE purama_ai.karta_tool_results
  DROP CONSTRAINT karta_tool_results_tool_name_check;
ALTER TABLE purama_ai.karta_tool_results
  ADD CONSTRAINT karta_tool_results_tool_name_check
  CHECK (tool_name IN ('knowledge_search','quantum_simulate','programmatic_report','qualify_resolution'));

REVOKE ALL ON FUNCTION purama_ai.karta_private_tool_result_valid(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
