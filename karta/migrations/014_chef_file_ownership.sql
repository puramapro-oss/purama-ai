-- PURAMA CHEF: explicit file ownership for write tasks.
BEGIN;

ALTER TABLE purama_ai.chef_tasks
  ADD COLUMN IF NOT EXISTS allowed_paths text[] NOT NULL DEFAULT '{}'::text[];

CREATE OR REPLACE FUNCTION purama_ai.chef_valid_allowed_paths(p_paths text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT cardinality(p_paths) BETWEEN 1 AND 256
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(p_paths) AS p(path)
      WHERE path IS NULL
        OR btrim(path) = ''
        OR path LIKE '/%'
        OR path LIKE '%\%'
        OR path = '..'
        OR path LIKE '../%'
        OR path LIKE '%/../%'
        OR path LIKE '%/..'
    );
$$;

ALTER TABLE purama_ai.chef_tasks
  DROP CONSTRAINT IF EXISTS chef_write_paths_required;
ALTER TABLE purama_ai.chef_tasks
  ADD CONSTRAINT chef_write_paths_required
  CHECK (
    access_mode = 'read'
    OR purama_ai.chef_valid_allowed_paths(allowed_paths)
  ) NOT VALID;

REVOKE ALL ON FUNCTION purama_ai.chef_valid_allowed_paths(text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_valid_allowed_paths(text[])
  TO service_role;

COMMIT;
