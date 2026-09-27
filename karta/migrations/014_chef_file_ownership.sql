-- PURAMA CHEF: explicit file ownership for write tasks.
BEGIN;

ALTER TABLE purama_ai.chef_tasks
  ADD COLUMN IF NOT EXISTS allowed_paths text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE purama_ai.chef_tasks
  DROP CONSTRAINT IF EXISTS chef_write_paths_required;
ALTER TABLE purama_ai.chef_tasks
  ADD CONSTRAINT chef_write_paths_required
  CHECK (
    access_mode = 'read'
    OR (
      cardinality(allowed_paths) BETWEEN 1 AND 256
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(allowed_paths) AS p(path)
        WHERE path IS NULL
          OR btrim(path) = ''
          OR path LIKE '/%'
          OR path LIKE '%\\%'
          OR path = '..'
          OR path LIKE '../%'
          OR path LIKE '%/../%'
          OR path LIKE '%/..'
      )
    )
  ) NOT VALID;

COMMIT;
