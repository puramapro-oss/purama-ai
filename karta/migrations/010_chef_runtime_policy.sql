-- PURAMA CHEF runtime policy: every task is verifiable and every writer is scoped.
BEGIN;

ALTER TABLE purama_ai.chef_tasks
  ADD COLUMN IF NOT EXISTS verification_profiles text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE purama_ai.chef_tasks
  DROP CONSTRAINT IF EXISTS chef_task_verification_profiles_required;
ALTER TABLE purama_ai.chef_tasks
  ADD CONSTRAINT chef_task_verification_profiles_required
  CHECK (cardinality(verification_profiles) BETWEEN 1 AND 32) NOT VALID;

ALTER TABLE purama_ai.chef_tasks
  DROP CONSTRAINT IF EXISTS chef_write_task_scope_required;
ALTER TABLE purama_ai.chef_tasks
  ADD CONSTRAINT chef_write_task_scope_required
  CHECK (
    access_mode = 'read'
    OR NULLIF(btrim(worktree), '') IS NOT NULL
    OR NULLIF(btrim(scope_key), '') IS NOT NULL
  ) NOT VALID;

COMMIT;
