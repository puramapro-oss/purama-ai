-- Native Responses / generateContent receipts extend the existing run log and
-- consultation ledger. Apply after 032 and 033, before enabling native routes.
-- No provider call, invoice estimate, new ledger, grant or historical rewrite.
BEGIN;

CREATE OR REPLACE FUNCTION purama_ai.karta_valid_model_usage_receipt(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog AS $$
DECLARE key text; v jsonb;
  fields text[] := ARRAY['version','apiFormat','routeKind','requestedModel','responseModel','responseId','inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','cacheCreation5mInputTokens','cacheCreation1hInputTokens'];
  counters text[] := ARRAY['inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','cacheCreation5mInputTokens','cacheCreation1hInputTokens'];
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR pg_column_size(value)>4096 THEN RETURN false; END IF;
  IF value->'version' = '1'::jsonb THEN
    IF value->>'apiFormat' IS DISTINCT FROM 'anthropic_messages'
      OR (value->>'routeKind' IN ('anthropic','compatible')) IS NOT TRUE THEN RETURN false; END IF;
  ELSIF value->'version' = '3'::jsonb THEN
    IF (value->>'routeKind' IN ('openai','xai','google')) IS NOT TRUE
      OR value->>'apiFormat' IS DISTINCT FROM (CASE value->>'routeKind'
        WHEN 'openai' THEN 'openai_responses' WHEN 'xai' THEN 'xai_responses'
        WHEN 'google' THEN 'gemini_generate_content' END) THEN RETURN false; END IF;
    fields := fields || ARRAY['reasoningOutputTokens','toolUseInputTokens','totalTokens'];
    counters := counters || ARRAY['reasoningOutputTokens','toolUseInputTokens','totalTokens'];
    -- These native endpoints do not report Anthropic cache creation buckets.
    IF value->'cacheCreationInputTokens' IS DISTINCT FROM 'null'::jsonb
      OR value->'cacheCreation5mInputTokens' IS DISTINCT FROM 'null'::jsonb
      OR value->'cacheCreation1hInputTokens' IS DISTINCT FROM 'null'::jsonb
      OR (value->>'routeKind'<>'google' AND value->'toolUseInputTokens' IS DISTINCT FROM 'null'::jsonb) THEN RETURN false; END IF;
  ELSE RETURN false;
  END IF;
  IF NOT value ?& fields OR value - fields <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['requestedModel','responseModel','responseId'] LOOP
    v := value->key;
    IF v<>'null'::jsonb AND (jsonb_typeof(v)<>'string' OR length(value->>key) NOT BETWEEN 1 AND 200
      OR value->>key !~ '^[A-Za-z0-9]' OR value->>key ~ '[^A-Za-z0-9_.:/-]') THEN RETURN false; END IF;
  END LOOP;
  FOREACH key IN ARRAY counters LOOP
    v := value->key;
    IF v<>'null'::jsonb THEN
      IF jsonb_typeof(v)<>'number' THEN RETURN false; END IF;
      IF (value->>key)::numeric NOT BETWEEN 0 AND 9007199254740991
        OR (value->>key)::numeric <> trunc((value->>key)::numeric) THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END; $$;

-- The existing v2 envelope still requires routeKind='anthropic' for each child;
-- none of the native v3 variants can enter a hosted programmatic chain.
COMMENT ON COLUMN purama_ai.karta_runs.model_usage IS
  'Immutable provider metadata: v1 Anthropic-compatible response; v2 bounded Anthropic PTC chain; v3 native OpenAI/xAI Responses or Gemini generateContent. NULL is unknown. Native cache reads are input subsets; reasoning inclusion is provider-specific. Not a reconciled invoice.';

CREATE OR REPLACE FUNCTION purama_ai.model_consultation_valid_usage(u jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT purama_ai.karta_valid_model_usage_receipt(u);
$$;

CREATE OR REPLACE FUNCTION purama_ai.model_consultation_settle(p_user_id uuid,p_operation_id text,p_generation uuid,p_receipt jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE o purama_ai.model_consultations%ROWTYPE; c purama_ai.model_consultation_calls%ROWTYPE; u jsonb;
BEGIN
  SELECT * INTO o FROM purama_ai.model_consultations WHERE user_id=p_user_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR o.generation IS DISTINCT FROM p_generation THEN RETURN false; END IF;
  IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR pg_column_size(p_receipt)>8192
    OR NOT p_receipt ?& ARRAY['call','status','usage'] OR p_receipt - ARRAY['call','status','usage']<>'{}'::jsonb
    OR p_receipt->>'status' IS NULL OR p_receipt->>'status' NOT IN ('completed','uncertain','blocked')
    OR jsonb_typeof(p_receipt->'usage') IS DISTINCT FROM 'array' OR jsonb_array_length(p_receipt->'usage')>1 THEN RAISE EXCEPTION 'Invalid consultation receipt'; END IF;
  SELECT * INTO c FROM purama_ai.model_consultation_calls WHERE operation_pk=o.id AND call_id=p_receipt->'call'->>'callId' FOR UPDATE;
  IF NOT FOUND THEN
    -- A denied reserve generated no dispatch. It must never manufacture usage.
    IF p_receipt->>'status'='blocked' AND p_receipt->'usage'='[]'::jsonb THEN RETURN true; END IF;
    RAISE EXCEPTION 'Consultation receipt has no reservation';
  END IF;
  IF c.generation<>p_generation OR c.call_spec IS DISTINCT FROM p_receipt->'call' THEN RAISE EXCEPTION USING ERRCODE='PCO01',MESSAGE='Consultation receipt identity conflict'; END IF;
  IF c.receipt IS NOT NULL THEN
    IF c.receipt<>p_receipt THEN RAISE EXCEPTION USING ERRCODE='PCO01',MESSAGE='Consultation receipt conflict'; END IF;
    RETURN true;
  END IF;
  IF p_receipt->>'status'='blocked' AND p_receipt->'usage'<>'[]'::jsonb THEN RAISE EXCEPTION 'Blocked call cannot report usage'; END IF;
  FOR u IN SELECT value FROM jsonb_array_elements(p_receipt->'usage') LOOP
    IF NOT purama_ai.model_consultation_valid_usage(u) OR u->>'requestedModel' IS DISTINCT FROM c.call_spec->>'model'
      OR (u->'version'='3'::jsonb AND u->>'routeKind' IS DISTINCT FROM c.call_spec->>'provider')
      OR (u->'version'='1'::jsonb AND c.call_spec->>'provider' IN ('openai','xai','google')) THEN RAISE EXCEPTION 'Invalid provider usage receipt'; END IF;
  END LOOP;
  UPDATE purama_ai.model_consultation_calls SET state=p_receipt->>'status',receipt=p_receipt,settled_at=now() WHERE operation_pk=o.id AND call_id=c.call_id;
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION purama_ai.model_consultation_observe(p_user_id uuid,p_operation_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE o purama_ai.model_consultations%ROWTYPE; c purama_ai.model_consultation_calls%ROWTYPE; u jsonb;
  input_total numeric:=0; output_total numeric:=0; cached_total numeric:=0;
  tokens_known boolean:=true; cached_known boolean:=true; any_dispatch boolean:=false; key text;
  call_input numeric; call_output numeric;
BEGIN
  SELECT * INTO o FROM purama_ai.model_consultations WHERE user_id=p_user_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  FOR c IN SELECT * FROM purama_ai.model_consultation_calls WHERE operation_pk=o.id LOOP
    IF c.state='blocked' THEN CONTINUE; END IF;
    any_dispatch:=true;
    IF c.call_spec->>'kind' IN ('search','scrape') THEN CONTINUE; END IF;
    u:=c.receipt->'usage'->0;
    IF u IS NULL THEN tokens_known:=false; CONTINUE; END IF;
    IF u->'version'='1'::jsonb THEN
      -- Preserve v1: Anthropic input excludes separately reported cache reads
      -- and creation; cache creation TTL buckets are subsets, never added twice.
      IF u->>'inputTokens' IS NULL OR u->>'outputTokens' IS NULL OR u->>'cacheReadInputTokens' IS NULL OR u->>'cacheCreationInputTokens' IS NULL THEN
        tokens_known:=false; CONTINUE;
      END IF;
      call_input:=(u->>'inputTokens')::numeric+(u->>'cacheReadInputTokens')::numeric+(u->>'cacheCreationInputTokens')::numeric;
      call_output:=(u->>'outputTokens')::numeric;
    ELSIF u->'version'='3'::jsonb THEN
      -- Native inputs already include cached tokens. Only documented disjoint,
      -- explicitly observed counters are combined for the existing ledger.
      call_input:=(u->>'inputTokens')::numeric;
      call_output:=(u->>'outputTokens')::numeric;
      IF u->>'routeKind'='xai' THEN
        call_output:=call_output+(u->>'reasoningOutputTokens')::numeric;
      ELSIF u->>'routeKind'='google' THEN
        call_input:=call_input+(u->>'toolUseInputTokens')::numeric;
        call_output:=call_output+(u->>'reasoningOutputTokens')::numeric;
      END IF;
      -- Do not infer omitted detail as zero or repair contradictory raw usage.
      -- A total supplied by the provider is a cross-check, never a replacement
      -- for missing accounting dimensions. Uncertain tokens remain reserved.
      IF call_input IS NULL OR call_output IS NULL
        OR (u->>'cacheReadInputTokens')::numeric>(u->>'inputTokens')::numeric
        OR (u->>'routeKind'='openai' AND (u->>'reasoningOutputTokens')::numeric>call_output)
        OR (u->>'totalTokens' IS NOT NULL AND (u->>'totalTokens')::numeric<>call_input+call_output) THEN
        tokens_known:=false; CONTINUE;
      END IF;
    ELSE tokens_known:=false; CONTINUE;
    END IF;
    input_total:=input_total+call_input;
    output_total:=output_total+call_output;
    IF u->>'cacheReadInputTokens' IS NULL THEN cached_known:=false;
    ELSE cached_total:=cached_total+(u->>'cacheReadInputTokens')::numeric; END IF;
  END LOOP;
  IF input_total+output_total>9007199254740991 OR cached_total>9007199254740991 THEN RAISE EXCEPTION 'Consultation totals exceed safe range'; END IF;
  key:='observed:'||encode(sha256(convert_to(jsonb_build_array(CASE WHEN tokens_known THEN input_total ELSE NULL END,CASE WHEN tokens_known THEN output_total ELSE NULL END,CASE WHEN tokens_known AND cached_known THEN cached_total ELSE NULL END,CASE WHEN any_dispatch THEN NULL ELSE 0 END)::text,'UTF8')),'hex');
  RETURN purama_ai.model_consultation_reconcile(p_user_id,p_operation_id,key,
    CASE WHEN tokens_known THEN input_total::bigint ELSE NULL END,CASE WHEN tokens_known THEN output_total::bigint ELSE NULL END,
    CASE WHEN tokens_known AND cached_known THEN cached_total::bigint ELSE NULL END,CASE WHEN any_dispatch THEN NULL ELSE 0 END);
END; $$;

-- CREATE OR REPLACE preserves the existing service-only consultation ACLs and
-- the shared run validator's privileges. Reservation/admission RPCs and all RLS
-- policies are unchanged; costs still need the existing reconciliation path.
COMMIT;
