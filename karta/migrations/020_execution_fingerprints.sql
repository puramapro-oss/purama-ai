-- Durable delivery identity: keep the existing unique execution_key claim and
-- bind new claims to a canonical request fingerprint. No request body is logged.
-- Rollout: stop/drain old workers, apply this migration, then start v2 workers.
-- Old rows remain readable; absence of a fingerprint is never proof of equality.

ALTER TABLE purama_ai.karta_runs
  ADD COLUMN IF NOT EXISTS execution_fingerprint TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'purama_ai.karta_runs'::regclass
      AND conname = 'karta_runs_execution_fingerprint_format'
  ) THEN
    ALTER TABLE purama_ai.karta_runs
      ADD CONSTRAINT karta_runs_execution_fingerprint_format
      CHECK (execution_fingerprint IS NULL
        OR (execution_key IS NOT NULL AND execution_fingerprint ~ '^[0-9a-f]{64}$'));
  END IF;
END;
$$;
