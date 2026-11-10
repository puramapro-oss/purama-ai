-- Apply before deploying the matching contracts-ots-stamp handler.
-- Existing handlers do not set the function-local marker, so their separate
-- audit INSERT remains unchanged during rollout (and on handler rollback).
-- The marker selects the new atomic path; it is not an authorization boundary.

CREATE OR REPLACE FUNCTION purama_ai.audit_atomic_contract_ots_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor uuid;
    v_actor_type text;
BEGIN
    IF pg_catalog.current_setting('purama_ai.atomic_ots_stamp', true) IS DISTINCT FROM 'on' THEN
        RETURN NEW;
    END IF;

    IF auth.role() = 'service_role' THEN
        v_actor := NULL;
        v_actor_type := 'service';
    ELSIF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
        v_actor := auth.uid();
        v_actor_type := 'user';
    ELSE
        RAISE EXCEPTION 'Authenticated stamp actor required' USING ERRCODE = '42501';
    END IF;

    INSERT INTO purama_ai.contract_events
        (contract_id, event_type, payload, actor_id, actor_type)
    VALUES
        (NEW.id, 'ots_stamped',
         pg_catalog.jsonb_build_object('hash', NEW.ots_stamp_hash,
             'proof_size', pg_catalog.octet_length(pg_catalog.decode(NEW.ots_proof, 'base64'))),
         v_actor, v_actor_type);
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.audit_atomic_contract_ots_stamp()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS contract_ots_stamp_atomic_audit ON purama_ai.contracts;
CREATE TRIGGER contract_ots_stamp_atomic_audit
    AFTER UPDATE OF ots_stamp_hash, ots_proof ON purama_ai.contracts
    FOR EACH ROW EXECUTE FUNCTION purama_ai.audit_atomic_contract_ots_stamp();

CREATE OR REPLACE FUNCTION purama_ai.persist_contract_ots_stamp(
    p_contract_id uuid,
    p_user_id uuid,
    p_submission_id bigint,
    p_previous_hash text,
    p_previous_proof text,
    p_hash text,
    p_proof text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET purama_ai.atomic_ots_stamp = 'on'
AS $$
DECLARE
    v_written uuid;
    v_proof_size integer;
BEGIN
    -- Match ots-core.ts's 64,000-byte proof boundary. Cryptographic proof
    -- construction/validation remains in the existing OTS implementation.
    IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$'
       OR p_proof IS NULL OR pg_catalog.length(p_proof) = 0
       OR pg_catalog.length(p_proof) > 85336
       OR pg_catalog.length(p_proof) % 4 <> 0
       OR p_proof !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN
        RAISE EXCEPTION 'Invalid stamp payload' USING ERRCODE = '22023';
    END IF;
    v_proof_size := pg_catalog.octet_length(pg_catalog.decode(p_proof, 'base64'));
    IF v_proof_size < 1 OR v_proof_size > 64000 THEN
        RAISE EXCEPTION 'Invalid stamp payload' USING ERRCODE = '22023';
    END IF;

    -- The invoker still needs the existing table grants and UPDATE RLS policy.
    -- Keep every original snapshot condition; competing/stale updates return
    -- NULL and generate no event. Clearing confirmations preserves restamping.
    UPDATE purama_ai.contracts
       SET ots_stamp_hash = p_hash,
           ots_proof = p_proof,
           ots_verified_at = NULL,
           ots_block_height = NULL,
           ots_btc_timestamp = NULL
     WHERE id = p_contract_id
       AND user_id = p_user_id
       AND status = 'signed'::purama_ai.contract_status
       AND docuseal_submission_id IS NOT DISTINCT FROM p_submission_id
       AND ots_stamp_hash IS NOT DISTINCT FROM p_previous_hash
       AND ots_proof IS NOT DISTINCT FROM p_previous_proof
     RETURNING id INTO v_written;
    RETURN v_written;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.persist_contract_ots_stamp(uuid, uuid, bigint, text, text, text, text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION purama_ai.persist_contract_ots_stamp(uuid, uuid, bigint, text, text, text, text)
    TO authenticated, service_role;

COMMENT ON FUNCTION purama_ai.persist_contract_ots_stamp(uuid, uuid, bigint, text, text, text, text)
    IS 'Atomic OTS stamp plus audit; preserves invoker RLS, snapshot conditions and JWT actor. Deploy migration before edge handler.';
