-- PURAMA CHEF: a critical requirement must be reviewed by a distinct task.
BEGIN;

CREATE OR REPLACE FUNCTION purama_ai.chef_missing_requirements(p_mission_id uuid)
RETURNS TABLE(requirement_id uuid, requirement_key text, description text, critical boolean)
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT r.id, r.requirement_key, r.description, r.critical
  FROM purama_ai.chef_requirements r
  WHERE r.mission_id = p_mission_id
    AND (
      (
        NOT r.critical
        AND NOT EXISTS (
          SELECT 1
          FROM purama_ai.chef_task_requirements tr
          JOIN purama_ai.chef_tasks t ON t.id = tr.task_id AND t.state = 'verified_done'
          JOIN purama_ai.chef_evidence e ON e.task_id = t.id
            AND e.requirement_id = r.id
            AND e.kind IN ('test','build','typecheck','lint','security','review','receipt','runtime')
          WHERE tr.requirement_id = r.id
        )
      )
      OR (
        r.critical
        AND NOT EXISTS (
          SELECT 1
          FROM purama_ai.chef_task_requirements proof_link
          JOIN purama_ai.chef_tasks proof_task
            ON proof_task.id = proof_link.task_id
           AND proof_task.state = 'verified_done'
          JOIN purama_ai.chef_evidence proof
            ON proof.task_id = proof_task.id
           AND proof.requirement_id = r.id
           AND proof.kind IN ('test','build','typecheck','lint','security','receipt','runtime')
          JOIN purama_ai.chef_task_requirements review_link
            ON review_link.requirement_id = r.id
          JOIN purama_ai.chef_tasks review_task
            ON review_task.id = review_link.task_id
           AND review_task.state = 'verified_done'
           AND review_task.id <> proof_task.id
          JOIN purama_ai.chef_evidence review
            ON review.task_id = review_task.id
           AND review.requirement_id = r.id
           AND review.kind = 'review'
          WHERE proof_link.requirement_id = r.id
        )
      )
    )
  ORDER BY r.requirement_key;
$$;

REVOKE ALL ON FUNCTION purama_ai.chef_missing_requirements(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.chef_missing_requirements(uuid)
  TO service_role;

COMMIT;
