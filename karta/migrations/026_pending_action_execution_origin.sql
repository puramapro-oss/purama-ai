-- Canonical addition after PR33 migrations 021--025, which remain unchanged.
-- Reconciles Aether a40fbd1's 021 origin without importing its alternate budget SQL.
-- Drain old workers before deploying the matching runtime. Historical NULL stays unknown.
BEGIN;

DO $$
DECLARE
  pending_table oid;
  pending_row_type oid;
  origin_column record;
  origin_constraint record;
  created_column boolean := false;
  expected_expression text;
BEGIN
  SELECT c.oid, c.reltype INTO pending_table, pending_row_type
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'purama_ai' AND c.relname = 'karta_pending_actions'
    AND c.relkind = 'r' AND c.relrowsecurity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KARTA migration 026: protected pending action table prerequisite is missing';
  END IF;
  -- A claim must retain the owned table-row contract; this migration never
  -- replaces its permissions, locks, admission guards or SETOF return type.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = pg_catalog.to_regprocedure('purama_ai.karta_claim_pending_action(uuid,text)')
      AND p.proretset AND p.prorettype = pending_row_type
  ) THEN
    RAISE EXCEPTION 'KARTA migration 026: pending action SETOF claim prerequisite is missing';
  END IF;

  LOCK TABLE purama_ai.karta_pending_actions IN ACCESS EXCLUSIVE MODE;
  SELECT a.* INTO origin_column FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = pending_table AND a.attname = 'execution_trigger' AND NOT a.attisdropped;
  IF FOUND THEN
    IF origin_column.atttypid <> 'jsonb'::pg_catalog.regtype
       OR origin_column.attnotnull OR origin_column.atthasdef
       OR origin_column.attgenerated <> '' OR origin_column.attidentity <> '' THEN
      RAISE EXCEPTION 'KARTA migration 026: unknown execution_trigger column contract';
    END IF;
  ELSE
    ALTER TABLE purama_ai.karta_pending_actions ADD COLUMN execution_trigger jsonb;
    created_column := true;
    SELECT a.* INTO origin_column FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = pending_table AND a.attname = 'execution_trigger' AND NOT a.attisdropped;
  END IF;

  SELECT c.* INTO origin_constraint FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = pending_table AND c.conname = 'karta_pending_actions_execution_trigger_shape';
  IF NOT FOUND THEN
    IF NOT created_column THEN
      RAISE EXCEPTION 'KARTA migration 026: existing execution_trigger has no recognized shape constraint';
    END IF;
    ALTER TABLE purama_ai.karta_pending_actions
      ADD CONSTRAINT karta_pending_actions_execution_trigger_shape CHECK (
        execution_trigger IS NULL OR (
          jsonb_typeof(execution_trigger) = 'object'
          AND octet_length(execution_trigger::text) <= 16384
        )
      );
    SELECT c.* INTO origin_constraint FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = pending_table AND c.conname = 'karta_pending_actions_execution_trigger_shape';
  END IF;
  IF origin_constraint.contype <> 'c' OR NOT origin_constraint.convalidated
     OR origin_constraint.connoinherit
     OR origin_constraint.conkey IS DISTINCT FROM ARRAY[origin_column.attnum]::smallint[]
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = pending_table AND c.oid <> origin_constraint.oid
         AND origin_column.attnum = ANY(c.conkey)
     ) THEN
    RAISE EXCEPTION 'KARTA migration 026: unknown execution_trigger constraint contract';
  END IF;

  -- Let this PostgreSQL version parse/deparse both expressions. This recognizes
  -- the exact Aether shape without guessing text formatting or changing its data.
  CREATE TEMP TABLE karta_origin_expected_shape_026 (
    execution_trigger jsonb CHECK (
      execution_trigger IS NULL OR (
        jsonb_typeof(execution_trigger) = 'object'
        AND octet_length(execution_trigger::text) <= 16384
      )
    )
  ) ON COMMIT DROP;
  SELECT pg_catalog.pg_get_expr(c.conbin, c.conrelid, false) INTO expected_expression
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'pg_temp.karta_origin_expected_shape_026'::pg_catalog.regclass
    AND c.contype = 'c';
  IF pg_catalog.pg_get_expr(origin_constraint.conbin, origin_constraint.conrelid, false)
       IS DISTINCT FROM expected_expression THEN
    RAISE EXCEPTION 'KARTA migration 026: execution_trigger shape differs from the known origin protocol';
  END IF;
END;
$$;

COMMENT ON COLUMN purama_ai.karta_pending_actions.execution_trigger IS
  'Server-owned minimal original trigger: bounded type/source and optional delegation reason/lineage. Never arbitrary payload or nested approval-resume; runtime validates on write and restore. NULL is legacy unknown origin.';

-- Existing owner-scoped SELECT policy and service-only writes are unchanged.
-- No backfill, provider action, new grant or alternate budget protocol is introduced.
COMMIT;
