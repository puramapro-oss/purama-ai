-- Preserve the bounded server-owned origin across an approval. Existing rows
-- remain NULL: a legacy action must never invent a new delegation root.
-- Apply before the matching runtime. No provider action runs in this migration.
BEGIN;

ALTER TABLE purama_ai.karta_pending_actions
  ADD COLUMN IF NOT EXISTS execution_trigger jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'purama_ai.karta_pending_actions'::regclass
      AND conname = 'karta_pending_actions_execution_trigger_shape'
  ) THEN
    ALTER TABLE purama_ai.karta_pending_actions
      ADD CONSTRAINT karta_pending_actions_execution_trigger_shape CHECK (
        execution_trigger IS NULL OR (
          jsonb_typeof(execution_trigger) = 'object'
          AND octet_length(execution_trigger::text) <= 16384
        )
      );
  END IF;
END;
$$;

COMMENT ON COLUMN purama_ai.karta_pending_actions.execution_trigger IS
  'Server-owned minimal original trigger: bounded type/source and optional delegation reason/lineage. Never arbitrary payload or nested approval-resume; runtime validates on write and restore. NULL is legacy unknown origin.';

-- Existing owner-scoped SELECT policy and service-only writes remain in force.
-- The claim RPC returns SETOF this table, so the new field is included without
-- replacing its lock/claim contract or granting a new client capability.
COMMIT;
