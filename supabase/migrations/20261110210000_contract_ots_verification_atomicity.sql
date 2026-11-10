-- Deploy before the matching contracts-ots-verify Edge function.
-- Only the service-side cryptographic verifier may assert a confirmation.
-- Human authorization and a fresh RLS read stay in the Edge function; this RPC
-- deliberately grants no authenticated/anonymous access to proof mutation.
CREATE OR REPLACE FUNCTION purama_ai.persist_contract_ots_verification(
  p_contract_id uuid,
  p_user_id uuid,
  p_status purama_ai.contract_status,
  p_submission_id bigint,
  p_previous_hash text,
  p_previous_proof text,
  p_previous_verified_at timestamptz,
  p_previous_block_height bigint,
  p_previous_btc_timestamp timestamptz,
  p_proof text,
  p_block_height bigint,
  p_btc_timestamp timestamptz,
  p_actor_id uuid,
  p_actor_type text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  observed purama_ai.contracts%ROWTYPE;
BEGIN
  IF p_actor_type IS NULL
     OR p_actor_type NOT IN ('user', 'system')
     OR (p_actor_type = 'user' AND p_actor_id IS NULL)
     OR (p_actor_type = 'system' AND p_actor_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid verification actor' USING ERRCODE = '22023';
  END IF;
  IF p_block_height IS NULL OR p_block_height < 0 OR p_block_height > 9007199254740991
     OR p_btc_timestamp IS NULL OR NOT pg_catalog.isfinite(p_btc_timestamp)
     OR p_btc_timestamp <= '1970-01-01 00:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'Invalid Bitcoin confirmation' USING ERRCODE = '22023';
  END IF;
  IF p_proof IS NULL OR pg_catalog.length(p_proof) = 0 OR pg_catalog.length(p_proof) > 85336
     OR pg_catalog.length(p_proof) % 4 <> 0
     OR p_proof !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN
    RAISE EXCEPTION 'Invalid OTS proof' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.octet_length(pg_catalog.decode(p_proof, 'base64')) NOT BETWEEN 1 AND 64000 THEN
    RAISE EXCEPTION 'Invalid OTS proof size' USING ERRCODE = '22023';
  END IF;

  -- Lock the exact snapshot, including an existing confirmation. PostgreSQL
  -- rechecks these predicates after a competing writer releases its row lock.
  SELECT c.* INTO observed
  FROM purama_ai.contracts AS c
  WHERE c.id = p_contract_id AND c.user_id = p_user_id AND c.status = p_status
    AND c.docuseal_submission_id IS NOT DISTINCT FROM p_submission_id
    AND c.ots_stamp_hash IS NOT DISTINCT FROM p_previous_hash
    AND c.ots_proof IS NOT DISTINCT FROM p_previous_proof
    AND c.ots_verified_at IS NOT DISTINCT FROM p_previous_verified_at
    AND c.ots_block_height IS NOT DISTINCT FROM p_previous_block_height
    AND c.ots_btc_timestamp IS NOT DISTINCT FROM p_previous_btc_timestamp
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF observed.ots_verified_at IS NOT NULL
     AND observed.ots_proof IS NOT DISTINCT FROM p_proof
     AND observed.ots_block_height IS NOT DISTINCT FROM p_block_height
     AND observed.ots_btc_timestamp IS NOT DISTINCT FROM p_btc_timestamp THEN
    RETURN observed.id;
  END IF;

  UPDATE purama_ai.contracts
  SET ots_proof = p_proof, ots_verified_at = pg_catalog.clock_timestamp(),
      ots_block_height = p_block_height, ots_btc_timestamp = p_btc_timestamp
  WHERE id = observed.id;

  INSERT INTO purama_ai.contract_events(contract_id, event_type, payload, actor_id, actor_type)
  VALUES (observed.id, 'ots_verified',
          pg_catalog.jsonb_build_object('block_height', p_block_height, 'btc_timestamp', p_btc_timestamp),
          p_actor_id, p_actor_type);
  RETURN observed.id;
END;
$function$;

REVOKE ALL ON FUNCTION purama_ai.persist_contract_ots_verification(
  uuid, uuid, purama_ai.contract_status, bigint, text, text, timestamptz, bigint, timestamptz,
  text, bigint, timestamptz, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.persist_contract_ots_verification(
  uuid, uuid, purama_ai.contract_status, bigint, text, text, timestamptz, bigint, timestamptz,
  text, bigint, timestamptz, uuid, text
) TO service_role;
